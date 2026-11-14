//! Taking a song out of an iPod nano 6G or 7G's databases, in memory: the
//! inverse of [`crate::add`]. Its `mhit` and every playlist item that points to
//! it go, and so do its rows in every table of the library; then the album,
//! artist, composer and genre that no song uses any more, and their `mhia` and
//! `mhii`. The library is ranked again. See `RECORD/2026-11-14.ipod-sync.WIP.md`
//! (`ipod-remove`).

use crate::add::{
    Ipod, SECTION_ALBUMS, SECTION_ARTISTS, SECTION_HIDDEN_PLAYLISTS, SECTION_PLAYLISTS, SECTION_TRACKS, i64_at, int,
    list_mut, put, rows_mut, u32_at,
};
use crate::collate;
use crate::library::{Rows, Table, Value};

/// What was taken out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Removed {
    /// Its file under `iPod_Control/Music/` (`F24/STSM.mp3`), to delete.
    pub path: Option<String>,
    /// Its title, to say which song it was.
    pub title: Option<String>,
}

/// Why a song could not be taken out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RemoveError {
    /// No song has this pid.
    NoSong(i64),
    /// The databases lack a section or a table.
    Missing(String),
}

impl std::fmt::Display for RemoveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RemoveError::NoSong(pid) => write!(f, "no song has the pid {pid}"),
            RemoveError::Missing(what) => write!(f, "{what}"),
        }
    }
}

impl std::error::Error for RemoveError {}

fn missing(e: impl std::fmt::Display) -> RemoveError {
    RemoveError::Missing(e.to_string())
}

/// The values of `column` in `table`'s rows.
fn values<'a>(table: &'a Table, column: &str) -> impl Iterator<Item = Value> + 'a {
    let c = table.column(column);
    table.rows.iter().map(move |r| c.map_or(Value::Null, |c| r[c].clone()))
}

/// Takes the song `pid` out of the iPod.
pub fn remove(ipod: &mut Ipod, pid: i64) -> Result<Removed, RemoveError> {
    // The iTunesCDB: the song, then the playlist items that point to it.
    let tracks = list_mut(&mut ipod.tree, SECTION_TRACKS, "track list").map_err(missing)?;
    let at = tracks
        .iter()
        .position(|t| i64_at(&t.header, 0x70) == pid)
        .ok_or(RemoveError::NoSong(pid))?;
    let track_id = u32_at(&tracks[at].header, 0x10);
    tracks.remove(at);
    for section in [SECTION_PLAYLISTS, SECTION_HIDDEN_PLAYLISTS] {
        let Ok(playlists) = list_mut(&mut ipod.tree, section, "playlist list") else {
            continue;
        };
        for playlist in playlists.iter_mut() {
            let Some(children) = playlist.children_mut() else {
                continue;
            };
            let before = children.len();
            children.retain(|c| {
                !(c.name() == *b"mhip" && (i64_at(&c.header, 0x2c) == pid || u32_at(&c.header, 0x18) == track_id))
            });
            let gone = (before - children.len()) as u32;
            if gone > 0 {
                let count = u32_at(&playlist.header, 0x10).saturating_sub(gone);
                put(&mut playlist.header, 0x10, &count.to_le_bytes());
            }
        }
    }

    // The rows: the song's, in every table that names it.
    let library = rows_mut(&mut ipod.rows, "Library.itdb").map_err(missing)?;
    let items = library.table("item").ok_or_else(|| missing("no item table"))?;
    let row = items
        .find("pid", &Value::Integer(pid))
        .next()
        .cloned()
        .ok_or(RemoveError::NoSong(pid))?;
    let field = |c: &str| items.get(&row, c);
    let (album, artist, composer, genre, title) = (
        field("album_pid"),
        field("artist_pid"),
        field("composer_pid"),
        field("genre_id"),
        match field("title") {
            Value::Text(t) => Some(t),
            _ => None,
        },
    );
    let path = ipod
        .rows
        .iter()
        .find(|r| r.file == "Locations.itdb")
        .and_then(|r| r.table("location"))
        .and_then(|t| {
            t.find("item_pid", &Value::Integer(pid))
                .next()
                .and_then(|r| match t.get(r, "location") {
                    Value::Text(p) => Some(p),
                    _ => None,
                })
        });
    let mut playlists_touched = Vec::new();
    for rows in &mut ipod.rows {
        for table in &mut rows.tables {
            let key = if table.name == "item" { "pid" } else { "item_pid" };
            let Some(c) = table.column(key) else { continue };
            if table.name == "item_to_container" {
                let container = table.column("container_pid");
                for r in table.rows.iter().filter(|r| r[c] == Value::Integer(pid)) {
                    playlists_touched.extend(container.map(|k| r[k].clone()));
                }
            }
            table.rows.retain(|r| r[c] != Value::Integer(pid));
        }
    }

    let library = rows_mut(&mut ipod.rows, "Library.itdb").map_err(missing)?;
    renumber_playlists(library, &playlists_touched);

    // What no song uses any more.
    let used = |library: &Rows, table: &str, column: &str, v: &Value| {
        library.table(table).is_some_and(|t| values(t, column).any(|x| &x == v))
    };
    let mut gone_albums = Vec::new();
    let mut gone_artists = Vec::new();
    if album != Value::Null && !used(library, "item", "album_pid", &album) {
        drop_row(library, "album", "pid", &album);
        gone_albums.extend(int(&album));
    } else if album != Value::Null {
        repoint_artwork(library, &album, pid);
    }
    if artist != Value::Null
        && !used(library, "item", "artist_pid", &artist)
        && !used(library, "album", "artist_pid", &artist)
    {
        drop_row(library, "artist", "pid", &artist);
        gone_artists.extend(int(&artist));
    }
    if composer != Value::Integer(0) && composer != Value::Null && !used(library, "item", "composer_pid", &composer) {
        drop_row(library, "composer", "pid", &composer);
    }
    if genre != Value::Integer(0) && genre != Value::Null && !used(library, "item", "genre_id", &genre) {
        drop_row(library, "genre_map", "id", &genre);
    }
    collate::rank_library(library);

    if !gone_albums.is_empty() {
        list_mut(&mut ipod.tree, SECTION_ALBUMS, "album list")
            .map_err(missing)?
            .retain(|a| !gone_albums.contains(&i64_at(&a.header, 0x14)));
    }
    if !gone_artists.is_empty() {
        list_mut(&mut ipod.tree, SECTION_ARTISTS, "artist list")
            .map_err(missing)?
            .retain(|a| !gone_artists.contains(&i64_at(&a.header, 0x14)));
    }
    Ok(Removed { path, title })
}

fn drop_row(library: &mut Rows, table: &str, key: &str, value: &Value) {
    if let Some(t) = library.table_mut(table)
        && let Some(c) = t.column(key)
    {
        t.rows.retain(|r| &r[c] != value);
    }
}

/// Numbers each touched playlist's songs again from 0, in their order.
fn renumber_playlists(library: &mut Rows, containers: &[Value]) {
    let Some(t) = library.table_mut("item_to_container") else {
        return;
    };
    let (Some(container), Some(order)) = (t.column("container_pid"), t.column("physical_order")) else {
        return;
    };
    for which in containers {
        let mut rows: Vec<&mut Vec<Value>> = t.rows.iter_mut().filter(|r| &r[container] == which).collect();
        rows.sort_by_key(|r| int(&r[order]).unwrap_or(i64::MAX));
        for (i, r) in rows.into_iter().enumerate() {
            r[order] = Value::Integer(i as i64);
        }
    }
}

/// An album whose artwork was the removed song's shows another of its songs'.
fn repoint_artwork(library: &mut Rows, album: &Value, removed: i64) {
    let other = library
        .table("item")
        .and_then(|t| t.find("album_pid", album).next().map(|r| t.get(r, "pid")));
    let Some(t) = library.table_mut("album") else { return };
    let (Some(pid), Some(art)) = (t.column("pid"), t.column("artwork_item_pid")) else {
        return;
    };
    for r in t.rows.iter_mut().filter(|r| &r[pid] == album) {
        if r[art] == Value::Integer(removed) {
            r[art] = other.clone().unwrap_or(Value::Integer(0));
        }
    }
}

#[cfg(test)]
mod tests;
