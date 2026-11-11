//! jackbird's native player on the phones (E6b, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md,
//! 2026-11-11): on Android, Media3's ExoPlayer in a `MediaSessionService` (`android/`), which keeps
//! a queue playing with the app in the background, with its notification and the lock screen's
//! controls. The page calls the Kotlin plugin's commands directly (`plugin:jackbird-player|…`) and
//! hears its events (`src/lib/phone-audio.ts`); nothing passes through Rust. On the desktop, which
//! has E5's output, and on iOS (E6b's step 2), it registers nothing.

use tauri::Runtime;
use tauri::plugin::{Builder, TauriPlugin};

/// The plugin, as the app registers it on a phone.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("jackbird-player")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            api.register_android_plugin("es.germade.jackbird.player", "PlayerPlugin")?;
            #[cfg(not(target_os = "android"))]
            let _ = api;
            Ok(())
        })
        .build()
}
