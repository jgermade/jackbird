//! jackbird's native core, for the desktop app (`src-tauri/`, E4) and, later,
//! the service (S1): the folders a person opened (roots) and the files under
//! them, reached by path; tags and checksums that read only what they need;
//! saves that write the new tags in place, or a new file beside the old one,
//! never holding the audio in memory. No Tauri, no HTTP: those wrap it. It is
//! the one crate that touches the file system (`AGENTS.md`). See
//! `RECORD/2026-08-11.musikmatch-rust-migration.WIP.md` (E4-D3, E4-D4, 13:55).

mod b64;
mod files;
mod root;

pub use b64::{decode as base64_decode, encode as base64_encode};
pub use files::{Examined, Inspection, Saved, examine, head_of, inspect, inspect_open, save, save_open};
pub use root::{Entry, Error, Root, Stat};

#[cfg(test)]
mod tests;
