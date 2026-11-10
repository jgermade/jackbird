//! The native output (E5, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-09 19:37
//! and after): `jackbird-audio`'s player behind commands, playing files of the open roots by their
//! path, and its events sent to the interface as `audio` events. The interface's side is
//! `src/lib/native-audio.ts`; it falls back to the webview's `<audio>` for a song the player
//! cannot play.

use jackbird_api::{Failure, failure};
use jackbird_audio::{DeviceInfo, DeviceOutput, Output, Player, Settings, Status};
use jackbird_core::Root;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::{Roots, root_of};

/// The player, made when the app starts (nothing is opened until a song plays).
pub struct Audio(Player);

impl Audio {
    /// A player whose events go to the interface.
    pub fn start(app: AppHandle) -> Audio {
        let outputs = Box::new(|settings: &Settings| Box::new(DeviceOutput::new(settings)) as Box<dyn Output>);
        Audio(Player::new(outputs, Settings::default(), move |event| {
            let _ = app.emit("audio", event);
        }))
    }
}

/// A file under a root: one the app opened, or a folder of its own service (S2), on this machine
/// too, which the app may open as it reopens its session's folders.
fn file(roots: &State<'_, Roots>, root: &str, path: &str) -> Result<std::path::PathBuf, Failure> {
    let root = match root_of(roots, root) {
        Ok(root) => root,
        Err(_) => Root::open(root).map_err(Failure::from)?,
    };
    root.resolve(path).map_err(Failure::from)
}

/// The devices to choose from.
#[tauri::command]
pub async fn audio_devices() -> Result<Vec<DeviceInfo>, Failure> {
    tauri::async_runtime::spawn_blocking(jackbird_audio::devices)
        .await
        .map_err(|error| failure("io", error.to_string()))
}

/// The output's mode and device.
#[tauri::command]
pub fn audio_configure(audio: State<'_, Audio>, settings: Settings) {
    audio.0.configure(settings);
}

/// Plays a file of an open root (the interface's `key` for it) from `at` seconds, or loads it paused.
#[tauri::command]
pub fn audio_load(
    audio: State<'_, Audio>,
    roots: State<'_, Roots>,
    root: String,
    path: String,
    key: String,
    at: f64,
    play: bool,
) -> Result<(), Failure> {
    audio.0.load(&file(&roots, &root, &path)?, &key, at, play);
    Ok(())
}

/// The song after it (none: the queue ends there).
#[tauri::command]
pub fn audio_next(
    audio: State<'_, Audio>,
    roots: State<'_, Roots>,
    root: Option<String>,
    path: Option<String>,
    key: Option<String>,
) -> Result<(), Failure> {
    match (root, path, key) {
        (Some(root), Some(path), Some(key)) => {
            let file = file(&roots, &root, &path)?;
            audio.0.set_next(Some((&file, &key)));
        }
        _ => audio.0.set_next(None),
    }
    Ok(())
}

#[tauri::command]
pub fn audio_play(audio: State<'_, Audio>) {
    audio.0.play();
}

#[tauri::command]
pub fn audio_pause(audio: State<'_, Audio>) {
    audio.0.pause();
}

#[tauri::command]
pub fn audio_seek(audio: State<'_, Audio>, seconds: f64) {
    audio.0.seek(seconds);
}

#[tauri::command]
pub fn audio_stop(audio: State<'_, Audio>) {
    audio.0.stop();
}

#[tauri::command]
pub fn audio_status(audio: State<'_, Audio>) -> Status {
    audio.0.status()
}

/// The spectrum's bins and the rate they were taken at.
#[derive(Serialize)]
pub struct SpectrumJson {
    bins: Vec<u8>,
    rate: u32,
}

#[tauri::command]
pub fn audio_spectrum(audio: State<'_, Audio>) -> Option<SpectrumJson> {
    audio.0.spectrum().map(|(bins, rate)| SpectrumJson { bins, rate })
}
