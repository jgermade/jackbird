//! The family library over HTTP (F1): `jackbird-store` as a root the interface opens like any
//! other (listeners read and play; editors save, rename, delete and upload), importing a folder of
//! the machine in the background (owners), uploads streamed to disk and moved in, and songs leaving
//! with the family's tags, with byte ranges, streamed.
//!
//! Each person's music is a shelf (SH-D1, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md,
//! 2026-11-13 03:33): every route takes `shelf` (a person's id; one's own by default), the
//! interface's paths are the shelf's, and the catalogue's carry its prefix (`@<person>/`). A
//! shelf shared with one is read, played and kept in one's own version; the rest is its owner's.

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use jackbird_api::{EntryJson, InspectionJson, Metadata, StatJson, edit_for};
use jackbird_core::Entry;
use jackbird_core::Error;
use jackbird_store::{Imported, Library, OWN, Outgoing, Report, Saved, Scope, Viewer, is_own, on_shelf, shelf_path};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use crate::people::{Person, Role};
use crate::{Answer, ApiError, Service, blocking};

type Shared = State<Arc<Service>>;

fn library(service: &Service) -> Answer<Arc<Library>> {
    service
        .library
        .clone()
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no-library", "this service has no library"))
}

/// How a person sees the library: their own version, unless they chose the family's (F3).
fn viewer(person: &Person) -> Viewer {
    Viewer::of(person.id, person.settings.mine)
}

/// The shelf a request is on, as the person asking may see it.
#[derive(Clone, Copy, Debug)]
struct Shelf {
    /// Whose it is.
    owner: i64,
    /// Whether it is the asker's own.
    own: bool,
}

impl Shelf {
    /// `asked` (one's own when none), if the person may see it; refused as not found otherwise.
    fn of(library: &Library, person: &Person, asked: Option<i64>) -> Answer<Shelf> {
        let owner = asked.unwrap_or(person.id);
        if !library.may_see(person.id, owner) {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "not-shared",
                "no such music is shared with you",
            ));
        }
        Ok(Shelf {
            owner,
            own: owner == person.id,
        })
    }

    /// A path of the shelf as the catalogue keeps it; one's own folder (F3) stays as it is (it is
    /// in every shelf one looks at, its playlists made from what one did listing that shelf's).
    fn inner(&self, path: &str) -> String {
        let path = path.trim_matches('/');
        if is_own(path) {
            path.to_owned()
        } else {
            shelf_path(self.owner, path)
        }
    }

    /// How `person` sees this shelf.
    fn viewer(&self, person: &Person) -> Viewer {
        viewer(person).on(self.owner)
    }

    /// A catalogue path as the shelf shows it; `None` when it is not on it.
    fn outer(&self, path: &str) -> Option<String> {
        if is_own(path) {
            return Some(path.to_owned());
        }
        match on_shelf(path) {
            Some((owner, inner)) if owner == self.owner && !inner.is_empty() => Some(inner.to_owned()),
            _ => None,
        }
    }

    /// The entries of the catalogue that are the shelf's, with its paths.
    fn entries(&self, entries: Vec<Entry>) -> Vec<Entry> {
        entries
            .into_iter()
            .filter_map(|entry| {
                let path = self.outer(&entry.path)?;
                Some(Entry { path, ..entry })
            })
            .collect()
    }

    /// Changing the shelf (its tags, places, files) is its owner's (SH-D4).
    fn writable(&self) -> Answer<()> {
        if self.own {
            Ok(())
        } else {
            Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "not-yours",
                "this music is shared with you: only its owner changes it",
            ))
        }
    }
}

/// Writing outside one's own folder is an editor's.
fn may_write(person: &Person, path: &str) -> Answer<()> {
    if person.role >= Role::Editor || is_own(path.trim_matches('/')) {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "role",
            "this needs the role editor or more",
        ))
    }
}

#[derive(Deserialize)]
struct At {
    #[serde(default)]
    path: String,
    /// Whose music (one's own by default).
    shelf: Option<i64>,
}

async fn info(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
) -> Answer<Json<Value>> {
    let library = library(&service)?;
    let shelf = Shelf::of(&library, &person, at.shelf)?;
    let prefix = shelf_path(shelf.owner, "") + "/";
    let songs = blocking(move || library.songs())
        .await?
        .iter()
        .filter(|song| song.path.starts_with(&prefix))
        .count();
    let owner = service
        .store
        .person(shelf.owner)
        .map(|owner| owner.name)
        .unwrap_or_default();
    Ok(Json(
        json!({ "name": "Library", "songs": songs, "shelf": shelf.owner, "own": shelf.own, "owner": owner }),
    ))
}

async fn walk(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
) -> Answer<Json<Vec<EntryJson>>> {
    let library = library(&service)?;
    let shelf = Shelf::of(&library, &person, at.shelf)?;
    let seen = shelf.viewer(&person);
    let entries = blocking(move || library.walk_as(seen)).await?;
    Ok(Json(shelf.entries(entries).into_iter().map(Into::into).collect()))
}

async fn list(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
) -> Answer<Json<Vec<EntryJson>>> {
    let library = library(&service)?;
    let shelf = Shelf::of(&library, &person, at.shelf)?;
    let path = shelf.inner(&at.path);
    let seen = shelf.viewer(&person);
    let mut entries = shelf.entries(blocking(move || library.list_as(&path, seen)).await?);
    // One's own folder (F3), at the top of the shelf.
    if at.path.trim_matches('/').is_empty() {
        entries.push(Entry {
            path: OWN.to_owned(),
            name: OWN.to_owned(),
            stat: jackbird_core::Stat {
                folder: true,
                size: 0,
                mtime: 0,
            },
        });
        entries.sort_by(|a, b| a.name.cmp(&b.name));
    }
    Ok(Json(entries.into_iter().map(Into::into).collect()))
}

async fn read(State(service): Shared, Extension(person): Extension<Person>, Query(at): Query<At>) -> Answer<Response> {
    let library = library(&service)?;
    let shelf = Shelf::of(&library, &person, at.shelf)?;
    let (path, seen) = (shelf.inner(&at.path), shelf.viewer(&person));
    let bytes = blocking(move || library.read_as(&path, seen)).await?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response())
}

async fn stat(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
) -> Answer<Json<Option<StatJson>>> {
    let library = library(&service)?;
    let shelf = Shelf::of(&library, &person, at.shelf)?;
    let (path, seen) = (shelf.inner(&at.path), shelf.viewer(&person));
    let stat = blocking(move || library.stat_as(&path, seen)).await?;
    Ok(Json(stat.map(Into::into)))
}

#[derive(Deserialize)]
struct Inspect {
    path: String,
    known: Option<String>,
    shelf: Option<i64>,
}

async fn inspect(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Json(body): Json<Inspect>,
) -> Answer<Json<InspectionJson>> {
    let library = library(&service)?;
    let path = Shelf::of(&library, &person, body.shelf)?.inner(&body.path);
    let found = blocking(move || library.inspect_as(&path, body.known.as_deref(), viewer(&person))).await?;
    Ok(Json(found.into()))
}

async fn suggestions(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
) -> Answer<Json<Value>> {
    let library = library(&service)?;
    let path = Shelf::of(&library, &person, at.shelf)?.inner(&at.path);
    let found = blocking(move || library.suggestions(&path)).await?;
    Ok(Json(json!(found)))
}

/// What a song's tags are made of, for its Info (F3).
async fn layers(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
) -> Answer<Json<Value>> {
    let library = library(&service)?;
    let path = Shelf::of(&library, &person, at.shelf)?.inner(&at.path);
    let found = blocking(move || library.layers(&path, Some(person.id))).await?;
    Ok(Json(json!(found)))
}

#[derive(Deserialize)]
struct Path {
    path: String,
    shelf: Option<i64>,
}

async fn forget_mine(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Json(body): Json<Path>,
) -> Answer<StatusCode> {
    let library = library(&service)?;
    let path = Shelf::of(&library, &person, body.shelf)?.inner(&body.path);
    blocking(move || library.forget_mine(&path, person.id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Favourite {
    path: String,
    on: bool,
    shelf: Option<i64>,
}

async fn favourite(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Json(body): Json<Favourite>,
) -> Answer<StatusCode> {
    let library = library(&service)?;
    let path = Shelf::of(&library, &person, body.shelf)?.inner(&body.path);
    blocking(move || library.set_favourite(person.id, &path, body.on)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn played(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Json(body): Json<Path>,
) -> Answer<StatusCode> {
    let library = library(&service)?;
    let path = Shelf::of(&library, &person, body.shelf)?.inner(&body.path);
    blocking(move || library.played(person.id, &path)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn clear_history(State(service): Shared, Extension(person): Extension<Person>) -> Answer<StatusCode> {
    let library = library(&service)?;
    blocking(move || library.clear_history(person.id)).await?;
    Ok(StatusCode::NO_CONTENT)
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
pub(crate) async fn send(out: Outgoing, headers: &HeaderMap, download: bool) -> Answer<Response> {
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

async fn media(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
    request: Request,
) -> Answer<Response> {
    let library = library(&service)?;
    let path = Shelf::of(&library, &person, at.shelf)?.inner(&at.path);
    let out = blocking(move || library.outgoing_as(&path, viewer(&person))).await?;
    send(out, request.headers(), false).await
}

async fn download(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
    request: Request,
) -> Answer<Response> {
    let library = library(&service)?;
    let path = Shelf::of(&library, &person, at.shelf)?.inner(&at.path);
    let out = blocking(move || library.outgoing_as(&path, viewer(&person))).await?;
    send(out, request.headers(), true).await
}

/// The music shared with the person asking: one entry per person whose shelf they may see.
async fn shelves(State(service): Shared, Extension(person): Extension<Person>) -> Answer<Json<Value>> {
    let library = library(&service)?;
    let me = person.id;
    let owners = blocking(move || library.shared_with(me)).await?;
    let shelves: Vec<Value> = owners
        .into_iter()
        .filter_map(|owner| service.store.person(owner))
        .map(|owner| json!({ "shelf": owner.id, "name": owner.name }))
        .collect();
    Ok(Json(json!(shelves)))
}

/// Whom one's own shelf is shared with, and everyone who could be chosen.
async fn shares(State(service): Shared, Extension(person): Extension<Person>) -> Answer<Json<Value>> {
    let library = library(&service)?;
    let me = person.id;
    let shares = blocking(move || library.shares(me)).await?;
    let people: Vec<Value> = service
        .store
        .people()
        .unwrap_or_default()
        .into_iter()
        .filter(|other| other.id != person.id)
        .map(|other| json!({ "id": other.id, "name": other.name }))
        .collect();
    Ok(Json(
        json!({ "everyone": shares.everyone, "people": shares.people, "candidates": people }),
    ))
}

#[derive(Deserialize)]
struct SetShares {
    everyone: bool,
    #[serde(default)]
    people: Vec<i64>,
}

/// Shares one's own shelf with everyone, or with these people (SH-D3).
async fn set_shares(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Json(body): Json<SetShares>,
) -> Answer<StatusCode> {
    let library = library(&service)?;
    let me = person.id;
    let (everyone, people) = (body.everyone, body.people.clone());
    blocking(move || library.set_shares(me, everyone, &people)).await?;
    let with = if body.everyone {
        "everyone".to_owned()
    } else {
        format!("{} people", body.people.len())
    };
    service.store.log(&person.name, "share", "Library", &with);
    Ok(StatusCode::NO_CONTENT)
}

/// Routes of everyone with a place (listeners and up).
pub fn listeners() -> Router<Arc<Service>> {
    Router::new()
        .route("/library", get(info))
        .route("/library/shelves", get(shelves))
        .route("/library/shares", get(shares).post(set_shares))
        .route("/library/walk", get(walk))
        .route("/library/list", get(list))
        .route("/library/read", get(read))
        .route("/library/stat", get(stat))
        .route("/library/inspect", post(inspect))
        .route("/library/suggestions", get(suggestions))
        .route("/library/media", get(media))
        .route("/library/download", get(download))
        .route("/library/import", get(import_state))
        .route("/library/layers", get(layers))
        .route("/library/mine/forget", post(forget_mine))
        .route("/library/favourite", post(favourite))
        .route("/library/played", post(played))
        .route("/library/history/clear", post(clear_history))
        // Anyone writes in their own folder and saves their own layer; the rest is checked inside.
        .route("/library/write", post(write))
        .route("/library/delete", post(delete))
        .route("/library/rename", post(rename))
        .route("/library/save", post(save))
}

// ---------------------------------------------------------------------------------------------
// Editors: saves, the library's places, small files, uploads.

#[derive(Deserialize)]
struct WriteAt {
    #[serde(default)]
    path: String,
    shelf: Option<i64>,
    /// The size and date the writer read (F4): a file changed since is not written over.
    size: Option<u64>,
    mtime: Option<u64>,
}

/// A change refused because what it was made on changed since (F4).
fn stale(message: String, extra: Value) -> Response {
    let mut body = json!({ "code": "stale", "message": message });
    if let (Some(body), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
        body.extend(extra.clone());
    }
    (StatusCode::CONFLICT, Json(body)).into_response()
}

async fn write(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Query(at): Query<WriteAt>,
    body: axum::body::Bytes,
) -> Answer<Response> {
    may_write(&person, &at.path)?;
    let library = library(&service)?;
    let shelf = Shelf::of(&library, &person, at.shelf)?;
    shelf.writable()?;
    let path = shelf.inner(&at.path);
    let seen = shelf.viewer(&person);
    let expected = at.size.zip(at.mtime);
    if !blocking(move || library.write_checked(&path, &body, seen, expected)).await? {
        return Ok(stale(format!("{} changed since it was read", at.path), Value::Null));
    }
    if !at.path.starts_with(".meta/") && !is_own(at.path.trim_matches('/')) {
        service.store.log(&person.name, "write", "Library", &at.path);
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn delete(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
) -> Answer<StatusCode> {
    may_write(&person, &at.path)?;
    let library = library(&service)?;
    let shelf = Shelf::of(&library, &person, at.shelf)?;
    shelf.writable()?;
    let path = shelf.inner(&at.path);
    let seen = shelf.viewer(&person);
    let by = person.name.clone();
    blocking(move || {
        if is_own(path.trim_matches('/')) {
            library.delete_as(&path, seen)
        } else {
            // To the trash (F4).
            library.delete_by(&path, &by)
        }
    })
    .await?;
    if !is_own(at.path.trim_matches('/')) {
        service.store.log(&person.name, "trash", "Library", &at.path);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn mkdir(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
) -> Answer<StatusCode> {
    let library = library(&service)?;
    let shelf = Shelf::of(&library, &person, at.shelf)?;
    shelf.writable()?;
    let path = shelf.inner(&at.path);
    blocking(move || library.mkdir(&path)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Rename {
    from: String,
    to: String,
    shelf: Option<i64>,
}

async fn rename(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Json(body): Json<Rename>,
) -> Answer<StatusCode> {
    may_write(&person, &body.from)?;
    may_write(&person, &body.to)?;
    let library = library(&service)?;
    let shelf = Shelf::of(&library, &person, body.shelf)?;
    shelf.writable()?;
    let (from, to) = (shelf.inner(&body.from), shelf.inner(&body.to));
    let seen = shelf.viewer(&person);
    blocking(move || library.rename_as(&from, &to, seen)).await?;
    if !is_own(body.from.trim_matches('/')) {
        service.store.log(
            &person.name,
            "rename",
            "Library",
            &format!("{} → {}", body.from, body.to),
        );
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Save {
    path: String,
    previous: Metadata,
    metadata: Metadata,
    /// `family` (editors and up; the default) or `mine` (anyone).
    #[serde(default)]
    scope: Option<String>,
    /// The full checksum the saver read (F4): a song changed since is not saved over.
    #[serde(default)]
    expected: Option<String>,
    shelf: Option<i64>,
}

async fn save(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Json(body): Json<Save>,
) -> Answer<Response> {
    let scope = match body.scope.as_deref() {
        Some("mine") => Scope::Mine(person.id),
        _ if person.role >= Role::Editor => Scope::Family,
        _ => {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "role",
                "only editors save for everyone; save for yourself",
            ));
        }
    };
    let library = library(&service)?;
    let shelf = Shelf::of(&library, &person, body.shelf)?;
    // The shelf's tags are its owner's; in a shared one, one saves one's own version (SH-D4).
    if scope == Scope::Family {
        shelf.writable()?;
    }
    let edit = edit_for(&body.previous, body.metadata);
    let path = shelf.inner(&body.path);
    let (seen, expected, by) = (viewer(&person), body.expected.clone(), person.name.clone());
    let saved = blocking(move || library.save_checked(&path, &edit, scope, seen, expected.as_deref(), &by)).await?;
    match saved {
        Saved::Done(found) => {
            if scope == Scope::Family {
                service.store.log(&person.name, "save", "Library", &body.path);
            }
            Ok(Json(InspectionJson::from(found)).into_response())
        }
        Saved::Stale(stale_save) => {
            let who = if stale_save.by.is_empty() {
                "you, elsewhere".to_owned()
            } else {
                stale_save.by.clone()
            };
            Ok(stale(
                format!("{} was changed by {who} since you opened it", body.path),
                json!({ "by": stale_save.by, "current": InspectionJson::from(stale_save.current) }),
            ))
        }
    }
}

/// What one upload did, its path the shelf's.
fn imported_json(shelf: &Shelf, imported: &Imported) -> Value {
    let shown = |path: &String| shelf.outer(path).unwrap_or_else(|| path.clone());
    match imported {
        Imported::Added(path) => json!({ "result": "added", "path": shown(path) }),
        Imported::Existing(path) => json!({ "result": "existing", "path": shown(path) }),
        Imported::Suggested(path) => json!({ "result": "suggested", "path": shown(path) }),
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
    let shelf = Shelf::of(&library, &person, at.shelf)?;
    shelf.writable()?;
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
    let (path, by, id) = (shelf.inner(&at.path), person.name.clone(), person.id);
    let source = temporary.clone();
    let imported = blocking(move || library.import_file(&source, &path, &by, Some(id), true)).await;
    let _ = tokio::fs::remove_file(&temporary).await;
    let imported = imported?;
    if let Imported::Added(path) = &imported {
        service.store.log(
            &person.name,
            "upload",
            "Library",
            shelf.outer(path).as_deref().unwrap_or(path),
        );
    }
    Ok(Json(imported_json(&shelf, &imported)))
}

#[derive(Deserialize)]
struct Apply {
    path: String,
    id: i64,
    shelf: Option<i64>,
}

/// Applies a suggestion to the family's version (editors, F3).
async fn apply_suggestion(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Json(body): Json<Apply>,
) -> Answer<Json<InspectionJson>> {
    let library = library(&service)?;
    let shelf = Shelf::of(&library, &person, body.shelf)?;
    shelf.writable()?;
    let path = shelf.inner(&body.path);
    let found = blocking(move || library.apply_suggestion(&path, body.id)).await?;
    service.store.log(&person.name, "save", "Library", &body.path);
    Ok(Json(found.into()))
}

/// Routes of editors and up.
pub fn editors() -> Router<Arc<Service>> {
    Router::new()
        .route("/library/mkdir", post(mkdir))
        .route("/library/upload", post(upload))
        .route("/library/suggestions/apply", post(apply_suggestion))
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
    let id = person.id;
    tokio::task::spawn_blocking(move || {
        let progress = |done, total| {
            let mut state = worker
                .importing
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.done = done;
            state.total = total;
        };
        // Onto the importer's shelf (SH-D1).
        let result = library.import_folder(&folder, &shelf_path(id, &name), &by, Some(id), progress);
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
