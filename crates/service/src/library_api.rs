//! The family library over HTTP (F1): `jackbird-store` as a root the interface opens like any
//! other (listeners read and play; editors save, rename, delete and upload), importing a folder of
//! the machine in the background (owners), uploads streamed to disk and moved in, and songs leaving
//! with the family's tags, with byte ranges, streamed.

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use jackbird_api::{EntryJson, InspectionJson, Metadata, StatJson, edit_for};
use jackbird_core::Error;
use jackbird_store::{Imported, Library, Outgoing, Report};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use crate::people::Person;
use crate::{Answer, ApiError, Service, blocking};

type Shared = State<Arc<Service>>;

fn library(service: &Service) -> Answer<Arc<Library>> {
    service
        .library
        .clone()
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no-library", "this service has no library"))
}

#[derive(Deserialize)]
struct At {
    #[serde(default)]
    path: String,
}

async fn info(State(service): Shared) -> Answer<Json<Value>> {
    let library = library(&service)?;
    let songs = blocking(move || library.songs()).await?.len();
    Ok(Json(json!({ "name": "Library", "songs": songs })))
}

async fn walk(State(service): Shared) -> Answer<Json<Vec<EntryJson>>> {
    let library = library(&service)?;
    let entries = blocking(move || library.walk()).await?;
    Ok(Json(entries.into_iter().map(Into::into).collect()))
}

async fn list(State(service): Shared, Query(at): Query<At>) -> Answer<Json<Vec<EntryJson>>> {
    let library = library(&service)?;
    let entries = blocking(move || library.list(&at.path)).await?;
    Ok(Json(entries.into_iter().map(Into::into).collect()))
}

async fn read(State(service): Shared, Query(at): Query<At>) -> Answer<Response> {
    let library = library(&service)?;
    let bytes = blocking(move || library.read(&at.path)).await?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response())
}

async fn stat(State(service): Shared, Query(at): Query<At>) -> Answer<Json<Option<StatJson>>> {
    let library = library(&service)?;
    let stat = blocking(move || library.stat(&at.path)).await?;
    Ok(Json(stat.map(Into::into)))
}

#[derive(Deserialize)]
struct Inspect {
    path: String,
    known: Option<String>,
}

async fn inspect(State(service): Shared, Json(body): Json<Inspect>) -> Answer<Json<InspectionJson>> {
    let library = library(&service)?;
    let found = blocking(move || library.inspect(&body.path, body.known.as_deref())).await?;
    Ok(Json(found.into()))
}

async fn suggestions(State(service): Shared, Query(at): Query<At>) -> Answer<Json<Value>> {
    let library = library(&service)?;
    let found = blocking(move || library.suggestions(&at.path)).await?;
    Ok(Json(json!(found)))
}

/// The one range a request asks for (`bytes=a-b`, `bytes=a-`, `bytes=-n`), within `len`.
fn range_of(headers: &HeaderMap, len: u64) -> Option<(u64, u64)> {
    let spec = headers.get(header::RANGE)?.to_str().ok()?.strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            (len.saturating_sub(n), len)
        }
        (start, "") => (start.parse().ok()?, len),
        (start, end) => (start.parse().ok()?, end.parse::<u64>().ok()?.saturating_add(1).min(len)),
    };
    (start < end).then_some((start, end))
}

/// A song as it leaves: its head, then its blob, streamed; a range when one is asked for.
async fn send(out: Outgoing, headers: &HeaderMap, download: bool) -> Answer<Response> {
    let len = out.len();
    let wanted = headers.contains_key(header::RANGE);
    let (start, end) = match range_of(headers, len) {
        Some(range) => range,
        None if wanted => {
            return Ok((
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(header::CONTENT_RANGE, format!("bytes */{len}"))],
            )
                .into_response());
        }
        None => (0, len),
    };
    let head_len = out.head.len() as u64;
    let head: Vec<u8> = if start < head_len {
        out.head[start as usize..end.min(head_len) as usize].to_vec()
    } else {
        Vec::new()
    };
    let mut file = tokio::fs::File::open(&out.blob)
        .await
        .map_err(|error| ApiError::from(Error::Io(error.to_string())))?;
    let from = out.from + start.max(head_len) - head_len;
    let rest = end.saturating_sub(start.max(head_len));
    use tokio::io::AsyncSeekExt;
    file.seek(std::io::SeekFrom::Start(from))
        .await
        .map_err(|error| ApiError::from(Error::Io(error.to_string())))?;
    let reader = std::io::Cursor::new(head).chain(file.take(rest));
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(reader));
    let mut response = Response::new(body);
    let answer = response.headers_mut();
    answer.insert(header::CONTENT_TYPE, HeaderValue::from_static(out.mime));
    answer.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    answer.insert(header::CONTENT_LENGTH, HeaderValue::from(end - start));
    if download {
        let name: String = out
            .name
            .chars()
            .map(|c| {
                if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let encoded: String = out
            .name
            .bytes()
            .map(|byte| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' => (byte as char).to_string(),
                _ => format!("%{byte:02X}"),
            })
            .collect();
        if let Ok(value) =
            HeaderValue::from_str(&format!("attachment; filename=\"{name}\"; filename*=UTF-8''{encoded}"))
        {
            answer.insert(header::CONTENT_DISPOSITION, value);
        }
    }
    if wanted {
        answer.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{}/{len}", end - 1)).expect("ascii"),
        );
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    }
    Ok(response)
}

async fn media(State(service): Shared, Query(at): Query<At>, request: Request) -> Answer<Response> {
    let library = library(&service)?;
    let out = blocking(move || library.outgoing(&at.path)).await?;
    send(out, request.headers(), false).await
}

async fn download(State(service): Shared, Query(at): Query<At>, request: Request) -> Answer<Response> {
    let library = library(&service)?;
    let out = blocking(move || library.outgoing(&at.path)).await?;
    send(out, request.headers(), true).await
}

/// Routes of everyone with a place (listeners and up).
pub fn listeners() -> Router<Arc<Service>> {
    Router::new()
        .route("/library", get(info))
        .route("/library/walk", get(walk))
        .route("/library/list", get(list))
        .route("/library/read", get(read))
        .route("/library/stat", get(stat))
        .route("/library/inspect", post(inspect))
        .route("/library/suggestions", get(suggestions))
        .route("/library/media", get(media))
        .route("/library/download", get(download))
        .route("/library/import", get(import_state))
}

// ---------------------------------------------------------------------------------------------
// Editors: saves, the library's places, small files, uploads.

async fn write(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
    body: axum::body::Bytes,
) -> Answer<StatusCode> {
    let library = library(&service)?;
    let path = at.path.clone();
    blocking(move || library.write(&path, &body)).await?;
    if !at.path.starts_with(".meta/") {
        service.store.log(&person.name, "write", "Library", &at.path);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn delete(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
) -> Answer<StatusCode> {
    let library = library(&service)?;
    let path = at.path.clone();
    blocking(move || library.delete(&path)).await?;
    service.store.log(&person.name, "delete", "Library", &at.path);
    Ok(StatusCode::NO_CONTENT)
}

async fn mkdir(State(service): Shared, Query(at): Query<At>) -> Answer<StatusCode> {
    let library = library(&service)?;
    blocking(move || library.mkdir(&at.path)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Rename {
    from: String,
    to: String,
}

async fn rename(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Json(body): Json<Rename>,
) -> Answer<StatusCode> {
    let library = library(&service)?;
    let (from, to) = (body.from.clone(), body.to.clone());
    blocking(move || library.rename(&from, &to)).await?;
    service.store.log(
        &person.name,
        "rename",
        "Library",
        &format!("{} → {}", body.from, body.to),
    );
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Save {
    path: String,
    previous: Metadata,
    metadata: Metadata,
}

async fn save(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Json(body): Json<Save>,
) -> Answer<Json<InspectionJson>> {
    let library = library(&service)?;
    let edit = edit_for(&body.previous, body.metadata);
    let path = body.path.clone();
    let found = blocking(move || library.save(&path, &edit)).await?;
    service.store.log(&person.name, "save", "Library", &body.path);
    Ok(Json(found.into()))
}

/// What one upload did.
fn imported_json(imported: &Imported) -> Value {
    match imported {
        Imported::Added(path) => json!({ "result": "added", "path": path }),
        Imported::Existing(path) => json!({ "result": "existing", "path": path }),
        Imported::Suggested(path) => json!({ "result": "suggested", "path": path }),
        Imported::Unreadable(why) => json!({ "result": "unreadable", "why": why }),
    }
}

/// One file from the browser, streamed to `tmp/` and moved in as `path`.
async fn upload(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
    request: Request,
) -> Answer<Json<Value>> {
    let library = library(&service)?;
    let temporary = library.upload_path();
    let written = async {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::File::create(&temporary).await?;
        let mut stream = request.into_body().into_data_stream();
        while let Some(chunk) = stream.next().await {
            file.write_all(&chunk.map_err(std::io::Error::other)?).await?;
        }
        file.sync_all().await
    }
    .await;
    if let Err(error) = written {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(Error::Io(format!("the upload: {error}")).into());
    }
    let (path, by) = (at.path.clone(), person.name.clone());
    let source = temporary.clone();
    let imported = blocking(move || library.import_file(&source, &path, &by, true)).await;
    let _ = tokio::fs::remove_file(&temporary).await;
    let imported = imported?;
    if let Imported::Added(path) = &imported {
        service.store.log(&person.name, "upload", "Library", path);
    }
    Ok(Json(imported_json(&imported)))
}

/// Routes of editors and up.
pub fn editors() -> Router<Arc<Service>> {
    Router::new()
        .route("/library/write", post(write))
        .route("/library/delete", post(delete))
        .route("/library/mkdir", post(mkdir))
        .route("/library/rename", post(rename))
        .route("/library/save", post(save))
        .route("/library/upload", post(upload))
}

// ---------------------------------------------------------------------------------------------
// Owners: importing a folder of the machine, in the background.

/// The import under way, or the last one.
#[derive(Serialize, Clone, Debug, Default)]
pub struct ImportState {
    /// Whether one is under way.
    pub running: bool,
    /// The folder's name in the library.
    pub name: String,
    /// Files done, and in all.
    pub done: usize,
    /// Files in all.
    pub total: usize,
    /// What it did, once done.
    pub report: Option<Report>,
    /// Why it stopped, if it failed.
    pub error: Option<String>,
}

async fn import_state(State(service): Shared) -> Json<ImportState> {
    Json(
        service
            .importing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone(),
    )
}

#[derive(Deserialize)]
struct ImportFolder {
    /// The folder of the machine.
    path: String,
    /// Its name in the library; the folder's own by default.
    name: Option<String>,
}

async fn import_folder(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Json(body): Json<ImportFolder>,
) -> Answer<Json<ImportState>> {
    let library = library(&service)?;
    let folder = PathBuf::from(&body.path);
    let name = body
        .name
        .clone()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| folder.file_name().map(|name| name.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "Imported".into());
    {
        let mut state = service
            .importing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.running {
            return Err(ApiError::new(StatusCode::CONFLICT, "busy", "an import is under way"));
        }
        *state = ImportState {
            running: true,
            name: name.clone(),
            ..ImportState::default()
        };
    }
    let worker = Arc::clone(&service);
    let by = person.name.clone();
    tokio::task::spawn_blocking(move || {
        let progress = |done, total| {
            let mut state = worker
                .importing
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.done = done;
            state.total = total;
        };
        let result = library.import_folder(&folder, &name, &by, progress);
        if let Ok(report) = &result {
            worker.store.log(
                &by,
                "import",
                "Library",
                &format!(
                    "{name}: {} added, {} there, {} suggested, {} left out",
                    report.added,
                    report.existing,
                    report.suggested,
                    report.unreadable.len()
                ),
            );
        }
        let mut state = worker
            .importing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.running = false;
        match result {
            Ok(report) => state.report = Some(report),
            Err(error) => state.error = Some(error.to_string()),
        }
    });
    Ok(import_state(State(service)).await)
}

/// Routes of owners.
pub fn owners() -> Router<Arc<Service>> {
    Router::new().route("/library/import", post(import_folder))
}
