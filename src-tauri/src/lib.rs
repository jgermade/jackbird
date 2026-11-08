//! jackbird as a desktop app (E4, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 10:52 and
//! 13:55): the web interface in Tauri's webview, and its files, tags and checksums through
//! `jackbird-core`, by path. The webview never gets a file's bytes to read its tags or hash it:
//! one command does the work here and answers with the result. Only folders the person chose
//! in the dialog, or that the app's own session reopens, can be reached.
//!
//! The interface's side is `src/lib/sources/desktop.ts`.

mod media;

use std::collections::HashMap;
use std::sync::Mutex;

use jackbird_core::{Entry, Error, Inspection, Root, Stat};
use jackbird_tags::{Cover, CoverEdit, Edit};
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

/// The open roots, by their path, as the interface names them.
#[derive(Default)]
struct Roots(Mutex<HashMap<String, Root>>);

/// Where media is played from on this system.
enum Media {
    /// The asset protocol (macOS, Windows): the interface makes the URL from the path.
    Asset,
    /// The local server (Linux).
    Server(media::MediaServer),
}

type Answer<T> = Result<T, Failure>;

/// An error as the interface gets it: a code for its texts, and a message.
#[derive(Serialize)]
struct Failure {
    code: String,
    message: String,
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Failure {
            code: error.code().into(),
            message: error.to_string(),
        }
    }
}

fn failure(code: &str, message: impl Into<String>) -> Failure {
    Failure {
        code: code.into(),
        message: message.into(),
    }
}

fn root_of(roots: &State<'_, Roots>, root: &str) -> Answer<Root> {
    roots
        .0
        .lock()
        .map_err(|_| failure("io", "the roots' list"))?
        .get(root)
        .cloned()
        .ok_or_else(|| failure("outside", format!("{root:?} is not an open folder")))
}

/// Runs file work off the interface's thread.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, Error> + Send + 'static) -> Answer<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| failure("io", error.to_string()))?
        .map_err(Failure::from)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    path: String,
    name: String,
}

/// Registers a folder as an open root, and lets the asset protocol reach it where it is used.
fn register(app: &AppHandle, path: &str) -> Answer<Opened> {
    let root = Root::open(path).map_err(Failure::from)?;
    let opened = Opened {
        path: path.to_owned(),
        name: root.name(),
    };
    if matches!(*app.state::<Media>(), Media::Asset) {
        app.asset_protocol_scope()
            .allow_directory(root.path(), true)
            .map_err(|error| failure("io", error.to_string()))?;
    }
    app.state::<Roots>()
        .0
        .lock()
        .map_err(|_| failure("io", "the roots' list"))?
        .insert(path.to_owned(), root);
    Ok(opened)
}

/// Asks for a folder in the system's dialog and opens it; `None` when the person cancels.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Answer<Option<Opened>> {
    let picked = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|error| failure("io", error.to_string()))?
    };
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| failure("io", error.to_string()))?
        .display()
        .to_string();
    register(&app, &path).map(Some)
}

/// Reopens a folder the app's own session kept.
#[tauri::command]
fn open_root(app: AppHandle, path: String) -> Answer<Opened> {
    register(&app, &path)
}

/// Closes a root: nothing under it can be reached any more.
#[tauri::command]
fn close_root(roots: State<'_, Roots>, root: String) {
    if let Ok(mut open) = roots.0.lock() {
        open.remove(&root);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatJson {
    kind: &'static str,
    size: u64,
    mtime: u64,
}

impl From<Stat> for StatJson {
    fn from(stat: Stat) -> Self {
        StatJson {
            kind: if stat.folder { "directory" } else { "file" },
            size: stat.size,
            mtime: stat.mtime,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryJson {
    name: String,
    path: String,
    stat: StatJson,
}

impl From<Entry> for EntryJson {
    fn from(entry: Entry) -> Self {
        EntryJson {
            name: entry.name,
            path: entry.path,
            stat: entry.stat.into(),
        }
    }
}

/// Every file under a root.
#[tauri::command]
async fn walk(roots: State<'_, Roots>, root: String) -> Answer<Vec<EntryJson>> {
    let root = root_of(&roots, &root)?;
    blocking(move || root.walk())
        .await
        .map(|entries| entries.into_iter().map(Into::into).collect())
}

/// The entries of one folder.
#[tauri::command]
async fn list(roots: State<'_, Roots>, root: String, path: String) -> Answer<Vec<EntryJson>> {
    let root = root_of(&roots, &root)?;
    blocking(move || root.list(&path))
        .await
        .map(|entries| entries.into_iter().map(Into::into).collect())
}

/// A small file's bytes, as raw bytes (no JSON).
#[tauri::command]
async fn read(roots: State<'_, Roots>, root: String, path: String) -> Answer<Response> {
    let root = root_of(&roots, &root)?;
    blocking(move || root.read(&path)).await.map(Response::new)
}

/// Writes a small file: its bytes are the request's body; its root and path, headers.
#[tauri::command]
async fn write(roots: State<'_, Roots>, request: Request<'_>) -> Answer<()> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(decode_header)
            .ok_or_else(|| failure("io", format!("the request has no {name}")))
    };
    let (root, path) = (root_of(&roots, &header("x-root")?)?, header("x-path")?);
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(failure("io", "the request's body is not raw bytes"));
    };
    let bytes = bytes.clone();
    blocking(move || root.write(&path, &bytes)).await
}

/// Headers carry paths percent-encoded (`encodeURIComponent`): any character a path may hold.
fn decode_header(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%'
            && let Some(byte) = value
                .get(at + 1..at + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            out.push(byte);
            at += 3;
            continue;
        }
        out.push(bytes[at]);
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
async fn stat(roots: State<'_, Roots>, root: String, path: String) -> Answer<Option<StatJson>> {
    let root = root_of(&roots, &root)?;
    blocking(move || root.stat(&path))
        .await
        .map(|stat| stat.map(Into::into))
}

#[tauri::command]
async fn delete(roots: State<'_, Roots>, root: String, path: String) -> Answer<()> {
    let root = root_of(&roots, &root)?;
    blocking(move || root.delete(&path)).await
}

#[tauri::command]
async fn rename(roots: State<'_, Roots>, root: String, from: String, to: String) -> Answer<()> {
    let root = root_of(&roots, &root)?;
    blocking(move || root.rename(&from, &to)).await
}

#[tauri::command]
async fn mkdir(roots: State<'_, Roots>, root: String, path: String) -> Answer<()> {
    let root = root_of(&roots, &root)?;
    blocking(move || root.mkdir(&path)).await
}

/// The tags as the interface keeps them (`TrackMetadata`), the cover a data URL.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    title: String,
    artist: String,
    album: String,
    year: String,
    genre: String,
    track_number: String,
    cover_data_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectionJson {
    size: u64,
    last_modified: u64,
    full_checksum: String,
    audio_checksum: String,
    metadata: Option<Metadata>,
}

impl From<Inspection> for InspectionJson {
    fn from(found: Inspection) -> Self {
        InspectionJson {
            size: found.stat.size,
            last_modified: found.stat.mtime,
            full_checksum: found.full_checksum,
            audio_checksum: found.audio_checksum,
            metadata: found.tags.map(|(fields, cover)| Metadata {
                title: fields.title,
                artist: fields.artist,
                album: fields.album,
                year: fields.year,
                genre: fields.genre,
                track_number: fields.track,
                cover_data_url: cover.map(|cover| {
                    let mime = if cover.mime.is_empty() {
                        "image/jpeg"
                    } else {
                        &cover.mime
                    };
                    format!("data:{mime};base64,{}", jackbird_core::base64_encode(&cover.data))
                }),
            }),
        }
    }
}

/// A file's size, date and checksums, and its tags unless its full checksum is still `known`.
#[tauri::command]
async fn inspect(roots: State<'_, Roots>, root: String, path: String, known: Option<String>) -> Answer<InspectionJson> {
    let root = root_of(&roots, &root)?;
    blocking(move || jackbird_core::inspect(&root, &path, known.as_deref()))
        .await
        .map(Into::into)
}

/// A data URL's picture, or `None` when it is not a base64 data URL.
fn cover_of(url: &str) -> Option<Cover> {
    let (head, data) = url.strip_prefix("data:")?.split_once(',')?;
    let mime = head.strip_suffix(";base64")?.split(';').next().unwrap_or("");
    Some(Cover {
        data: jackbird_core::base64_decode(data)?,
        mime: if mime.is_empty() {
            "image/jpeg".into()
        } else {
            mime.into()
        },
    })
}

/// The edit that writes `metadata` over the tags the library held (`previous`), as
/// `editFor` (`src/helpers/cover.ts`) makes it in the browser.
fn edit_for(previous: &Metadata, metadata: Metadata) -> Edit {
    let cover = match (&previous.cover_data_url, &metadata.cover_data_url) {
        (before, now) if before == now => CoverEdit::Keep,
        (_, None) => CoverEdit::Remove,
        (_, Some(url)) => cover_of(url).map_or(CoverEdit::Keep, CoverEdit::Set),
    };
    Edit {
        title: Some(metadata.title),
        artist: Some(metadata.artist),
        album: Some(metadata.album),
        year: Some(metadata.year),
        genre: Some(metadata.genre),
        track: Some(metadata.track_number),
        cover,
    }
}

/// Writes new tags into a file; the file as it is after.
#[tauri::command]
async fn save(
    roots: State<'_, Roots>,
    root: String,
    path: String,
    previous: Metadata,
    metadata: Metadata,
) -> Answer<InspectionJson> {
    let root = root_of(&roots, &root)?;
    let edit = edit_for(&previous, metadata);
    blocking(move || jackbird_core::save(&root, &path, &edit))
        .await
        .map(Into::into)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum MediaUrl {
    /// The interface makes the asset protocol's URL from this path (`convertFileSrc`).
    Asset { path: String },
    /// The local server's URL.
    Http { url: String },
}

/// Where a track plays from.
#[tauri::command]
fn media_url(roots: State<'_, Roots>, media: State<'_, Media>, root: String, path: String) -> Answer<MediaUrl> {
    let file = root_of(&roots, &root)?.resolve(&path).map_err(Failure::from)?;
    Ok(match &*media {
        Media::Asset => MediaUrl::Asset {
            path: file.display().to_string(),
        },
        Media::Server(server) => MediaUrl::Http { url: server.url(file) },
    })
}

/// The unattended check's folder, when the app runs it (`JACKBIRD_CHECK_FOLDER`, `desktop.yml`).
#[tauri::command]
fn check_folder() -> Option<String> {
    std::env::var("JACKBIRD_CHECK_FOLDER").ok()
}

/// The unattended check's report: printed, written to `JACKBIRD_CHECK_REPORT` when set, and the app quits.
#[tauri::command]
fn check_report(app: AppHandle, report: String) {
    println!("JACKBIRD-CHECK {report}");
    if let Ok(path) = std::env::var("JACKBIRD_CHECK_REPORT") {
        let _ = std::fs::write(path, &report);
    }
    app.exit(0);
}

/// Starts the app.
pub fn run() {
    let media = if cfg!(target_os = "linux") {
        Media::Server(media::MediaServer::start().expect("the local media server could not start"))
    } else {
        Media::Asset
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Roots::default())
        .manage(media)
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            open_root,
            close_root,
            walk,
            list,
            read,
            write,
            stat,
            delete,
            rename,
            mkdir,
            inspect,
            save,
            media_url,
            check_folder,
            check_report
        ])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("jackbird")
                .inner_size(1280.0, 800.0)
                .min_inner_size(360.0, 480.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("jackbird could not start");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(cover: Option<&str>) -> Metadata {
        Metadata {
            title: "T".into(),
            artist: String::new(),
            album: String::new(),
            year: String::new(),
            genre: String::new(),
            track_number: "1".into(),
            cover_data_url: cover.map(Into::into),
        }
    }

    #[test]
    fn edits_keep_set_or_remove_the_cover_as_the_browser_does() {
        let png = "data:image/png;base64,AQI=";
        assert_eq!(
            edit_for(&metadata(Some(png)), metadata(Some(png))).cover,
            CoverEdit::Keep
        );
        assert_eq!(edit_for(&metadata(None), metadata(None)).cover, CoverEdit::Keep);
        assert_eq!(edit_for(&metadata(Some(png)), metadata(None)).cover, CoverEdit::Remove);
        assert_eq!(
            edit_for(&metadata(None), metadata(Some(png))).cover,
            CoverEdit::Set(Cover {
                data: vec![1, 2],
                mime: "image/png".into()
            })
        );
        assert_eq!(
            edit_for(&metadata(None), metadata(Some("blob:x"))).cover,
            CoverEdit::Keep
        );
        let edit = edit_for(&metadata(None), metadata(None));
        assert_eq!((edit.title.as_deref(), edit.track.as_deref()), (Some("T"), Some("1")));
        assert_eq!(cover_of("data:;base64,AQ==").unwrap().mime, "image/jpeg");
        assert_eq!(cover_of("data:image/png;name=a;base64,AQ==").unwrap().mime, "image/png");
        assert!(cover_of("data:image/png,raw").is_none());
    }

    #[test]
    fn headers_are_percent_decoded() {
        assert_eq!(decode_header("Jazz%2FSo%20What.mp3"), "Jazz/So What.mp3");
        assert_eq!(decode_header("%C3%B1and%C3%BA"), "ñandú");
        assert_eq!(decode_header("100%"), "100%");
    }
}
