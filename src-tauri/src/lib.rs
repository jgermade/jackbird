//! E0's Tauri v2 shell (RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 18:35): today's web
//! build in the main window, as it is, and the E0 check in a second one, which plays audio files
//! from disk through the asset protocol and a Web Audio analyser.
//!
//! An unattended run: `JACKBIRD_E0_FILES` (paths separated by `|`) makes the check window play
//! them without a click; each window then reports once as a line of JSON, printed and appended to
//! `JACKBIRD_E0_REPORT` when set; with `JACKBIRD_E0_EXIT` the app quits once both are in.
//! `e0/run-check.mjs` drives it.

use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// Reports from both windows end an unattended run.
const WINDOWS: usize = 2;
static REPORTS: AtomicUsize = AtomicUsize::new(0);

/// Runs in the main window before the app: catches its errors and reports whether jq79 drew it.
const MAIN_PROBE: &str = include_str!("../e0/main-probe.js");

/// The files to check without a click, if any.
#[tauri::command]
fn e0_files() -> Vec<String> {
    std::env::var("JACKBIRD_E0_FILES")
        .map(|value| value.split('|').filter(|path| !path.is_empty()).map(String::from).collect())
        .unwrap_or_default()
}

/// A base URL that serves the same files over HTTP, if the run has one (`JACKBIRD_E0_HTTP`):
/// the check also plays them from there, to compare with the asset protocol.
#[tauri::command]
fn e0_http_base() -> Option<String> {
    std::env::var("JACKBIRD_E0_HTTP").ok()
}

/// One window's report, as a line of JSON.
#[tauri::command]
fn e0_report(app: AppHandle, report: String) {
    println!("E0-REPORT {report}");
    if let Ok(path) = std::env::var("JACKBIRD_E0_REPORT") {
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{report}");
        }
    }
    if REPORTS.fetch_add(1, Ordering::SeqCst) + 1 >= WINDOWS && std::env::var_os("JACKBIRD_E0_EXIT").is_some() {
        app.exit(0);
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![e0_files, e0_http_base, e0_report])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("jackbird")
                .inner_size(1280.0, 800.0)
                .min_inner_size(360.0, 480.0)
                .initialization_script(MAIN_PROBE)
                .build()?;
            WebviewWindowBuilder::new(app, "check", WebviewUrl::App("e0-check.html".into()))
                .title("jackbird — E0 check")
                .inner_size(760.0, 680.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("jackbird could not start");
}
