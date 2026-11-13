//! jackbird as a desktop app (E4, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 10:52 and
//! 13:55): the web interface in Tauri's webview, and its files, tags and checksums through
//! `jackbird-core`, by path. The webview never gets a file's bytes to read its tags or hash it:
//! one command does the work here and answers with the result. Only folders the person chose
//! in the dialog, or that the app's own session reopens, can be reached.
//!
//! The interface's side is `src/lib/sources/desktop.ts`.

#[cfg(desktop)]
mod audio;
mod media;
mod scan;
mod service;

use std::collections::HashMap;
use std::sync::Mutex;

use jackbird_api::{EntryJson, Failure, InspectionJson, Metadata, Opened, StatJson, edit_for, failure};
use jackbird_core::{Error, Root};
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;

/// The open roots, by their path, as the interface names them.
#[derive(Default)]
pub(crate) struct Roots(Mutex<HashMap<String, Root>>);

/// Where media is played from on this system.
enum Media {
    /// The asset protocol (macOS, Windows): the interface makes the URL from the path.
    Asset,
    /// The local server (Linux).
    Server(media::MediaServer),
}

type Answer<T> = Result<T, Failure>;

pub(crate) fn root_of(roots: &State<'_, Roots>, root: &str) -> Answer<Root> {
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

/// A folder chosen in the system's dialog; `None` when the person cancels. Phones have no folder
/// dialog (E6's spike weighs their own ways to files, Android's SAF and iOS's bookmarks).
async fn pick(app: AppHandle) -> Answer<Option<tauri_plugin_dialog::FilePath>> {
    #[cfg(desktop)]
    return tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map_err(|error| failure("io", error.to_string()));
    #[cfg(mobile)]
    {
        let _ = app;
        Err(failure("unsupported", "a phone has no folder dialog"))
    }
}

/// Asks for a folder in the system's dialog and opens it; `None` when the person cancels.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Answer<Option<Opened>> {
    let picked = pick(app.clone()).await?;
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

/// A file's size, date and checksums, and its tags unless its full checksum is still `known`.
#[tauri::command]
async fn inspect(roots: State<'_, Roots>, root: String, path: String, known: Option<String>) -> Answer<InspectionJson> {
    let root = root_of(&roots, &root)?;
    blocking(move || jackbird_core::inspect(&root, &path, known.as_deref()))
        .await
        .map(Into::into)
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

/// A file of a folder the person chose in Android's folder picker (E6b-D9): opened by the app's
/// plugin, its descriptor handed to Rust, and read by `jackbird-core` as any file: size, date,
/// checksums, and its tags unless its full checksum is still `known`. Streamed.
#[cfg(target_os = "android")]
#[tauri::command]
async fn phone_inspect(app: AppHandle, tree: String, path: String, known: Option<String>) -> Answer<InspectionJson> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = phone::take(
            tauri_plugin_jackbird_player::open_file(&app, &tree, &path, false).map_err(|error| failure("io", error))?,
        )?;
        jackbird_core::inspect_open(file, &path, known.as_deref()).map_err(Failure::from)
    })
    .await
    .map_err(|error| failure("io", error.to_string()))?
    .map(Into::into)
}

/// New tags into a file of a folder the person chose in Android's folder picker (E6b-D9's second
/// part): the plugin opens it for reading and writing and hands its descriptor to Rust, and
/// `jackbird-core` writes the splice in place when it fits. When it does not, the plugin makes a
/// file beside it, Rust writes the new tags and the old audio into it and checks the audio, and the
/// plugin puts it in the old one's place; on a failure before that, the file beside is removed and
/// the old one is untouched (the plugin's `replace` says what it leaves if it fails itself). The
/// file as it is after.
#[cfg(target_os = "android")]
#[tauri::command]
async fn phone_save(
    app: AppHandle,
    tree: String,
    path: String,
    previous: Metadata,
    metadata: Metadata,
) -> Answer<InspectionJson> {
    use tauri_plugin_jackbird_player::{open_beside, open_file, remove_file, replace_file};
    let edit = edit_for(&previous, metadata);
    tauri::async_runtime::spawn_blocking(move || {
        let file = phone::take(open_file(&app, &tree, &path, true).map_err(|error| failure("io", error))?)?;
        let mut made: Option<String> = None;
        let saved = jackbird_core::save_open(file, &path, &edit, || {
            let (beside, fd) = open_beside(&app, &tree, &path).map_err(jackbird_core::Error::Io)?;
            made = Some(beside);
            phone::take(fd).map_err(|error| jackbird_core::Error::Io(error.message))
        });
        match (saved, made) {
            (Ok(jackbird_core::Saved::Done(after)), _) => Ok(after),
            // The plugin cleans up after itself here: it removes the file beside when the old one
            // stays, and keeps it when it is the only copy left.
            (Ok(jackbird_core::Saved::Beside(after)), Some(beside)) => replace_file(&app, &tree, &beside, &path)
                .map(|()| after)
                .map_err(|error| failure("io", error)),
            (Ok(jackbird_core::Saved::Beside(_)), None) => Err(failure("io", "the file beside was not made")),
            (Err(error), made) => {
                if let Some(beside) = made {
                    let _ = remove_file(&app, &tree, &beside);
                }
                Err(Failure::from(error))
            }
        }
    })
    .await
    .map_err(|error| failure("io", error.to_string()))?
    .map(Into::into)
}

/// The one place the app takes a file descriptor it did not open itself (E6b-D9; the second unsafe
/// code the workspace allows, after `crates/tags-wasm`'s exports: see AGENTS.md).
#[cfg(target_os = "android")]
mod phone {
    use std::fs::File;
    use std::os::fd::FromRawFd;

    use jackbird_api::{Failure, failure};

    /// The file behind a descriptor the plugin opened and gave up for Rust alone
    /// (`tauri_plugin_jackbird_player::open_file`, whose number never comes from the page): owned
    /// here, closed when the file is dropped.
    pub fn take(fd: i32) -> Result<File, Failure> {
        if fd < 0 {
            return Err(failure("io", "Android opened no file"));
        }
        // SAFETY: `fd` was opened by Android's document provider and detached from its
        // ParcelFileDescriptor (`detachFd`) for this call alone, so it is open and owned by nothing
        // else; the `File` takes it over and is its only owner.
        #[allow(unsafe_code)]
        let file = unsafe { File::from_raw_fd(fd) };
        Ok(file)
    }
}

/// The unattended check's folder, when the app runs it (`JACKBIRD_CHECK_FOLDER`, `desktop.yml`).
#[tauri::command]
fn check_folder() -> Option<String> {
    std::env::var("JACKBIRD_CHECK_FOLDER").ok()
}

/// Whether this run of the unattended check is the one after a restart (`JACKBIRD_CHECK_RESTORE`).
#[tauri::command]
fn check_restore() -> bool {
    std::env::var_os("JACKBIRD_CHECK_RESTORE").is_some()
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

/// The commands of the desktop app and of a phone's (E6's spike): the same, but for the native
/// output (E5), which phones do not build.
macro_rules! commands {
    ($($extra:path),*) => {
        tauri::generate_handler![
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
            scan::scan,
            scan::checksums,
            save,
            media_url,
            check_folder,
            check_restore,
            check_report,
            service::service_status,
            service::service_install,
            service::service_uninstall,
            service::service_update,
            service::service_start,
            service::choose_folder
            $(, $extra)*
        ]
    };
}

/// Starts the app (on a phone, from its own entry point).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let media = if cfg!(target_os = "linux") {
        Media::Server(media::MediaServer::start().expect("the local media server could not start"))
    } else {
        Media::Asset
    };
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Roots::default())
        .manage(media);
    #[cfg(desktop)]
    let builder = builder.invoke_handler(commands![
        audio::audio_devices,
        audio::audio_configure,
        audio::audio_load,
        audio::audio_next,
        audio::audio_play,
        audio::audio_pause,
        audio::audio_seek,
        audio::audio_stop,
        audio::audio_status,
        audio::audio_spectrum
    ]);
    // The phone's native player and folders (E6b): the page drives the plugin directly
    // (src/lib/phone-audio.ts, src/lib/sources/phone.ts); Rust reads the folders' tags.
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(tauri_plugin_jackbird_player::init())
        .invoke_handler(commands![phone_inspect, phone_save]);
    #[cfg(target_os = "ios")]
    let builder = builder
        .plugin(tauri_plugin_jackbird_player::init())
        .invoke_handler(commands![]);
    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.manage(audio::Audio::start(app.handle().clone()));
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("jackbird")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(360.0, 480.0)
                    .build()?;
            }
            #[cfg(mobile)]
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into())).build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("jackbird could not start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_are_percent_decoded() {
        assert_eq!(decode_header("Jazz%2FSo%20What.mp3"), "Jazz/So What.mp3");
        assert_eq!(decode_header("%C3%B1and%C3%BA"), "ñandú");
        assert_eq!(decode_header("100%"), "100%");
    }
}
