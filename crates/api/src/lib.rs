//! The JSON jackbird's interface and its Rust side speak, the same over Tauri's IPC (the desktop
//! app, `src-tauri/`) and over HTTP (the service, `crates/service`), so the two cannot drift
//! (S1-D1, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-08 17:43). The interface's
//! side is `src/lib/sources/desktop.ts` and `service.ts`, and `TrackMetadata` in `src/types.ts`.

use jackbird_core::{Entry, Error, Inspection, Stat, Sums, Tagged};
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
    /// The disc number, `n` or `n/total`. Absent in what an older interface or `.meta/` sends.
    #[serde(default)]
    pub disc_number: String,
    /// The album's artist.
    #[serde(default)]
    pub album_artist: String,
    /// Part of a compilation: `1`, or as the file holds it; empty when not.
    #[serde(default)]
    pub compilation: String,
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

/// A cover's name, as `coverName` (`src/helpers/cover.ts`) makes it: two 32-bit FNV-1a hashes of
/// its bytes (one from the standard offset, one from another), its length, in hex, and its type's
/// extension. The interface keeps each picture once by this name (`src/lib/covers.ts`).
pub fn cover_name(cover: &Cover) -> String {
    let (mut one, mut two) = (0x811c_9dc5_u32, 0x0100_0193_u32 ^ 0x5bd1_e995);
    for byte in &cover.data {
        one = (one ^ u32::from(*byte)).wrapping_mul(0x0100_0193);
        two = (two ^ u32::from(*byte)).wrapping_mul(0x0100_0193);
    }
    let mime = if cover.mime.is_empty() {
        "image/jpeg".to_string()
    } else {
        cover.mime.to_lowercase()
    };
    let extension = match mime.as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => "img",
    };
    format!("{one:08x}{two:08x}-{:x}.{extension}", cover.data.len())
}

/// A reference to a cover by its name, as the library holds it in place of the picture.
pub fn cover_ref(name: &str) -> String {
    format!("jackbird-cover:{name}")
}

/// The tags as the interface keeps them, the cover a data URL (`with_cover`) or none.
fn metadata_of(fields: jackbird_tags::Fields, cover_data_url: Option<String>) -> Metadata {
    Metadata {
        title: fields.title,
        artist: fields.artist,
        album: fields.album,
        year: fields.year,
        genre: fields.genre,
        track_number: fields.track,
        disc_number: fields.disc,
        album_artist: fields.album_artist,
        compilation: fields.compilation,
        cover_data_url,
    }
}

/// A file as the desktop app's scan reads it (`scan` in `src-tauri/`): its size, date and tags, the
/// cover by reference; no checksum yet.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedJson {
    /// Its path under the root.
    pub path: String,
    /// Its size in bytes.
    pub size: u64,
    /// When it last changed, in milliseconds since 1970.
    pub last_modified: u64,
    /// Its tags, the cover a reference to one of the batch's `covers` or to one the interface has.
    pub metadata: Metadata,
}

/// A cover, the first time a scan meets it: its name and its bytes in base64.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverJson {
    /// Its name ([`cover_name`]).
    pub name: String,
    /// Its bytes, in base64.
    pub data: String,
}

/// A file's tags as the scan gives them, and its cover's name and the cover itself.
pub fn scanned(path: String, tagged: Tagged) -> (ScannedJson, Option<(String, Cover)>) {
    let (fields, cover) = tagged.tags;
    let named = cover.map(|cover| (cover_name(&cover), cover));
    let json = ScannedJson {
        path,
        size: tagged.stat.size,
        last_modified: tagged.stat.mtime,
        metadata: metadata_of(fields, named.as_ref().map(|(name, _)| cover_ref(name))),
    };
    (json, named)
}

/// A file's checksums as the scan's second half gives them, with its size and date then.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SumsJson {
    /// Its path under the root.
    pub path: String,
    /// Its size in bytes.
    pub size: u64,
    /// When it last changed, in milliseconds since 1970.
    pub last_modified: u64,
    /// The SHA-1 of the whole file.
    pub full_checksum: String,
    /// The SHA-1 of its audio region.
    pub audio_checksum: String,
}

impl SumsJson {
    /// The checksums of the file at `path`.
    pub fn of(path: String, sums: Sums) -> Self {
        SumsJson {
            path,
            size: sums.stat.size,
            last_modified: sums.stat.mtime,
            full_checksum: sums.full_checksum,
            audio_checksum: sums.audio_checksum,
        }
    }
}

/// A file the scan could not read, and why.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadJson {
    /// Its path under the root.
    pub path: String,
    /// What went wrong.
    pub message: String,
}

impl From<Inspection> for InspectionJson {
    fn from(found: Inspection) -> Self {
        InspectionJson {
            size: found.stat.size,
            last_modified: found.stat.mtime,
            full_checksum: found.full_checksum,
            audio_checksum: found.audio_checksum,
            metadata: found.tags.map(|(fields, cover)| {
                metadata_of(
                    fields,
                    cover.map(|cover| {
                        let mime = if cover.mime.is_empty() {
                            "image/jpeg"
                        } else {
                            &cover.mime
                        };
                        format!("data:{mime};base64,{}", jackbird_core::base64_encode(&cover.data))
                    }),
                )
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
/// `editFor` (`src/helpers/cover.ts`) makes it in the browser: the six first fields whole, and
/// the disc, the album artist and the compilation only when they changed (a library read before
/// they were known holds them empty, which must not empty the file's).
pub fn edit_for(previous: &Metadata, metadata: Metadata) -> Edit {
    let changed = |before: &String, now: String| (*before != now).then_some(now);
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
        disc: changed(&previous.disc_number, metadata.disc_number),
        album_artist: changed(&previous.album_artist, metadata.album_artist),
        compilation: changed(&previous.compilation, metadata.compilation),
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
            disc_number: "1/2".into(),
            album_artist: String::new(),
            compilation: String::new(),
            cover_data_url: cover.map(Into::into),
        }
    }

    /// The same vectors as `coverName`'s test (`src/helpers/cover.test.ts`): both sides name a picture alike.
    #[test]
    fn cover_name_is_the_interfaces() {
        let named = |mime: &str, data: &[u8]| {
            cover_name(&Cover {
                data: data.to_vec(),
                mime: mime.into(),
            })
        };
        assert_eq!(named("image/png", &[1, 2]), "ed74208a24b98405-2.png");
        assert_eq!(named("image/jpeg", b"jackbird"), "d79105f5ef3292ca-8.jpg");
        assert_eq!(named("", &[]), "811c9dc55ad1e806-0.jpg");
        assert_eq!(named("IMAGE/JPEG", &[1, 2, 3]), named("image/jpeg", &[1, 2, 3]));
        assert!(named("image/x-odd", &[7]).ends_with(".img"));
        assert_eq!(cover_ref("a.jpg"), "jackbird-cover:a.jpg");
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
        assert_eq!((edit.disc, edit.album_artist, edit.compilation), (None, None, None));
        let edit = edit_for(
            &metadata(None),
            Metadata {
                disc_number: String::new(),
                compilation: "1".into(),
                ..metadata(None)
            },
        );
        assert_eq!(
            (edit.disc.as_deref(), edit.compilation.as_deref()),
            (Some(""), Some("1"))
        );
        assert_eq!(edit.album_artist, None);
        assert_eq!(cover_of("data:;base64,AQ==").unwrap().mime, "image/jpeg");
        assert_eq!(cover_of("data:image/png;name=a;base64,AQ==").unwrap().mime, "image/png");
        assert!(cover_of("data:image/png,raw").is_none());
    }
}
