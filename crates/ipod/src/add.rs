//! Adding a song to an iPod nano 6G or 7G's databases, in memory: its `mhit`,
//! its album's `mhia` and its artist's `mhii` when they are new, its `mhip`s in
//! the playlists of the `iTunesCDB`; and its rows, with those of a new album,
//! artist, composer or genre, in the SQLite library, ranked again.
//!
//! The databases are given as read from the device: the `iTunesCDB`'s tree
//! ([`crate::chunk`]) and the library's rows with what the post-process makes
//! taken out ([`crate::library::strip_post_processed`]). Nothing is written
//! here; the caller writes the tree and runs the post-process on the rows. How
//! each record is laid out was read from the owner's nano 7G
//! (`RECORD/2026-11-14.ipod-sync.WIP.md`, N4b).

use crate::chunk::{Body, Chunk};
use crate::collate;
use crate::library::{Rows, Value};
use crate::song::{self, Song, Stamp, mhod_string, sort_column, sort_mhod};

/// The `mhsd` types the nano 7G's `iTunesCDB` has.
pub(crate) const SECTION_TRACKS: u32 = 1;
pub(crate) const SECTION_PLAYLISTS: u32 = 3;
pub(crate) const SECTION_ALBUMS: u32 = 4;
pub(crate) const SECTION_ARTISTS: u32 = 8;
/// Apple's hidden playlists (music, films, …).
pub(crate) const SECTION_HIDDEN_PLAYLISTS: u32 = 5;

/// The fallback name of an MP3's kind, when the device names none yet.
pub const MP3_KIND: &str = "MPEG audio file";

/// An iPod's databases, in memory.
#[derive(Clone, Debug)]
pub struct Ipod {
    /// The inflated `iTunesCDB`, as a tree.
    pub tree: Chunk,
    /// The library's rows, by file, without what the post-process makes.
    pub rows: Vec<Rows>,
}

/// Why a song could not be added.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AddError {
    /// The `iTunesCDB` lacks a section, a list or the master playlist.
    Missing(&'static str),
    /// No playlist has this name.
    NoPlaylist(String),
    /// The playlist is a smart one: its rules choose its songs.
    SmartPlaylist(String),
    /// A row did not fit its table.
    Row(String),
}

impl std::fmt::Display for AddError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AddError::Missing(what) => write!(f, "the iTunesCDB has no {what}"),
            AddError::NoPlaylist(name) => write!(f, "no playlist is called {name:?}"),
            AddError::SmartPlaylist(name) => write!(f, "{name:?} is a smart playlist; its rules choose its songs"),
            AddError::Row(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for AddError {}

pub(crate) fn u32_at(header: &[u8], at: usize) -> u32 {
    header
        .get(at..at + 4)
        .map_or(0, |b| u32::from_le_bytes(b.try_into().expect("four bytes")))
}

pub(crate) fn i64_at(header: &[u8], at: usize) -> i64 {
    header
        .get(at..at + 8)
        .map_or(0, |b| i64::from_le_bytes(b.try_into().expect("eight bytes")))
}

pub(crate) fn put(header: &mut [u8], at: usize, bytes: &[u8]) {
    header[at..at + bytes.len()].copy_from_slice(bytes);
}

pub(crate) fn kind_of(chunk: &Chunk) -> u32 {
    u32_at(&chunk.header, 0x0c)
}

/// The text of a string `mhod`.
pub(crate) fn mhod_text(mhod: &Chunk) -> Option<String> {
    let Body::Raw(body) = &mhod.body else { return None };
    let len = u32_at(body, 4) as usize;
    let bytes = body.get(16..16 + len)?;
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|p| u16::from_le_bytes(*p))
        .collect();
    Some(String::from_utf16_lossy(&units))
}

pub(crate) fn strings_of(chunk: &Chunk) -> Vec<(u32, String)> {
    chunk
        .children()
        .iter()
        .filter(|c| c.name() == *b"mhod")
        .filter_map(|m| mhod_text(m).map(|t| (kind_of(m), t)))
        .collect()
}

/// The list (`mhlt`, `mhla`, …) of the section of `kind`.
pub(crate) fn list_mut<'a>(tree: &'a mut Chunk, kind: u32, what: &'static str) -> Result<&'a mut Vec<Chunk>, AddError> {
    tree.children_mut()
        .ok_or(AddError::Missing("sections"))?
        .iter_mut()
        .find(|s| s.name() == *b"mhsd" && kind_of(s) == kind)
        .and_then(|s| s.children_mut()?.first_mut())
        .and_then(Chunk::children_mut)
        .ok_or(AddError::Missing(what))
}

pub(crate) fn list(tree: &Chunk, kind: u32) -> &[Chunk] {
    tree.children()
        .iter()
        .find(|s| s.name() == *b"mhsd" && kind_of(s) == kind)
        .and_then(|s| s.children().first())
        .map_or(&[], Chunk::children)
}

/// The highest of the IDs the `iTunesCDB` hands out from one counter: songs'
/// (`mhit` `0x10` and `0x1F4`), albums' and artists' (`0x10`), playlist items'
/// (`mhip` `0x14`).
pub fn highest_id(tree: &Chunk) -> u32 {
    fn walk(chunk: &Chunk, max: &mut u32) {
        let h = &chunk.header;
        match &chunk.name() {
            b"mhit" => *max = (*max).max(u32_at(h, 0x10)).max(u32_at(h, 0x1f4)),
            b"mhia" | b"mhii" => *max = (*max).max(u32_at(h, 0x10)),
            b"mhip" => *max = (*max).max(u32_at(h, 0x14)),
            _ => {}
        }
        for c in chunk.children() {
            walk(c, max);
        }
    }
    let mut max = 0;
    walk(tree, &mut max);
    max
}

/// An album's `mhia`: its name (200), its artist as the album shows it (201)
/// and its album artist when it has one (202); compilations have `0x102` at
/// `0x1C`, and `0x20` is an ID of its own.
fn mhia(id: u32, pid: i64, song: &Song, extra_id: u64) -> Chunk {
    let mut h = vec![0u8; 0x58];
    put(&mut h, 0, b"mhia");
    put(&mut h, 4, &0x58u32.to_le_bytes());
    put(&mut h, 0x10, &id.to_le_bytes());
    put(&mut h, 0x14, &pid.to_le_bytes());
    put(
        &mut h,
        0x1c,
        &(if song.compilation { 0x102u32 } else { 2 }).to_le_bytes(),
    );
    put(&mut h, 0x20, &extra_id.to_le_bytes());
    let mut strings = Vec::new();
    if let Some(album) = song.album.as_deref().filter(|a| !a.is_empty()) {
        strings.push(mhod_string(200, album));
        if let Some(shown) = song.album_artist.as_deref().or(song.artist.as_deref()) {
            strings.push(mhod_string(201, shown));
        }
        if let Some(album_artist) = song.album_artist.as_deref() {
            strings.push(mhod_string(202, album_artist));
        }
    }
    put(&mut h, 0x0c, &(strings.len() as u32).to_le_bytes());
    Chunk {
        header: h,
        body: Body::Children(strings),
    }
}

/// An artist's `mhii`: its name (300), and its sort form when it differs (301).
fn mhii(id: u32, pid: i64, name: Option<&str>, sort: Option<&str>) -> Chunk {
    let mut h = vec![0u8; 0x50];
    put(&mut h, 0, b"mhii");
    put(&mut h, 4, &0x50u32.to_le_bytes());
    put(&mut h, 0x10, &id.to_le_bytes());
    put(&mut h, 0x14, &pid.to_le_bytes());
    put(&mut h, 0x1c, &2u32.to_le_bytes());
    let mut strings = Vec::new();
    if let Some(name) = name.filter(|n| !n.is_empty()) {
        strings.push(mhod_string(300, name));
        if let Some(sort) = sort_mhod(sort, Some(name)) {
            strings.push(mhod_string(301, &sort));
        }
    }
    put(&mut h, 0x0c, &(strings.len() as u32).to_le_bytes());
    Chunk {
        header: h,
        body: Body::Children(strings),
    }
}

/// A playlist item: the song's ID and pid, when it was added, an ID of its own
/// (`0x14`, and again in its position `mhod`, type 100) and a 64-bit one (`0x3C`).
fn mhip(id: u32, song: &Song, added: Stamp, extra_id: u64) -> Chunk {
    let mut h = vec![0u8; 0x4c];
    put(&mut h, 0, b"mhip");
    put(&mut h, 4, &0x4cu32.to_le_bytes());
    put(&mut h, 0x0c, &1u32.to_le_bytes());
    put(&mut h, 0x14, &id.to_le_bytes());
    put(&mut h, 0x18, &song.track_id.to_le_bytes());
    put(&mut h, 0x1c, &added.mac().to_le_bytes());
    put(&mut h, 0x2c, &song.pid.to_le_bytes());
    put(&mut h, 0x3c, &extra_id.to_le_bytes());
    let mut mh = vec![0u8; 0x18];
    put(&mut mh, 0, b"mhod");
    put(&mut mh, 4, &0x18u32.to_le_bytes());
    put(&mut mh, 0x0c, &100u32.to_le_bytes());
    let mut body = vec![0u8; 0x14];
    put(&mut body, 0, &id.to_le_bytes());
    Chunk {
        header: h,
        body: Body::Children(vec![Chunk {
            header: mh,
            body: Body::Raw(body),
        }]),
    }
}

fn text(s: Option<&str>) -> Value {
    s.map_or(Value::Null, |s| Value::Text(s.to_string()))
}

pub(crate) fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Integer(i) => Some(*i),
        _ => None,
    }
}

pub(crate) fn rows_mut<'a>(rows: &'a mut [Rows], file: &str) -> Result<&'a mut Rows, AddError> {
    rows.iter_mut()
        .find(|r| r.file == file)
        .ok_or_else(|| AddError::Row(format!("no rows for {file}")))
}

pub(crate) fn table_mut<'a>(
    rows: &'a mut [Rows],
    file: &str,
    table: &str,
) -> Result<&'a mut crate::library::Table, AddError> {
    rows_mut(rows, file)?
        .table_mut(table)
        .ok_or_else(|| AddError::Row(format!("{file} has no table {table}")))
}

/// Adds `song` to the iPod. Its tags, audio, file (`path`, under
/// `iPod_Control/Music/`) and `modified` are the caller's; the rest is set
/// here and given back in the song: its pid and IDs, its kind's name, `added`
/// (`now`), its album, artist, composer and genre (reused when the iPod has
/// them, by name; made otherwise). It goes into the master playlist, and into
/// `playlist` when one is named. `random` draws the 64-bit IDs.
pub fn add(
    ipod: &mut Ipod,
    song: Song,
    playlist: Option<&str>,
    now: Stamp,
    random: &mut dyn FnMut() -> u64,
) -> Result<Song, AddError> {
    let mut song = song;
    let mut next_id = highest_id(&ipod.tree) + 1;
    let mut take_id = |n: u32| {
        let id = next_id;
        next_id += n;
        id
    };
    // A pid no row has yet.
    let library = ipod
        .rows
        .iter()
        .find(|r| r.file == "Library.itdb")
        .ok_or(AddError::Row("no rows for Library.itdb".into()))?;
    let taken = |table: &str, column: &str, v: i64| {
        library
            .table(table)
            .is_some_and(|t| t.find(column, &Value::Integer(v)).next().is_some())
    };
    let mut fresh_pid = |table: &str| loop {
        let p = random() as i64;
        if p != 0 && !taken(table, "pid", p) {
            break p;
        }
    };
    song.pid = fresh_pid("item");
    song.track_id = take_id(2); // and the ID after it, at 0x1F4
    song.added = now;

    // The playlists to add to, checked before anything changes.
    let containers = library
        .table("container")
        .ok_or(AddError::Row("no container table".into()))?;
    let master_pid = library
        .table("db_info")
        .and_then(|t| t.rows.first().map(|r| t.get(r, "primary_container_pid")))
        .and_then(|v| int(&v))
        .ok_or(AddError::Missing("master playlist in db_info"))?;
    let mut targets = vec![master_pid];
    if let Some(name) = playlist {
        let row = containers
            .rows
            .iter()
            .find(|r| {
                containers.get(r, "name") == Value::Text(name.to_string())
                    && int(&containers.get(r, "distinguished_kind")) == Some(0)
                    && int(&containers.get(r, "pid")) != Some(master_pid)
            })
            .ok_or_else(|| AddError::NoPlaylist(name.to_string()))?;
        if containers.get(row, "smart_criteria") != Value::Null {
            return Err(AddError::SmartPlaylist(name.to_string()));
        }
        targets.extend(int(&containers.get(row, "pid")));
    }

    // The artist the album is under: its album artist, or its artist.
    let artist_name = song.album_artist.clone().or(song.artist.clone());
    let artist_sort = sort_column(
        song.sort_album_artist.as_deref().or(song.sort_artist.as_deref()),
        artist_name.as_deref(),
    );
    let artists = list(&ipod.tree, SECTION_ARTISTS);
    let existing_artist = artists.iter().find(|a| {
        strings_of(a).iter().find(|(k, _)| *k == 300).map(|(_, t)| t.clone()) == artist_name
            && library
                .table("artist")
                .is_some_and(|t| t.find("pid", &Value::Integer(i64_at(&a.header, 0x14))).next().is_some())
    });
    let (artist_id, artist_pid, new_artist) = match existing_artist {
        Some(a) => (u32_at(&a.header, 0x10), i64_at(&a.header, 0x14), false),
        None => (take_id(1), fresh_pid("artist"), true),
    };

    let albums = list(&ipod.tree, SECTION_ALBUMS);
    let album_rows = library.table("album");
    let existing_album = albums.iter().find(|a| {
        let pid = i64_at(&a.header, 0x14);
        let name = strings_of(a).iter().find(|(k, _)| *k == 200).map(|(_, t)| t.clone());
        name == song.album
            && album_rows.is_some_and(|t| {
                t.find("pid", &Value::Integer(pid))
                    .next()
                    .is_some_and(|r| int(&t.get(r, "artist_pid")) == Some(artist_pid))
            })
    });
    let (album_id, album_pid, new_album) = match existing_album {
        Some(a) => (u32_at(&a.header, 0x10), i64_at(&a.header, 0x14), false),
        None => (take_id(1), fresh_pid("album"), true),
    };
    song.album_id = album_id;
    song.album_pid = Some(album_pid);
    song.artist_id = artist_id;
    song.artist_pid = Some(artist_pid);

    // The composer and the genre: by name, or the next integer ID.
    let next_int = |table: &str, column: &str| {
        library
            .table(table)
            .map(|t| t.rows.iter().filter_map(|r| int(&t.get(r, column))).max().unwrap_or(0) + 1)
            .unwrap_or(1)
    };
    let by_name = |table: &str, column: &str, key: &str, name: &str| {
        library.table(table).and_then(|t| {
            t.find(column, &Value::Text(name.to_string()))
                .next()
                .and_then(|r| int(&t.get(r, key)))
        })
    };
    let composer = song.composer.clone().filter(|c| !c.is_empty());
    let (composer_pid, new_composer) = match composer.as_deref() {
        None => (0, false),
        Some(name) => match by_name("composer", "name", "pid", name) {
            Some(p) => (p, false),
            None => (next_int("composer", "pid"), true),
        },
    };
    song.composer_pid = composer_pid;
    let genre = song.genre.clone().filter(|g| !g.is_empty());
    let (genre_id, new_genre) = match genre.as_deref() {
        None => (0, false),
        Some(name) => match by_name("genre_map", "genre", "id", name) {
            Some(id) => (id, false),
            None => (next_int("genre_map", "id"), true),
        },
    };
    song.genre_id = genre_id;

    // The kind's name, as the device's language has it: the one its MP3s use.
    let locations = ipod.rows.iter().find(|r| r.file == "Locations.itdb");
    let mp3_kind = locations.and_then(|r| r.table("location")).and_then(|t| {
        t.find("extension", &Value::Integer(i64::from(song::MP3)))
            .next()
            .and_then(|r| int(&t.get(r, "kind_id")))
    });
    let kinds = library.table("location_kind_map");
    let kind_name = |id: i64| {
        kinds.and_then(|t| {
            t.find("id", &Value::Integer(id))
                .next()
                .and_then(|r| match t.get(r, "kind") {
                    Value::Text(k) => Some(k),
                    _ => None,
                })
        })
    };
    let (kind_id, new_kind) = match mp3_kind.and_then(|id| kind_name(id).map(|n| (id, n))) {
        Some((id, name)) => {
            song.kind = name;
            (id, false)
        }
        None => {
            song.kind = MP3_KIND.to_string();
            (next_int("location_kind_map", "id"), true)
        }
    };
    let mhip_ids: Vec<u32> = targets.iter().map(|_| take_id(1)).collect();
    let extra_ids: Vec<u64> = (0..targets.len() + 1).map(|_| random()).collect();

    // The iTunesCDB.
    let mhit = song.mhit();
    list_mut(&mut ipod.tree, SECTION_TRACKS, "track list")?.push(mhit);
    if new_album {
        let chunk = mhia(album_id, album_pid, &song, extra_ids[targets.len()]);
        list_mut(&mut ipod.tree, SECTION_ALBUMS, "album list")?.push(chunk);
    }
    if new_artist {
        let chunk = mhii(
            artist_id,
            artist_pid,
            artist_name.as_deref(),
            song.sort_album_artist.as_deref().or(song.sort_artist.as_deref()),
        );
        list_mut(&mut ipod.tree, SECTION_ARTISTS, "artist list")?.push(chunk);
    }
    let playlists = list_mut(&mut ipod.tree, SECTION_PLAYLISTS, "playlist list")?;
    for (i, container) in targets.iter().enumerate() {
        let mhyp = playlists
            .iter_mut()
            .find(|p| i64_at(&p.header, 0x1c) == *container)
            .ok_or(AddError::Missing("playlist of the library's container"))?;
        let count = u32_at(&mhyp.header, 0x10) + 1;
        put(&mut mhyp.header, 0x10, &count.to_le_bytes());
        mhyp.children_mut()
            .ok_or(AddError::Missing("playlist items"))?
            .push(mhip(mhip_ids[i], &song, now, extra_ids[i]));
    }

    // The rows.
    let row = |e: String| AddError::Row(e);
    if new_artist {
        table_mut(&mut ipod.rows, "Library.itdb", "artist")?
            .push(&[
                ("pid", Value::Integer(artist_pid)),
                ("kind", Value::Integer(2)),
                ("artwork_status", Value::Integer(0)),
                ("artwork_album_pid", Value::Integer(0)),
                ("name", text(artist_name.as_deref())),
                ("sort_name", text(artist_sort.as_deref())),
            ])
            .map_err(row)?;
    }
    if new_album {
        table_mut(&mut ipod.rows, "Library.itdb", "album")?
            .push(&[
                ("pid", Value::Integer(album_pid)),
                ("kind", Value::Integer(2)),
                ("artwork_status", Value::Integer(0)),
                ("artwork_item_pid", Value::Integer(0)),
                ("artist_pid", Value::Integer(artist_pid)),
                ("user_rating", Value::Integer(0)),
                ("name", text(song.album.as_deref())),
                // The post-process sets it again from the items, but the ranks
                // are worked out before it runs.
                (
                    "sort_name",
                    text(sort_column(song.sort_album.as_deref(), song.album.as_deref()).as_deref()),
                ),
                ("all_compilations", Value::Integer(i64::from(song.compilation))),
                ("season_number", Value::Integer(0)),
            ])
            .map_err(row)?;
    }
    if new_composer {
        table_mut(&mut ipod.rows, "Library.itdb", "composer")?
            .push(&[
                ("pid", Value::Integer(composer_pid)),
                ("name", text(composer.as_deref())),
                (
                    "sort_name",
                    text(sort_column(song.sort_composer.as_deref(), composer.as_deref()).as_deref()),
                ),
            ])
            .map_err(row)?;
    }
    if new_genre {
        table_mut(&mut ipod.rows, "Library.itdb", "genre_map")?
            .push(&[("id", Value::Integer(genre_id)), ("genre", text(genre.as_deref()))])
            .map_err(row)?;
    }
    if new_kind {
        table_mut(&mut ipod.rows, "Library.itdb", "location_kind_map")?
            .push(&[
                ("id", Value::Integer(kind_id)),
                ("kind", Value::Text(song.kind.clone())),
            ])
            .map_err(row)?;
    }
    table_mut(&mut ipod.rows, "Library.itdb", "item")?
        .push(&song.item_row())
        .map_err(row)?;
    table_mut(&mut ipod.rows, "Library.itdb", "avformat_info")?
        .push(&song.avformat_row())
        .map_err(row)?;
    table_mut(&mut ipod.rows, "Locations.itdb", "location")?
        .push(&song.location_row(kind_id))
        .map_err(row)?;
    table_mut(&mut ipod.rows, "Dynamic.itdb", "item_stats")?
        .push(&song.stats_row())
        .map_err(row)?;
    let links = table_mut(&mut ipod.rows, "Library.itdb", "item_to_container")?;
    for container in &targets {
        let position = links.find("container_pid", &Value::Integer(*container)).count() as i64;
        links
            .push(&[
                ("item_pid", Value::Integer(song.pid)),
                ("container_pid", Value::Integer(*container)),
                ("physical_order", Value::Integer(position)),
            ])
            .map_err(row)?;
    }
    collate::rank_library(rows_mut(&mut ipod.rows, "Library.itdb")?);
    Ok(song)
}

#[cfg(test)]
pub(crate) mod tests;
