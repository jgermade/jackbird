//! A song as jackbird adds it to an iPod: what it knows of an MP3, and the
//! records Apple's databases keep for it (the `iTunesCDB`'s `mhit` and its
//! `mhod`s, and the SQLite library's rows).
//!
//! The layout was read from the owner's nano 7G (`RECORD/2026-11-14.ipod-sync.WIP.md`,
//! N4a): every field of the 624-byte `mhit` header that varies between its 1,757
//! songs was matched to a column of the SQLite library, and the ones that do not
//! vary are set to the values all of them share. The iPodLinux wiki and libgpod's
//! documentation named the rest. What a new song cannot know (plays, skips,
//! ratings, artwork, gapless data, loudness) is left at "none".

use crate::chunk::{Body, Chunk};
use crate::library::Value;

/// Seconds from 1904-01-01 (the `mhit`'s epoch) to 1970-01-01.
pub const MAC_EPOCH_TO_UNIX: i64 = 2_082_844_800;
/// Seconds from 2001-01-01 (the SQLite library's epoch) to 1970-01-01.
pub const UNIX_TO_2001: i64 = 978_307_200;

/// The header length of an `mhit` as the nano 7G's firmware 1.0.4 has it.
pub const MHIT_HEADER: usize = 0x270;

/// `'MP3 '`, the file type of an MP3 in the `mhit` (`0x18`) and in `location.extension`.
pub const MP3: u32 = u32::from_be_bytes(*b"MP3 ");
/// `'F…'`, `location.location_type` for a file under `iPod_Control/Music`.
pub const LOCATION_FILE: i64 = 1_179_208_773;
/// `avformat_info.audio_format` for MPEG audio.
pub const AUDIO_FORMAT_MPEG: i64 = 301;

/// A moment, as Unix seconds and the local time's offset from UTC then: the
/// `mhit` keeps local time, the SQLite library UTC.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stamp {
    /// Seconds since 1970-01-01 UTC; 0 for none.
    pub unix: i64,
    /// The local offset from UTC at that moment, in seconds (3600 in Madrid's winter).
    pub offset: i32,
}

impl Stamp {
    /// Seconds since 1904, local time, as the `mhit` keeps them; 0 for none.
    pub fn mac(self) -> u32 {
        if self.unix == 0 {
            return 0;
        }
        u32::try_from(self.unix + MAC_EPOCH_TO_UNIX + i64::from(self.offset)).unwrap_or(0)
    }

    /// Seconds since 2001, UTC, as the SQLite library keeps them; 0 for none.
    pub fn since_2001(self) -> i64 {
        if self.unix == 0 { 0 } else { self.unix - UNIX_TO_2001 }
    }
}

/// What jackbird writes of a song. Strings are `None` when the file has none.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Song {
    /// Its 64-bit ID: `item.pid` and the `mhit`'s `0x70` and `0xA8`.
    pub pid: i64,
    /// Its ID in the `iTunesCDB` (`0x10`), which playlists' `mhip`s point to.
    pub track_id: u32,
    /// Title.
    pub title: Option<String>,
    /// Artist.
    pub artist: Option<String>,
    /// Album.
    pub album: Option<String>,
    /// Album artist.
    pub album_artist: Option<String>,
    /// Genre.
    pub genre: Option<String>,
    /// Composer.
    pub composer: Option<String>,
    /// Comment.
    pub comment: Option<String>,
    /// The sort forms: `None` sorts by the field itself.
    pub sort_title: Option<String>,
    /// Sort artist.
    pub sort_artist: Option<String>,
    /// Sort album.
    pub sort_album: Option<String>,
    /// Sort album artist.
    pub sort_album_artist: Option<String>,
    /// Sort composer.
    pub sort_composer: Option<String>,
    /// The file type as the device's language names it ("MPEG audio file",
    /// "Archivo de audio MPEG"): `location_kind_map.kind`.
    pub kind: String,
    /// The file under `iPod_Control/Music/`: `F24/STSM.mp3`.
    pub path: String,
    /// Size in bytes.
    pub size: u32,
    /// Length in milliseconds.
    pub length_ms: u32,
    /// Length in samples.
    pub samples: u64,
    /// Bit rate, kbit/s (the average, for VBR).
    pub bitrate: u32,
    /// Sample rate, Hz.
    pub sample_rate: u32,
    /// Whether its bit rate varies.
    pub vbr: bool,
    /// Track number, and the album's count of tracks.
    pub track_number: u32,
    /// The album's count of tracks.
    pub track_count: u32,
    /// Disc number.
    pub disc_number: u32,
    /// The count of discs.
    pub disc_count: u32,
    /// Year.
    pub year: u32,
    /// Beats per minute.
    pub bpm: u16,
    /// Whether it belongs to a compilation.
    pub compilation: bool,
    /// When its file was last changed.
    pub modified: Stamp,
    /// When it was added to the iPod.
    pub added: Stamp,
    /// Its album's ID in the `iTunesCDB` (`mhia`, `0x10`) and its pid (`album.pid`).
    pub album_id: u32,
    /// Its album's pid.
    pub album_pid: Option<i64>,
    /// Its album artist's ID in the `iTunesCDB` (`mhii`, `0x10`) and pid (`artist.pid`).
    pub artist_id: u32,
    /// Its album artist's pid.
    pub artist_pid: Option<i64>,
    /// `composer.pid`, 0 for none.
    pub composer_pid: i64,
    /// `genre_map.id`, 0 for none.
    pub genre_id: i64,
    /// Its cover's image in the `ArtworkDB` (`mhii` `0x10`), when it has one.
    pub artwork_id: Option<u32>,
}

/// The `mhod` types of a song's strings, in the order Apple writes them.
const MHOD_ORDER: [u32; 14] = [1, 4, 22, 12, 3, 5, 6, 8, 2, 27, 28, 23, 29, 30];

impl Song {
    /// The `mhod` string of each type, when the song has it. A sort form is
    /// written only when it differs from its field.
    fn strings(&self) -> Vec<(u32, String)> {
        let sort = |sort: &Option<String>, field: &Option<String>| sort_mhod(sort.as_deref(), field.as_deref());
        let location = format!(":iPod_Control:Music:{}", self.path.replace('/', ":"));
        MHOD_ORDER
            .iter()
            .filter_map(|&kind| {
                let value = match kind {
                    1 => self.title.clone(),
                    2 => Some(location.clone()),
                    3 => self.album.clone(),
                    4 => self.artist.clone(),
                    5 => self.genre.clone(),
                    6 => Some(self.kind.clone()),
                    8 => self.comment.clone(),
                    12 => self.composer.clone(),
                    22 => self.album_artist.clone(),
                    23 => sort(&self.sort_artist, &self.artist),
                    27 => sort(&self.sort_title, &self.title),
                    28 => sort(&self.sort_album, &self.album),
                    29 => sort(&self.sort_album_artist, &self.album_artist),
                    30 => sort(&self.sort_composer, &self.composer),
                    _ => None,
                };
                value.filter(|v| !v.is_empty()).map(|v| (kind, v))
            })
            .collect()
    }

    /// Its `mhit`, with its `mhod`s.
    pub fn mhit(&self) -> Chunk {
        let mut h = vec![0u8; MHIT_HEADER];
        let mut put = |at: usize, bytes: &[u8]| h[at..at + bytes.len()].copy_from_slice(bytes);
        let strings = self.strings();
        put(0x00, b"mhit");
        put(0x04, &(MHIT_HEADER as u32).to_le_bytes());
        put(0x0c, &(strings.len() as u32).to_le_bytes());
        put(0x10, &self.track_id.to_le_bytes());
        put(0x14, &1u32.to_le_bytes()); // visible
        put(0x18, &MP3.to_le_bytes());
        put(0x1c, &[u8::from(self.vbr), 1, u8::from(self.compilation), 0]);
        put(0x20, &self.modified.mac().to_le_bytes());
        put(0x24, &self.size.to_le_bytes());
        put(0x28, &self.length_ms.to_le_bytes());
        put(0x2c, &self.track_number.to_le_bytes());
        put(0x30, &self.track_count.to_le_bytes());
        put(0x34, &self.year.to_le_bytes());
        put(0x38, &self.bitrate.to_le_bytes());
        put(0x3c, &(self.sample_rate.min(0xffff) << 16).to_le_bytes());
        put(0x5c, &self.disc_number.to_le_bytes());
        put(0x60, &self.disc_count.to_le_bytes());
        put(0x68, &self.added.mac().to_le_bytes());
        put(0x70, &self.pid.to_le_bytes());
        put(0x7a, &self.bpm.to_le_bytes());
        put(0x7e, &0xffffu16.to_le_bytes());
        put(0x88, &(self.sample_rate as f32).to_le_bytes());
        put(0x90, &0x0cu16.to_le_bytes()); // MPEG audio (AAC has 0x33)
        // Artwork: 1 and the image's ID; 2 for none.
        put(0xa4, &[if self.artwork_id.is_some() { 1 } else { 2 }]);
        put(0x160, &self.artwork_id.unwrap_or(0).to_le_bytes());
        put(0xa8, &self.pid.to_le_bytes());
        put(0xb2, &2u16.to_le_bytes()); // not played yet
        put(0xbc, &self.samples.to_le_bytes());
        put(0xd0, &1u32.to_le_bytes()); // media type: audio
        put(0x100, &1u32.to_le_bytes());
        put(0x120, &self.album_id.to_le_bytes());
        put(0x124, &0x3d0c_5bf6u32.to_le_bytes());
        put(0x128, &0x3072_f3efu32.to_le_bytes());
        put(0x12c, &self.size.to_le_bytes());
        put(0x134, &[0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
        put(0x168, &1u32.to_le_bytes());
        put(0x1e0, &self.artist_id.to_le_bytes());
        put(0x1f4, &self.track_id.wrapping_add(1).to_le_bytes());
        put(0x20c, &2u32.to_le_bytes());
        Chunk {
            header: h,
            body: Body::Children(
                strings
                    .into_iter()
                    .map(|(kind, text)| mhod_string(kind, &text))
                    .collect(),
            ),
        }
    }

    /// Its row in `item` (`Library.itdb`), as columns and values. The ranks
    /// (`*_order`) are set by the library around it, and what the post-process
    /// computes (`track_artist_pid`, `physical_order`, `has_lyrics`) is left to it.
    pub fn item_row(&self) -> Vec<(&'static str, Value)> {
        let text = |s: &Option<String>| s.clone().map_or(Value::Null, Value::Text);
        let sort = |sort: &Option<String>, field: &Option<String>| {
            sort_column(sort.as_deref(), field.as_deref()).map_or(Value::Null, Value::Text)
        };
        let pid = |p: Option<i64>| p.map_or(Value::Null, Value::Integer);
        let int = |v: u32| Value::Integer(i64::from(v));
        vec![
            ("pid", Value::Integer(self.pid)),
            ("media_kind", Value::Integer(1)),
            ("is_song", Value::Integer(1)),
            ("date_modified", Value::Integer(self.modified.since_2001())),
            ("year", int(self.year)),
            ("is_compilation", Value::Integer(i64::from(self.compilation))),
            (
                "artwork_status",
                Value::Integer(if self.artwork_id.is_some() { 1 } else { 2 }),
            ),
            (
                "artwork_cache_id",
                Value::Integer(i64::from(self.artwork_id.unwrap_or(0))),
            ),
            ("total_time_ms", Value::Real(f64::from(self.length_ms))),
            ("track_number", int(self.track_number)),
            ("track_count", int(self.track_count)),
            ("disc_number", int(self.disc_number)),
            ("disc_count", int(self.disc_count)),
            ("bpm", Value::Integer(i64::from(self.bpm))),
            ("genre_id", Value::Integer(self.genre_id)),
            ("album_pid", pid(self.album_pid)),
            ("artist_pid", pid(self.artist_pid)),
            ("composer_pid", Value::Integer(self.composer_pid)),
            ("title", text(&self.title)),
            ("artist", text(&self.artist)),
            ("album", text(&self.album)),
            ("album_artist", text(&self.album_artist)),
            ("composer", text(&self.composer)),
            ("sort_title", sort(&self.sort_title, &self.title)),
            ("sort_artist", sort(&self.sort_artist, &self.artist)),
            ("sort_album", sort(&self.sort_album, &self.album)),
            ("sort_album_artist", sort(&self.sort_album_artist, &self.album_artist)),
            ("sort_composer", sort(&self.sort_composer, &self.composer)),
            ("series_name_order", Value::Integer(100)),
            ("comment", text(&self.comment)),
        ]
    }

    /// Its row in `avformat_info` (`Library.itdb`).
    pub fn avformat_row(&self) -> Vec<(&'static str, Value)> {
        vec![
            ("item_pid", Value::Integer(self.pid)),
            ("sub_id", Value::Integer(0)),
            ("audio_format", Value::Integer(AUDIO_FORMAT_MPEG)),
            ("bit_rate", Value::Integer(i64::from(self.bitrate))),
            ("sample_rate", Value::Real(f64::from(self.sample_rate))),
            (
                "duration",
                Value::Integer(i64::try_from(self.samples).unwrap_or(i64::MAX)),
            ),
        ]
    }

    /// Its row in `location` (`Locations.itdb`), for the file kind `kind_id`
    /// of `location_kind_map`.
    pub fn location_row(&self, kind_id: i64) -> Vec<(&'static str, Value)> {
        vec![
            ("item_pid", Value::Integer(self.pid)),
            ("sub_id", Value::Integer(0)),
            ("base_location_id", Value::Integer(1)),
            ("location_type", Value::Integer(LOCATION_FILE)),
            ("location", Value::Text(self.path.clone())),
            ("extension", Value::Integer(i64::from(MP3))),
            ("kind_id", Value::Integer(kind_id)),
            ("date_created", Value::Integer(self.added.since_2001())),
            ("file_size", Value::Integer(i64::from(self.size))),
        ]
    }

    /// Its row in `item_stats` (`Dynamic.itdb`): never played.
    pub fn stats_row(&self) -> Vec<(&'static str, Value)> {
        vec![("item_pid", Value::Integer(self.pid))]
    }
}

/// The leading articles Apple's Music app (in Spanish, on the owner's Mac)
/// sorts without: English's and Spanish's, not French's, Italian's or
/// German's (`Le`, `Il` and `Die` were kept on the owner's nano).
const ARTICLES: [&str; 10] = ["the", "a", "an", "el", "la", "los", "las", "lo", "un", "una"];

/// `text` without what leads it and is not a letter or a digit (`¿`, `#`, `...`, `(`).
fn without_leading_marks(text: &str) -> &str {
    text.trim_start_matches(|c: char| !c.is_alphanumeric())
}

/// `text` without a leading article and the space after it, or `None` when
/// it does not start with one (or is nothing else).
fn without_article(text: &str) -> Option<&str> {
    let (word, rest) = text.split_once(' ')?;
    (ARTICLES.iter().any(|a| word.eq_ignore_ascii_case(a)) && !rest.trim().is_empty()).then_some(rest)
}

/// What a field sorts by in the SQLite library (`item.sort_*`): its explicit
/// sort form if it has one, else the field itself; then without leading marks
/// and a leading article (marks before it too: `- Los De Siempre` sorts as
/// `De Siempre`), as Apple's rows on the owner's nano show.
pub fn sort_column(sort: Option<&str>, field: Option<&str>) -> Option<String> {
    let base = sort.or(field)?;
    let unmarked = without_leading_marks(base);
    let out = without_article(unmarked).map_or(unmarked, without_leading_marks);
    Some(out.to_string())
}

/// The sort `mhod` a field gets in the `iTunesCDB`: its explicit sort form
/// when it differs from the field; else the field without its leading article,
/// when it has one. Leading marks alone give none (`¿Qué Me Das` has no sort
/// `mhod`, though its row sorts as `Qué Me Das`).
pub fn sort_mhod(sort: Option<&str>, field: Option<&str>) -> Option<String> {
    match (sort, field) {
        (Some(s), f) if Some(s) != f => Some(s.to_string()),
        (_, Some(f)) => {
            let unmarked = without_leading_marks(f);
            without_article(unmarked).map(|rest| without_leading_marks(rest).to_string())
        }
        _ => None,
    }
}

/// A string `mhod` as the nano 7G's databases have them: UTF-16LE, with
/// `1, length, 1, 0` before the text.
pub fn mhod_string(kind: u32, text: &str) -> Chunk {
    let utf16: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut header = Vec::with_capacity(24);
    header.extend_from_slice(b"mhod");
    header.extend_from_slice(&24u32.to_le_bytes());
    header.extend_from_slice(&0u32.to_le_bytes()); // set on writing
    header.extend_from_slice(&kind.to_le_bytes());
    header.extend_from_slice(&[0; 8]);
    let mut body = Vec::with_capacity(16 + utf16.len());
    body.extend_from_slice(&1u32.to_le_bytes());
    body.extend_from_slice(&(utf16.len() as u32).to_le_bytes());
    body.extend_from_slice(&1u32.to_le_bytes());
    body.extend_from_slice(&0u32.to_le_bytes());
    body.extend(utf16);
    Chunk {
        header,
        body: Body::Raw(body),
    }
}

/// The fields of an `mhit` header a new song leaves at "none" though Apple's
/// may hold something there, by offset and length, with what they are: the
/// check against a device's songs skips them.
pub const MHIT_NOT_KNOWN: [(usize, usize, &str); 23] = [
    (0x08, 4, "total length (set on writing)"),
    (0x1f, 1, "rating"),
    (0x4c, 4, "Sound Check (loudness)"),
    (0x50, 8, "play count"),
    (0x58, 4, "last played"),
    (0x78, 2, "checked, application rating"),
    (0x7c, 2, "artwork count"),
    (0x80, 4, "artwork size"),
    (0x8c, 4, "date released"),
    (0x92, 2, "unknown flag"),
    (0x98, 8, "skip count"),
    (0xa0, 4, "last skipped"),
    (0xa4, 1, "has artwork"),
    (0xb0, 2, "has lyrics"),
    (0xb2, 2, "played"),
    (0xb8, 4, "gapless: encoder delay"),
    (0xc4, 4, "unknown ID"),
    (0xc8, 8, "gapless: encoder drain, heuristic"),
    (0xf8, 8, "gapless: last frame resync"),
    (0x134, 6, "unknown flags"),
    (0x160, 4, "artwork cache ID"),
    (0x194, 4, "unknown flag"),
    (
        0x1f4,
        4,
        "an ID given after the song's: its ID + 1 for most, + 3 for some",
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    fn song() -> Song {
        Song {
            pid: -6_450_187_065_278_421_731,
            track_id: 303,
            title: Some("A Barraca".into()),
            artist: Some("The Someones".into()),
            sort_artist: None,
            album: Some("Album".into()),
            sort_album: None,
            genre: Some("Rock".into()),
            kind: "MPEG audio file".into(),
            path: "F24/ABCD.mp3".into(),
            size: 6_075_137,
            length_ms: 262_000,
            samples: 11_554_200,
            bitrate: 192,
            sample_rate: 44_100,
            track_number: 3,
            year: 2005,
            modified: Stamp {
                unix: 1_700_000_000,
                offset: 3600,
            },
            added: Stamp {
                unix: 1_760_000_000,
                offset: 7200,
            },
            album_id: 37,
            artist_id: 154,
            ..Song::default()
        }
    }

    #[test]
    fn mhit_layout() {
        let s = song();
        let chunk = s.mhit();
        let bytes = chunk.write().unwrap();
        let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        assert_eq!(&bytes[..4], b"mhit");
        assert_eq!(u32_at(4), 0x270);
        assert_eq!(u32_at(8) as usize, bytes.len());
        // Title, artist, album, genre, kind, location, sort title, sort artist.
        assert_eq!(u32_at(0x0c), 8);
        assert_eq!(u32_at(0x10), 303);
        assert_eq!(u32_at(0x1f4), 304);
        assert_eq!(u32_at(0x20), (1_700_000_000 + MAC_EPOCH_TO_UNIX + 3600) as u32);
        assert_eq!(u32_at(0x3c), 44_100 << 16);
        assert_eq!(f32::from_le_bytes(bytes[0x88..0x8c].try_into().unwrap()), 44_100.0);
        assert_eq!(i64::from_le_bytes(bytes[0x70..0x78].try_into().unwrap()), s.pid);
        assert_eq!(bytes[0x70..0x78], bytes[0xa8..0xb0]);
        // Read back by the reader that lists a device's songs.
        let db = crate::db::tests::database_with_tracks(std::slice::from_ref(&bytes));
        let parsed = crate::db::parse(&db).unwrap();
        assert_eq!(parsed.tracks[0].title.as_deref(), Some("A Barraca"));
        assert_eq!(
            parsed.tracks[0].path().as_deref(),
            Some("iPod_Control/Music/F24/ABCD.mp3")
        );
        assert_eq!(parsed.tracks[0].database_id, s.pid as u64);
    }

    #[test]
    fn sort_forms_as_apple_makes_them() {
        let column = |f: &str| sort_column(None, Some(f)).unwrap();
        let mhod = |f: &str| sort_mhod(None, Some(f));
        assert_eq!(column("The Curse"), "Curse");
        assert_eq!(mhod("The Curse").as_deref(), Some("Curse"));
        assert_eq!(column("Los Canallas"), "Canallas");
        assert_eq!(column("the BLOODHOUNDGANG"), "BLOODHOUNDGANG");
        assert_eq!(column("A Fuego"), "Fuego");
        assert_eq!(column("#1 Zero"), "1 Zero");
        assert_eq!(mhod("#1 Zero"), None);
        assert_eq!(column("¿Qué Me Das"), "Qué Me Das");
        assert_eq!(mhod("¿Qué Me Das"), None);
        assert_eq!(column("...And Justice for All"), "And Justice for All");
        assert_eq!(column("- Los De Siempre"), "De Siempre");
        assert_eq!(mhod("- Los De Siempre").as_deref(), Some("De Siempre"));
        assert_eq!(column("Le Vent"), "Le Vent");
        assert_eq!(column("The"), "The");
        assert_eq!(column("Theatre"), "Theatre");
        // An explicit sort form wins, and gets its mhod when it differs.
        assert_eq!(
            sort_column(Some("Beatles, The"), Some("The Beatles")).as_deref(),
            Some("Beatles, The")
        );
        assert_eq!(
            sort_mhod(Some("Beatles, The"), Some("The Beatles")).as_deref(),
            Some("Beatles, The")
        );
        assert_eq!(sort_mhod(Some("Audioslave"), Some("Audioslave")), None);
        assert_eq!(sort_column(None, None), None);
    }

    #[test]
    fn sort_forms_only_when_they_differ() {
        let types: Vec<u32> = song().strings().into_iter().map(|(t, _)| t).collect();
        assert_eq!(types, [1, 4, 3, 5, 6, 2, 27, 23]);
    }

    #[test]
    fn rows() {
        let s = song();
        let item = s.item_row();
        let get = |row: &[(&str, Value)], c: &str| row.iter().find(|(n, _)| *n == c).unwrap().1.clone();
        assert_eq!(get(&item, "sort_title"), Value::Text("Barraca".into()));
        assert_eq!(get(&item, "sort_album"), Value::Text("Album".into()));
        assert_eq!(get(&item, "sort_artist"), Value::Text("Someones".into()));
        assert_eq!(get(&item, "album_pid"), Value::Null);
        assert_eq!(
            get(&item, "date_modified"),
            Value::Integer(1_700_000_000 - UNIX_TO_2001)
        );
        let location = s.location_row(1);
        assert_eq!(get(&location, "location"), Value::Text("F24/ABCD.mp3".into()));
        assert_eq!(get(&location, "extension"), Value::Integer(1_297_101_600));
        assert_eq!(get(&s.avformat_row(), "duration"), Value::Integer(11_554_200));
        assert_eq!(Stamp::default().mac(), 0);
        assert_eq!(Stamp::default().since_2001(), 0);
    }
}
