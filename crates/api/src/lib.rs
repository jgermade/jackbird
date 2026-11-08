//! The JSON jackbird's interface and its Rust side speak, the same over Tauri's IPC (the desktop
//! app, `src-tauri/`) and over HTTP (the service, `crates/service`), so the two cannot drift
//! (S1-D1, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-08 17:43). The interface's
//! side is `src/lib/sources/desktop.ts` and `service.ts`, and `TrackMetadata` in `src/types.ts`.

use jackbird_core::{Entry, Error, Inspection, Stat};
use jackbird_tags::{Cover, CoverEdit, Edit};
use serde::{Deserialize, Serialize};

/// An error as the interface gets it: a code for its texts, and a message.
#[derive(Serialize)]
pub struct Failure {
    /// A stable code: the tag engine's, or `jackbird-core`'s (`outside`, `not-found`, `io`…).
    pub code: String,
    /// What happened, in English.
    pub message: String,
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Failure {
            code: error.code().into(),
            message: error.to_string(),
        }
    }
}

/// A failure with this code.
pub fn failure(code: &str, message: impl Into<String>) -> Failure {
    Failure {
        code: code.into(),
        message: message.into(),
    }
}

/// A root just opened: its path, and its name for its tab.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    /// Its path, as the interface names it.
    pub path: String,
    /// Its folder's name.
    pub name: String,
}

/// A file's or folder's stat, as vfs-sync's `VFSStat`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatJson {
    /// `file` or `directory`.
    pub kind: &'static str,
    /// Its size in bytes.
    pub size: u64,
    /// When it last changed, in milliseconds since 1970.
    pub mtime: u64,
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

/// An entry of a listing or a walk, as vfs-sync's `VFSListEntry`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryJson {
    /// Its name.
    pub name: String,
    /// Its path relative to the root.
    pub path: String,
    /// Its stat.
    pub stat: StatJson,
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

/// The tags as the interface keeps them (`TrackMetadata`), the cover a data URL.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    /// The title.
    pub title: String,
    /// The artist.
    pub artist: String,
    /// The album.
    pub album: String,
    /// The year, or a date.
    pub year: String,
    /// The genre.
    pub genre: String,
    /// The track number, `n` or `n/total`.
    pub track_number: String,
    /// The cover, as a data URL.
    pub cover_data_url: Option<String>,
}

/// A file as `inspect` and `save` find it (`Inspection` in `src/types.ts`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionJson {
    /// Its size in bytes.
    pub size: u64,
    /// When it last changed, in milliseconds since 1970.
    pub last_modified: u64,
    /// The SHA-1 of the whole file.
    pub full_checksum: String,
    /// The SHA-1 of its audio region.
    pub audio_checksum: String,
    /// Its tags, unless they were not read again.
    pub metadata: Option<Metadata>,
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

/// A data URL's picture, or `None` when it is not a base64 data URL.
pub fn cover_of(url: &str) -> Option<Cover> {
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
pub fn edit_for(previous: &Metadata, metadata: Metadata) -> Edit {
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
}
