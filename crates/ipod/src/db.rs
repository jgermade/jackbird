//! The tracks and playlists of an `iTunesDB`, the database the iPod's
//! firmware reads (an `iTunesCDB` is inflated first, by [`crate::cdb`]).
//!
//! The layout, as the iPodLinux wiki documents it: every chunk starts with a
//! four-byte name, its header's length and (for most) its total length,
//! little-endian.
//!
//! ```text
//! mhbd                       the database
//!   mhsd type 1              tracks
//!     mhlt                   (count)
//!       mhit …               a track, then its mhod strings
//!   mhsd type 2 or 3         playlists (3: the podcast-aware copy iTunes writes for newer iPods)
//!     mhlp                   (count)
//!       mhyp …               a playlist, its mhods, then its mhip items
//!   mhsd type 4, 5, …        albums, smart playlists: skipped here
//! ```

use crate::Error;
use crate::bytes::{array, len_at, u8_at, u16_at, u32_at, u64_at};

/// A database's header and what it lists.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Database {
    /// The format's version (`mhbd`, `0x10`).
    pub version: u32,
    /// The database's own ID (`mhbd`, `0x18`).
    pub database_id: u64,
    /// The checksum scheme the header names (`mhbd`, `0x30`; 0 when the header
    /// is too short to hold it). See [`crate::device::Checksum::from_scheme`].
    pub checksum_scheme: u16,
    /// The tracks, in the database's order.
    pub tracks: Vec<Track>,
    /// The playlists, the master playlist (every track) first as iTunes writes it.
    pub playlists: Vec<Playlist>,
}

/// A track (`mhit`). A number is 0 and a string is `None` when the database
/// leaves it out.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Track {
    /// The ID playlists refer to it by (`0x10`).
    pub id: u32,
    /// Its 64-bit database ID (`0x70`), which the SQLite library of the nano 6G
    /// and 7G and the artwork database use.
    pub database_id: u64,
    /// Title (`mhod` 1).
    pub title: Option<String>,
    /// Artist (`mhod` 4).
    pub artist: Option<String>,
    /// Album (`mhod` 3).
    pub album: Option<String>,
    /// Album artist (`mhod` 22).
    pub album_artist: Option<String>,
    /// Genre (`mhod` 5).
    pub genre: Option<String>,
    /// Composer (`mhod` 12).
    pub composer: Option<String>,
    /// The file type as iTunes names it, such as "MPEG audio file" (`mhod` 6).
    pub file_type: Option<String>,
    /// The file's place on the iPod, as stored: `:iPod_Control:Music:F00:ABCD.mp3`
    /// (`mhod` 2). See [`Track::path`].
    pub location: Option<String>,
    /// Length in milliseconds (`0x28`).
    pub length_ms: u32,
    /// Track number (`0x2C`) and the album's count of tracks (`0x30`).
    pub track_number: u32,
    /// The album's count of tracks.
    pub track_count: u32,
    /// Disc number (`0x5C`) and count of discs (`0x60`).
    pub disc_number: u32,
    /// The count of discs.
    pub disc_count: u32,
    /// Year (`0x34`).
    pub year: u32,
    /// The file's size in bytes (`0x24`).
    pub size: u32,
    /// Bit rate in kbit/s (`0x38`).
    pub bitrate: u32,
    /// Beats per minute, 0 for none (`0x7A`, two bytes).
    pub bpm: u16,
    /// Times played, as the last sync left it (`0x50`).
    pub play_count: u32,
    /// Rating, 0 to 100 in steps of 20 (`0x1F`).
    pub rating: u8,
    /// Whether it belongs to a compilation (`0x1E`).
    pub compilation: bool,
    /// Its cover's image in the `ArtworkDB` (`0x160`), when `0xA4` says it has one.
    pub artwork_id: Option<u32>,
}

impl Track {
    /// [`Track::location`] as a path relative to the iPod's root, with `/`:
    /// `iPod_Control/Music/F00/ABCD.mp3`.
    pub fn path(&self) -> Option<String> {
        let location = self.location.as_deref()?;
        Some(location.trim_start_matches(':').replace(':', "/"))
    }
}

/// A playlist (`mhyp`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Playlist {
    /// Its 64-bit ID (`0x1C`).
    pub id: u64,
    /// Its name (`mhod` 1).
    pub name: Option<String>,
    /// Whether it is the master playlist, which holds every track and which the
    /// iPod does not show as a playlist (`0x14`).
    pub master: bool,
    /// Whether it is a smart playlist (it has rules: `mhod` 51).
    pub smart: bool,
    /// Whether it is a podcast playlist (`0x2A`).
    pub podcast: bool,
    /// Its tracks' IDs ([`Track::id`]), in its order. Podcast group headers
    /// are left out.
    pub track_ids: Vec<u32>,
}

/// The section types (`mhsd`, `0x0C`).
const SECTION_TRACKS: u32 = 1;
const SECTION_PLAYLISTS: u32 = 2;
const SECTION_PODCAST_PLAYLISTS: u32 = 3;

/// Reads a database. An `iTunesCDB` must be inflated first ([`crate::cdb::inflate`]).
pub fn parse(data: &[u8]) -> Result<Database, Error> {
    let (header, total) = chunk(data, 0, data.len(), "mhbd")?;
    let mut db = Database {
        version: u32_at(data, 0x10)?,
        database_id: if header >= 0x20 { u64_at(data, 0x18)? } else { 0 },
        checksum_scheme: if header >= 0x32 { u16_at(data, 0x30)? } else { 0 },
        ..Database::default()
    };
    let sections = u32_at(data, 0x14)?;
    let mut playlists = None;
    let mut podcast_playlists = None;
    let mut offset = header;
    for _ in 0..sections {
        if offset >= total {
            break;
        }
        let (section_header, section_total) = chunk(data, offset, total, "mhsd")?;
        let child = offset + section_header;
        match u32_at(data, offset + 0x0c)? {
            SECTION_TRACKS => db.tracks = tracks(data, child, offset + section_total)?,
            SECTION_PLAYLISTS => playlists = Some(playlist_list(data, child, offset + section_total)?),
            SECTION_PODCAST_PLAYLISTS => podcast_playlists = Some(playlist_list(data, child, offset + section_total)?),
            _ => {}
        }
        offset += section_total;
    }
    db.playlists = podcast_playlists.or(playlists).unwrap_or_default();
    Ok(db)
}

/// Checks the chunk at `offset` is a `name` that fits before `end`, and gives
/// its header's length and its total length.
fn chunk(data: &[u8], offset: usize, end: usize, name: &'static str) -> Result<(usize, usize), Error> {
    let found: [u8; 4] = array(data, offset)?;
    if found != name.as_bytes() {
        return Err(Error::UnexpectedChunk {
            offset,
            expected: name,
            found,
        });
    }
    let header = len_at(data, offset + 4, offset)?;
    let total = len_at(data, offset + 8, offset)?;
    if header < 12 || total < header || offset.checked_add(total).is_none_or(|e| e > end) {
        return Err(Error::BadLength { offset });
    }
    Ok((header, total))
}

/// A list's header (`mhlt`, `mhlp`): its header's length and its count, which
/// these chunks keep where others keep their total length.
fn list(data: &[u8], offset: usize, end: usize, name: &'static str) -> Result<(usize, u32), Error> {
    let found: [u8; 4] = array(data, offset)?;
    if found != name.as_bytes() {
        return Err(Error::UnexpectedChunk {
            offset,
            expected: name,
            found,
        });
    }
    let header = len_at(data, offset + 4, offset)?;
    if header < 12 || offset + header > end {
        return Err(Error::BadLength { offset });
    }
    Ok((header, u32_at(data, offset + 8)?))
}

fn tracks(data: &[u8], offset: usize, end: usize) -> Result<Vec<Track>, Error> {
    let (header, count) = list(data, offset, end, "mhlt")?;
    let mut out = Vec::new();
    let mut at = offset + header;
    for _ in 0..count {
        let (track, total) = track(data, at, end)?;
        out.push(track);
        at += total;
    }
    Ok(out)
}

/// A `u32` field of a header, or 0 when the header is too short to hold it
/// (older databases have shorter headers).
fn field(data: &[u8], chunk: usize, header: usize, offset: usize) -> Result<u32, Error> {
    if offset + 4 <= header {
        u32_at(data, chunk + offset)
    } else {
        Ok(0)
    }
}

fn track(data: &[u8], at: usize, end: usize) -> Result<(Track, usize), Error> {
    let (header, total) = chunk(data, at, end, "mhit")?;
    let f = |offset| field(data, at, header, offset);
    let mut track = Track {
        id: f(0x10)?,
        database_id: if header >= 0x78 { u64_at(data, at + 0x70)? } else { 0 },
        rating: if header > 0x1f { u8_at(data, at + 0x1f)? } else { 0 },
        compilation: header > 0x1e && u8_at(data, at + 0x1e)? == 1,
        artwork_id: if header >= 0x164 && u8_at(data, at + 0xa4)? == 1 {
            Some(u32_at(data, at + 0x160)?).filter(|id| *id != 0)
        } else {
            None
        },
        size: f(0x24)?,
        length_ms: f(0x28)?,
        track_number: f(0x2c)?,
        track_count: f(0x30)?,
        year: f(0x34)?,
        bitrate: f(0x38)?,
        play_count: f(0x50)?,
        disc_number: f(0x5c)?,
        disc_count: f(0x60)?,
        bpm: if header >= 0x7c {
            u16::from(u8_at(data, at + 0x7a)?) | u16::from(u8_at(data, at + 0x7b)?) << 8
        } else {
            0
        },
        ..Track::default()
    };
    for_each_mhod(data, at + header, at + total, f(0x0c)?, |kind, text| {
        let slot = match kind {
            1 => &mut track.title,
            2 => &mut track.location,
            3 => &mut track.album,
            4 => &mut track.artist,
            5 => &mut track.genre,
            6 => &mut track.file_type,
            12 => &mut track.composer,
            22 => &mut track.album_artist,
            _ => return,
        };
        if slot.is_none() {
            *slot = text;
        }
    })?;
    Ok((track, total))
}

/// Walks `count` `mhod`s from `at`, handing each one's type and, for the
/// string types, its text. Gives the offset after the last one.
fn for_each_mhod(
    data: &[u8],
    mut at: usize,
    end: usize,
    count: u32,
    mut each: impl FnMut(u32, Option<String>),
) -> Result<usize, Error> {
    for _ in 0..count {
        let (_, total) = chunk(data, at, end, "mhod")?;
        let kind = u32_at(data, at + 0x0c)?;
        let text = if is_string_type(kind) {
            Some(string(data, at, at + total)?)
        } else {
            None
        };
        each(kind, text);
        at += total;
    }
    Ok(at)
}

/// The `mhod` types that hold one string after a 0x28-byte header: the
/// track's and playlist's strings (1–14, 18–31) and the album list's (200–204).
fn is_string_type(kind: u32) -> bool {
    matches!(kind, 1..=14 | 18..=31 | 200..=204)
}

/// A string `mhod`'s text: its encoding at `0x18` (2 is UTF-8, anything else
/// UTF-16LE, as iTunes writes most), its length in bytes at `0x1C`, the text at
/// `0x28`.
fn string(data: &[u8], at: usize, end: usize) -> Result<String, Error> {
    let encoding = u32_at(data, at + 0x18)?;
    let len = len_at(data, at + 0x1c, at)?;
    let start = at + 0x28;
    let bytes = start
        .checked_add(len)
        .filter(|&e| e <= end)
        .and_then(|e| data.get(start..e))
        .ok_or(Error::BadLength { offset: at })?;
    Ok(if encoding == 2 {
        String::from_utf8_lossy(bytes).into_owned()
    } else {
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        String::from_utf16_lossy(&units)
    })
}

fn playlist_list(data: &[u8], offset: usize, end: usize) -> Result<Vec<Playlist>, Error> {
    let (header, count) = list(data, offset, end, "mhlp")?;
    let mut out = Vec::new();
    let mut at = offset + header;
    for _ in 0..count {
        let (playlist, total) = playlist(data, at, end)?;
        out.push(playlist);
        at += total;
    }
    Ok(out)
}

/// Marks an `mhip` that heads a group of podcast episodes instead of naming a track.
const PODCAST_GROUP: u32 = 0x100;

fn playlist(data: &[u8], at: usize, end: usize) -> Result<(Playlist, usize), Error> {
    let (header, total) = chunk(data, at, end, "mhyp")?;
    let items = u32_at(data, at + 0x10)?;
    let mut playlist = Playlist {
        master: u8_at(data, at + 0x14)? == 1,
        id: if header >= 0x24 { u64_at(data, at + 0x1c)? } else { 0 },
        podcast: header >= 0x2c && u16_at(data, at + 0x2a)? == 1,
        ..Playlist::default()
    };
    let mut item = for_each_mhod(
        data,
        at + header,
        at + total,
        u32_at(data, at + 0x0c)?,
        |kind, text| match kind {
            1 if playlist.name.is_none() => playlist.name = text,
            51 => playlist.smart = true,
            _ => {}
        },
    )?;
    for _ in 0..items {
        let (item_header, item_total) = chunk(data, item, at + total, "mhip")?;
        if item_header >= 0x1c && u32_at(data, item + 0x10)? != PODCAST_GROUP {
            playlist.track_ids.push(u32_at(data, item + 0x18)?);
        }
        item += item_total;
    }
    Ok((playlist, total))
}

#[cfg(test)]
pub(crate) mod tests {
    //! Databases built from the layout above, so the tests say what each field is.

    use super::*;

    fn put32(buf: &mut [u8], at: usize, v: u32) {
        buf[at..at + 4].copy_from_slice(&v.to_le_bytes());
    }

    fn put64(buf: &mut [u8], at: usize, v: u64) {
        buf[at..at + 8].copy_from_slice(&v.to_le_bytes());
    }

    /// A chunk: its name, a header of `header` bytes (zeroes but for the
    /// lengths and what `fill` writes), then `children`.
    fn chunk(name: &[u8; 4], header: usize, fill: impl FnOnce(&mut [u8]), children: &[u8]) -> Vec<u8> {
        let mut buf = vec![0; header];
        buf[..4].copy_from_slice(name);
        put32(&mut buf, 4, header as u32);
        put32(&mut buf, 8, (header + children.len()) as u32);
        fill(&mut buf);
        buf.extend_from_slice(children);
        buf
    }

    pub(crate) fn mhod_utf16(kind: u32, text: &str) -> Vec<u8> {
        let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        mhod_raw(kind, 1, &bytes)
    }

    fn mhod_raw(kind: u32, encoding: u32, bytes: &[u8]) -> Vec<u8> {
        let mut buf = chunk(b"mhod", 0x18, |b| put32(b, 0x0c, kind), &[]);
        buf.resize(0x28, 0);
        put32(&mut buf, 0x18, encoding);
        put32(&mut buf, 0x1c, bytes.len() as u32);
        buf.extend_from_slice(bytes);
        let total = buf.len() as u32;
        put32(&mut buf, 8, total);
        buf
    }

    fn mhod_other(kind: u32, payload: &[u8]) -> Vec<u8> {
        chunk(b"mhod", 0x18, |b| put32(b, 0x0c, kind), payload)
    }

    fn mhit(id: u32, number: u32, mhods: &[Vec<u8>]) -> Vec<u8> {
        chunk(
            b"mhit",
            0x184,
            |b| {
                put32(b, 0x0c, mhods.len() as u32);
                put32(b, 0x10, id);
                b[0x1f] = 80;
                put32(b, 0x24, 4_000_000);
                put32(b, 0x28, 197_000);
                put32(b, 0x2c, number);
                put32(b, 0x30, 12);
                put32(b, 0x34, 1999);
                put32(b, 0x38, 320);
                put32(b, 0x50, 7);
                put32(b, 0x5c, 1);
                put32(b, 0x60, 2);
                put64(b, 0x70, 0xABCD_0000_0000_0000 | u64::from(id));
            },
            &mhods.concat(),
        )
    }

    fn mhip(track: u32, group: bool) -> Vec<u8> {
        chunk(
            b"mhip",
            0x4c,
            |b| {
                put32(b, 0x10, if group { PODCAST_GROUP } else { 0 });
                put32(b, 0x18, track);
            },
            &[],
        )
    }

    fn mhyp(id: u64, master: bool, mhods: &[Vec<u8>], items: &[Vec<u8>]) -> Vec<u8> {
        let mut children = mhods.concat();
        children.extend(items.concat());
        chunk(
            b"mhyp",
            0x6c,
            |b| {
                put32(b, 0x0c, mhods.len() as u32);
                put32(b, 0x10, items.len() as u32);
                b[0x14] = u8::from(master);
                put64(b, 0x1c, id);
            },
            &children,
        )
    }

    fn list(name: &[u8; 4], items: &[Vec<u8>]) -> Vec<u8> {
        let mut buf = chunk(name, 0x5c, |_| {}, &[]);
        put32(&mut buf, 8, items.len() as u32);
        buf.extend(items.concat());
        buf
    }

    fn mhsd(kind: u32, child: &[u8]) -> Vec<u8> {
        chunk(b"mhsd", 0x60, |b| put32(b, 0x0c, kind), child)
    }

    fn mhbd(sections: &[Vec<u8>]) -> Vec<u8> {
        chunk(
            b"mhbd",
            0xf4,
            |b| {
                put32(b, 0x0c, 1);
                put32(b, 0x10, 0x75);
                put32(b, 0x14, sections.len() as u32);
                put64(b, 0x18, 0x1122_3344_5566_7788);
                b[0x30..0x32].copy_from_slice(&3u16.to_le_bytes());
            },
            &sections.concat(),
        )
    }

    /// A database holding these `mhit`s (whole chunks, their `mhod`s included)
    /// and no playlist.
    pub(crate) fn database_with_tracks(mhits: &[Vec<u8>]) -> Vec<u8> {
        mhbd(&[mhsd(1, &list(b"mhlt", mhits))])
    }

    /// Two tracks, an album section to skip, the old playlist section and
    /// the podcast-aware one (which wins).
    pub(crate) fn sample_database() -> Vec<u8> {
        let first = mhit(
            101,
            1,
            &[
                mhod_utf16(1, "A Barraca"),
                mhod_utf16(4, "Heredeiros da Crus"),
                mhod_utf16(3, "Chicarrón"),
                mhod_utf16(22, "Heredeiros da Crus"),
                mhod_utf16(5, "Rock Galego"),
                mhod_raw(6, 2, "MPEG audio file".as_bytes()),
                mhod_utf16(2, ":iPod_Control:Music:F07:ABCD.mp3"),
                mhod_other(17, &[0; 8]),
            ],
        );
        let second = mhit(102, 2, &[mhod_utf16(1, "À perte de rue"), mhod_utf16(12, "Zaz")]);
        let tracks = mhsd(1, &list(b"mhlt", &[first, second]));
        let albums = mhsd(4, &list(b"mhla", &[]));
        let old = mhsd(
            2,
            &list(b"mhlp", &[mhyp(1, true, &[mhod_utf16(1, "Old")], &[mhip(101, false)])]),
        );
        let podcast_aware = mhsd(
            3,
            &list(
                b"mhlp",
                &[
                    mhyp(
                        1,
                        true,
                        &[mhod_utf16(1, "iPod nano"), mhod_other(100, &[0; 4])],
                        &[mhip(101, false), mhip(102, false)],
                    ),
                    mhyp(
                        2,
                        false,
                        &[
                            mhod_utf16(1, "Good songs"),
                            mhod_other(50, &[0; 8]),
                            mhod_other(51, &[0; 8]),
                        ],
                        &[mhip(0, true), mhip(102, false)],
                    ),
                ],
            ),
        );
        mhbd(&[tracks, albums, old, podcast_aware])
    }

    #[test]
    fn reads_tracks_and_playlists() {
        let db = parse(&sample_database()).unwrap();
        assert_eq!(db.version, 0x75);
        assert_eq!(db.database_id, 0x1122_3344_5566_7788);
        assert_eq!(db.checksum_scheme, 3);
        assert_eq!(db.tracks.len(), 2);
        let t = &db.tracks[0];
        assert_eq!(t.id, 101);
        assert_eq!(t.database_id, 0xABCD_0000_0000_0065);
        assert_eq!(t.title.as_deref(), Some("A Barraca"));
        assert_eq!(t.artist.as_deref(), Some("Heredeiros da Crus"));
        assert_eq!(t.album.as_deref(), Some("Chicarrón"));
        assert_eq!(t.album_artist.as_deref(), Some("Heredeiros da Crus"));
        assert_eq!(t.genre.as_deref(), Some("Rock Galego"));
        assert_eq!(t.file_type.as_deref(), Some("MPEG audio file"));
        assert_eq!(t.path().as_deref(), Some("iPod_Control/Music/F07/ABCD.mp3"));
        assert_eq!(
            (t.length_ms, t.track_number, t.track_count, t.disc_number, t.disc_count),
            (197_000, 1, 12, 1, 2)
        );
        assert_eq!(
            (t.year, t.size, t.bitrate, t.play_count, t.rating),
            (1999, 4_000_000, 320, 7, 80)
        );
        let u = &db.tracks[1];
        assert_eq!(u.title.as_deref(), Some("À perte de rue"));
        assert_eq!(u.composer.as_deref(), Some("Zaz"));
        assert_eq!(u.path(), None);

        assert_eq!(db.playlists.len(), 2);
        let master = &db.playlists[0];
        assert!(master.master && !master.smart && !master.podcast);
        assert_eq!(master.name.as_deref(), Some("iPod nano"));
        assert_eq!(master.track_ids, [101, 102]);
        let good = &db.playlists[1];
        assert_eq!((good.id, good.master, good.smart), (2, false, true));
        assert_eq!(good.name.as_deref(), Some("Good songs"));
        assert_eq!(good.track_ids, [102]);
    }

    #[test]
    fn old_playlists_when_alone() {
        let tracks = mhsd(1, &list(b"mhlt", &[mhit(5, 1, &[])]));
        let old = mhsd(
            2,
            &list(b"mhlp", &[mhyp(9, true, &[mhod_utf16(1, "Old")], &[mhip(5, false)])]),
        );
        let db = parse(&mhbd(&[tracks, old])).unwrap();
        assert_eq!(db.playlists[0].name.as_deref(), Some("Old"));
        assert_eq!(db.playlists[0].track_ids, [5]);
    }

    #[test]
    fn short_headers_read_as_zero() {
        let mut track = chunk(b"mhit", 0x14, |b| put32(b, 0x10, 3), &[]);
        put32(&mut track, 0x0c, 0);
        let mut header = chunk(b"mhbd", 0x18, |b| put32(b, 0x14, 1), &mhsd(1, &list(b"mhlt", &[track])));
        put32(&mut header, 0x10, 1);
        let db = parse(&header).unwrap();
        assert_eq!((db.database_id, db.checksum_scheme), (0, 0));
        assert_eq!(db.tracks[0].id, 3);
        assert_eq!(db.tracks[0].length_ms, 0);
        assert_eq!(db.tracks[0].rating, 0);
        assert!(db.playlists.is_empty());
    }

    #[test]
    fn malformed_is_an_error_never_a_panic() {
        let good = sample_database();
        assert!(matches!(
            parse(b"mhbx\0\0\0\0"),
            Err(Error::UnexpectedChunk {
                offset: 0,
                expected: "mhbd",
                ..
            })
        ));
        assert_eq!(parse(b"mhb"), Err(Error::Truncated { offset: 0 }));
        // Every truncation, and a byte flipped at every offset: errors or a
        // database, never a panic.
        for len in 0..good.len() {
            let _ = parse(&good[..len]);
        }
        for at in 0..good.len() {
            for value in [0x00, 0xff, 0x7f] {
                let mut bad = good.clone();
                bad[at] = value;
                let _ = parse(&bad);
            }
        }
        // A total length past the end.
        let mut bad = good.clone();
        put32(&mut bad, 8, good.len() as u32 + 1);
        assert_eq!(parse(&bad), Err(Error::BadLength { offset: 0 }));
    }

    #[test]
    fn string_lengths_are_bounded() {
        let mut m = mhod_utf16(1, "abc");
        put32(&mut m, 0x1c, 1000);
        assert_eq!(string(&m, 0, m.len()), Err(Error::BadLength { offset: 0 }));
    }
}
