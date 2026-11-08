// No console window on Windows in a release build.
//! The desktop app's entry: `jackbird_lib::run`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    jackbird_lib::run()
}
