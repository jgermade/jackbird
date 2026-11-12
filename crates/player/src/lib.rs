//! jackbird's native side on the phones (E6b, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md,
//! 2026-11-11 and after), on Android: Media3's ExoPlayer in a `MediaSessionService` (`android/`),
//! which keeps a queue playing with the app in the background, with its notification and the lock
//! screen's controls; bit-perfect output to a USB DAC; and the folders the person chose in Android's
//! folder picker. The page calls the Kotlin plugin's commands directly (`plugin:jackbird-player|…`).
//! Rust asks it for one thing the page may not: a file of those folders, opened, its descriptor
//! handed over (`open_file`). On the desktop, which has E5's output, and on iOS (E6b's last step), it
//! registers nothing.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Runtime};

/// The Kotlin plugin, as Rust reaches it (Android).
#[cfg(target_os = "android")]
struct Plugin<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// The plugin, as the app registers it on a phone.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("jackbird-player")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = api.register_android_plugin("es.germade.jackbird.player", "PlayerPlugin")?;
                _app.manage(Plugin(handle));
            }
            #[cfg(not(target_os = "android"))]
            let _ = api;
            Ok(())
        })
        .build()
}

/// Opens a file of a folder the person chose (its tree's `content://` address and its path in it),
/// for reading or for writing its tags in place, and gives its descriptor's number: the caller owns
/// the descriptor from then on, and closes it. Android only; blocks until the plugin answers.
pub fn open_file<R: Runtime>(app: &AppHandle<R>, tree: &str, path: &str, write: bool) -> Result<i32, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        #[derive(serde::Deserialize)]
        struct Opened {
            fd: i32,
        }
        let plugin = app.try_state::<Plugin<R>>().ok_or("the phone's plugin is not there")?;
        plugin
            .0
            .run_mobile_plugin::<Opened>(
                "folderDetach",
                serde_json::json!({ "tree": tree, "path": path, "write": write }),
            )
            .map(|opened| opened.fd)
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, tree, path, write);
        Err("only on Android".into())
    }
}
