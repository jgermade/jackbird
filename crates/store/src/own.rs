//! Each person's own, in the library (F3, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md,
//! 2026-11-09 14:39): a layer of their own over the family's, favourites, the songs they played,
//! and playlists of their own.
//!
//! - **Layers**: what a person sees, plays and downloads is their layer over the family's over
//!   the file's, unless they chose to see the family's version ([`Viewer`]).
//! - **My playlists**: a folder of the library that is each person's own: their playlists
//!   (`.m3u`, kept in the catalogue, not in `files/`), and two made from what they did,
//!   `Favourites.m3u` (written, it sets their favourites) and `Recently played.m3u` (read only;
//!   deleting it clears their history). The interface's playlists work on them as on any other.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use super::*;

pub(crate) const SCHEMA: &str = "
create table if not exists own_layers (
  person integer not null,
  song integer not null references songs(id) on delete cascade,
  layer text not null,
  version integer not null default 1,
  primary key (person, song)
);
create table if not exists favourites (
  person integer not null,
  song integer not null references songs(id) on delete cascade,
  at integer not null,
  primary key (person, song)
);
create table if not exists plays (
  id integer primary key,
  person integer not null,
  song integer not null references songs(id) on delete cascade,
  at integer not null
);
create table if not exists shares (
  owner integer not null,
  person integer not null,
  primary key (owner, person)
);
create table if not exists own_files (
  person integer not null,
  path text not null,
  bytes blob not null,
  changed integer not null,
  primary key (person, path)
);
";

/// The folder of the library that is each person's own.
pub const OWN: &str = "My playlists";
/// Their favourites, as a playlist.
pub const FAVOURITES: &str = "My playlists/Favourites.m3u";
/// What they played, newest first, as a playlist.
pub const RECENT: &str = "My playlists/Recently played.m3u";

/// How many plays `Recently played` lists.
const RECENT_PLAYS: u32 = 200;

/// Who looks at the library, and whether they see their own version or the family's.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Viewer {
    /// The person (none: the family's version, and no folder of one's own).
    pub person: Option<i64>,
    /// Whether their own layer is shown.
    pub mine: bool,
}

impl Viewer {
    /// A person seeing their own version.
    pub fn mine(person: i64) -> Viewer {
        Viewer {
            person: Some(person),
            mine: true,
        }
    }

    /// A person, seeing their own version or the family's.
    pub fn of(person: i64, mine: bool) -> Viewer {
        Viewer {
            person: Some(person),
            mine,
        }
    }
}

/// Which layer a save writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// The family's, for everyone.
    Family,
    /// This person's own.
    Mine(i64),
}

/// What a song's tags are made of, for its Info.
#[derive(Serialize, Clone, Debug)]
pub struct Layers {
    /// The file's own.
    pub file: FieldsJson,
    /// What the family's layer sets.
    pub family: Layer,
    /// What the person's own layer sets.
    pub mine: Layer,
    /// Other tags brought with its audio.
    pub suggestions: Vec<Suggestion>,
    /// Whether it is one of the person's favourites.
    pub favourite: bool,
}

/// Whether a path is in a person's own folder.
pub fn is_own(path: &str) -> bool {
    path == OWN || path.starts_with(&format!("{OWN}/"))
}

/// Who a shelf is shared with: everyone (newcomers included), or these people.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Shares {
    /// With everyone.
    pub everyone: bool,
    /// With these people (when not with everyone).
    pub people: Vec<i64>,
}

/// In `shares`, the person who stands for everyone.
const EVERYONE: i64 = 0;

/// A playlist of `person`'s own folder: its songs relative to it, on their own shelf (another
/// shelf's songs are another root's, out of its reach; a song on no shelf is as it was).
fn m3u(person: i64, paths: &[String]) -> Vec<u8> {
    let mut text = String::from("#EXTM3U\n");
    for path in paths {
        let inner = match on_shelf(path) {
            Some((shelf, inner)) if shelf == person => inner,
            Some(_) => continue,
            None => path,
        };
        text.push_str("../");
        text.push_str(inner);
        text.push('\n');
    }
    text.into_bytes()
}

/// The library paths a playlist of the own folder lists.
fn entries_of(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let mut parts: Vec<&str> = OWN.split('/').collect();
            for part in line.split(['/', '\\']) {
                match part {
                    "" | "." => {}
                    ".." => {
                        parts.pop()?;
                    }
                    part => parts.push(part),
                }
            }
            (!parts.is_empty()).then(|| parts.join("/"))
        })
        .collect()
}

fn generated(path: &str) -> bool {
    path == FAVOURITES || path == RECENT
}

impl Library {
    fn song_by_id(&self, id: i64) -> Option<Song> {
        self.db()
            .query_row(&format!("{SONG} where id = ?1"), [id], song_of)
            .optional()
            .ok()
            .flatten()
    }

    /// A person's own layer of a song, and its version.
    pub(crate) fn own_layer(&self, person: i64, song: i64) -> Option<(Layer, i64)> {
        self.db()
            .query_row(
                "select layer, version from own_layers where person = ?1 and song = ?2",
                [person, song],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .ok()
            .flatten()
            .map(|(layer, version)| (serde_json::from_str(&layer).unwrap_or_default(), version))
    }

    /// Keeps a person's own layer of a song; an empty one is forgotten.
    pub(crate) fn put_own_layer(&self, person: i64, song: i64, layer: &Layer) -> Result<(), Error> {
        let db = self.db();
        if layer.is_empty() {
            db.execute("delete from own_layers where person = ?1 and song = ?2", [person, song])
        } else {
            db.execute(
                "insert into own_layers (person, song, layer) values (?1, ?2, ?3)
                 on conflict (person, song) do update set layer = excluded.layer, version = own_layers.version + 1",
                params![person, song, serde_json::to_string(layer).unwrap_or_default()],
            )
        }
        .map_err(store_error)?;
        Ok(())
    }

    /// The layer `viewer` sees of a song, and its version (which changes with either layer).
    pub(crate) fn seen(&self, song: &Song, viewer: Viewer) -> (Layer, String) {
        match (viewer.mine, viewer.person) {
            (true, Some(person)) => match self.own_layer(person, song.id) {
                Some((own, version)) => (own.on(&song.family), format!("{}-{person}.{version}", song.version)),
                None => (song.family.clone(), song.version.to_string()),
            },
            _ => (song.family.clone(), song.version.to_string()),
        }
    }

    /// Other tags someone brought with a song's audio become their own layer of it (over the
    /// family's version; their cover, if they had set one, stays).
    pub(crate) fn take_as_own(&self, person: i64, song: &Song, fields: &FieldsJson) -> Result<(), Error> {
        let under = song.fields();
        let pick = |brought: &String, under: &String| (brought != under).then(|| brought.clone());
        let mut layer = self
            .own_layer(person, song.id)
            .map(|(layer, _)| layer)
            .unwrap_or_default();
        layer.title = pick(&fields.title, &under.title);
        layer.artist = pick(&fields.artist, &under.artist);
        layer.album = pick(&fields.album, &under.album);
        layer.year = pick(&fields.year, &under.year);
        layer.genre = pick(&fields.genre, &under.genre);
        layer.track = pick(&fields.track, &under.track);
        layer.disc = pick(&fields.disc, &under.disc);
        layer.album_artist = pick(&fields.album_artist, &under.album_artist);
        layer.compilation = pick(&fields.compilation, &under.compilation);
        self.put_own_layer(person, song.id, &layer)
    }

    /// Forgets a person's own layer of a song: they see the family's version again.
    pub fn forget_mine(&self, relative: &str, person: i64) -> Result<(), Error> {
        let song = self.song_or_not_found(&clean(relative)?)?;
        self.put_own_layer(person, song.id, &Layer::default())
    }

    /// What a song's tags are made of, as a person sees them.
    pub fn layers(&self, relative: &str, person: Option<i64>) -> Result<Layers, Error> {
        let song = self.song_or_not_found(&clean(relative)?)?;
        let mine = person
            .and_then(|person| self.own_layer(person, song.id))
            .map(|(layer, _)| layer)
            .unwrap_or_default();
        let favourite = match person {
            Some(person) => self
                .db()
                .query_row(
                    "select count(*) > 0 from favourites where person = ?1 and song = ?2",
                    [person, song.id],
                    |row| row.get(0),
                )
                .map_err(store_error)?,
            None => false,
        };
        Ok(Layers {
            suggestions: self.suggestions(&song.path)?,
            file: song.file,
            family: song.family,
            mine,
            favourite,
        })
    }

    /// Applies a suggestion to the family's layer (an editor's choice).
    pub fn apply_suggestion(&self, relative: &str, id: i64) -> Result<Inspection, Error> {
        let path = clean(relative)?;
        let suggestion = self
            .suggestions(&path)?
            .into_iter()
            .find(|suggestion| suggestion.id == id)
            .ok_or_else(|| Error::NotFound(format!("{path}: suggestion {id}")))?;
        self.save_as(&path, &Edit::all(&Fields::from(&suggestion.fields)), Scope::Family)
    }

    // -----------------------------------------------------------------------------------------
    // Favourites and plays.

    /// Marks a song as one of a person's favourites, or not.
    pub fn set_favourite(&self, person: i64, relative: &str, on: bool) -> Result<(), Error> {
        let song = self.song_or_not_found(&clean(relative)?)?;
        let db = self.db();
        if on {
            db.execute(
                "insert or ignore into favourites (person, song, at) values (?1, ?2, ?3)",
                params![person, song.id, now() as i64],
            )
        } else {
            db.execute(
                "delete from favourites where person = ?1 and song = ?2",
                [person, song.id],
            )
        }
        .map_err(store_error)?;
        Ok(())
    }

    /// A person's favourites, in the order they were marked.
    pub fn favourites(&self, person: i64) -> Result<Vec<String>, Error> {
        let db = self.db();
        let mut query = db
            .prepare("select songs.path from favourites join songs on songs.id = favourites.song where person = ?1 and songs.trashed is null order by at, songs.path")
            .map_err(store_error)?;
        let paths = query
            .query_map([person], |row| row.get(0))
            .and_then(|rows| rows.collect::<Result<Vec<String>, _>>())
            .map_err(store_error)?;
        Ok(paths)
    }

    fn set_favourites(&self, person: i64, paths: &[String]) -> Result<(), Error> {
        // The playlist's paths are the person's shelf's (or, from before shelves, the library's).
        let ids: Vec<i64> = paths
            .iter()
            .filter_map(|path| self.song(&shelf_path(person, path)).or_else(|| self.song(path)))
            .map(|song| song.id)
            .collect();
        let at = now() as i64;
        let db = self.db();
        db.execute("delete from favourites where person = ?1", [person])
            .map_err(store_error)?;
        for (offset, id) in ids.iter().enumerate() {
            db.execute(
                "insert or ignore into favourites (person, song, at) values (?1, ?2, ?3)",
                params![person, id, at + offset as i64],
            )
            .map_err(store_error)?;
        }
        Ok(())
    }

    /// Records that a person played a song.
    pub fn played(&self, person: i64, relative: &str) -> Result<(), Error> {
        let song = self.song_or_not_found(&clean(relative)?)?;
        self.db()
            .execute(
                "insert into plays (person, song, at) values (?1, ?2, ?3)",
                params![person, song.id, now() as i64],
            )
            .map_err(store_error)?;
        Ok(())
    }

    /// What a person played, newest first: each song once, at its last play.
    pub fn history(&self, person: i64, limit: u32) -> Result<Vec<(String, u64)>, Error> {
        let db = self.db();
        let mut query = db
            .prepare(
                "select songs.path, max(plays.at) as last from plays join songs on songs.id = plays.song
                 where person = ?1 and songs.trashed is null group by plays.song order by last desc, plays.song limit ?2",
            )
            .map_err(store_error)?;
        let plays = query
            .query_map(params![person, limit], |row| {
                Ok((row.get(0)?, row.get::<_, i64>(1)? as u64))
            })
            .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            .map_err(store_error)?;
        Ok(plays)
    }

    /// Clears what a person played.
    pub fn clear_history(&self, person: i64) -> Result<(), Error> {
        self.db()
            .execute("delete from plays where person = ?1", [person])
            .map_err(store_error)?;
        Ok(())
    }

    // -----------------------------------------------------------------------------------------
    // The own folder.

    fn latest(&self, sql: &str, person: i64) -> u64 {
        self.db()
            .query_row(sql, [person], |row| row.get::<_, Option<i64>>(0))
            .ok()
            .flatten()
            .unwrap_or(0) as u64
    }

    fn own_entries(&self, person: i64) -> Result<Vec<Entry>, Error> {
        let file = |path: &str, size: usize, mtime: u64| Entry {
            path: path.to_owned(),
            name: name_of(path),
            stat: Stat {
                folder: false,
                size: size as u64,
                mtime,
            },
        };
        let mut out = vec![
            file(
                FAVOURITES,
                m3u(person, &self.favourites(person)?).len(),
                self.latest("select max(at) from favourites where person = ?1", person),
            ),
            file(
                RECENT,
                self.read_own(person, RECENT)?.len(),
                self.latest("select max(at) from plays where person = ?1", person),
            ),
        ];
        let db = self.db();
        let mut query = db
            .prepare("select path, length(bytes), changed from own_files where person = ?1 order by path")
            .map_err(store_error)?;
        let rows = query
            .query_map([person], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
            })
            .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            .map_err(store_error)?;
        out.extend(
            rows.into_iter()
                .map(|(path, size, changed)| file(&path, size as usize, changed as u64)),
        );
        Ok(out)
    }

    fn read_own(&self, person: i64, path: &str) -> Result<Vec<u8>, Error> {
        match path {
            FAVOURITES => Ok(m3u(person, &self.favourites(person)?)),
            RECENT => Ok(m3u(
                person,
                &self
                    .history(person, RECENT_PLAYS)?
                    .into_iter()
                    .map(|(path, _)| path)
                    .collect::<Vec<_>>(),
            )),
            _ => self
                .db()
                .query_row(
                    "select bytes from own_files where person = ?1 and path = ?2",
                    params![person, path],
                    |row| row.get(0),
                )
                .optional()
                .map_err(store_error)?
                .ok_or_else(|| Error::NotFound(path.to_owned())),
        }
    }

    fn person_of(viewer: Viewer, path: &str) -> Result<i64, Error> {
        viewer
            .person
            .ok_or_else(|| Error::Outside(format!("{path}: one's own folder needs someone")))
    }

    /// Every file, as a person sees the library: with their own folder.
    pub fn walk_as(&self, viewer: Viewer) -> Result<Vec<Entry>, Error> {
        let mut out = self.walk()?;
        if let Some(person) = viewer.person {
            out.retain(|entry| !is_own(&entry.path));
            out.extend(self.own_entries(person)?);
            out.sort_by(|a, b| a.path.cmp(&b.path));
        }
        Ok(out)
    }

    /// One folder's entries, as a person sees it.
    pub fn list_as(&self, relative: &str, viewer: Viewer) -> Result<Vec<Entry>, Error> {
        let Some(person) = viewer.person else {
            return self.list(relative);
        };
        let path = relative.trim_matches('/');
        if is_own(path) {
            return Ok(if path == OWN {
                self.own_entries(person)?
            } else {
                Vec::new()
            });
        }
        let mut out: Vec<Entry> = self
            .list(relative)?
            .into_iter()
            .filter(|entry| !is_own(&entry.path))
            .collect();
        if path.is_empty() {
            out.push(Entry {
                path: OWN.to_owned(),
                name: OWN.to_owned(),
                stat: Stat {
                    folder: true,
                    size: 0,
                    mtime: 0,
                },
            });
            out.sort_by(|a, b| a.name.cmp(&b.name));
        }
        Ok(out)
    }

    /// A path's size and date, as a person sees it.
    pub fn stat_as(&self, relative: &str, viewer: Viewer) -> Result<Option<Stat>, Error> {
        let path = clean(relative)?;
        match viewer.person {
            Some(_) if path == OWN => Ok(Some(Stat {
                folder: true,
                size: 0,
                mtime: 0,
            })),
            Some(person) if is_own(&path) => Ok(self
                .own_entries(person)?
                .into_iter()
                .find(|entry| entry.path == path)
                .map(|entry| entry.stat)),
            _ => self.stat(&path),
        }
    }

    /// A small file's bytes, as a person sees them.
    pub fn read_as(&self, relative: &str, viewer: Viewer) -> Result<Vec<u8>, Error> {
        let path = clean(relative)?;
        if is_own(&path) {
            return self.read_own(Library::person_of(viewer, &path)?, &path);
        }
        self.read(&path)
    }

    /// Writes a small file: in one's own folder, one's playlist (their favourites, written to
    /// `Favourites.m3u`); elsewhere, the library's.
    pub fn write_as(&self, relative: &str, bytes: &[u8], viewer: Viewer) -> Result<(), Error> {
        let path = clean(relative)?;
        if !is_own(&path) {
            return self.write(&path, bytes);
        }
        let person = Library::person_of(viewer, &path)?;
        match path.as_str() {
            FAVOURITES => self.set_favourites(person, &entries_of(bytes)),
            RECENT => Err(Error::Outside(format!("{path}: what was played is not written"))),
            _ => {
                self.db()
                    .execute(
                        "insert into own_files (person, path, bytes, changed) values (?1, ?2, ?3, ?4)
                         on conflict (person, path) do update set bytes = excluded.bytes, changed = excluded.changed",
                        params![person, path, bytes, now() as i64],
                    )
                    .map_err(store_error)?;
                Ok(())
            }
        }
    }

    /// Deletes: in one's own folder, a playlist (`Favourites.m3u` empties one's favourites,
    /// `Recently played.m3u` clears one's history); elsewhere, as [`Library::delete`].
    pub fn delete_as(&self, relative: &str, viewer: Viewer) -> Result<(), Error> {
        let path = clean(relative)?;
        if !is_own(&path) {
            return self.delete(&path);
        }
        let person = Library::person_of(viewer, &path)?;
        match path.as_str() {
            FAVOURITES => self.set_favourites(person, &[]),
            RECENT => self.clear_history(person),
            _ => {
                let gone = self
                    .db()
                    .execute(
                        "delete from own_files where person = ?1 and path = ?2",
                        params![person, path],
                    )
                    .map_err(store_error)?;
                if gone == 0 { Err(Error::NotFound(path)) } else { Ok(()) }
            }
        }
    }

    /// Renames: within one's own folder, one's playlists; elsewhere, as [`Library::rename`].
    pub fn rename_as(&self, from: &str, to: &str, viewer: Viewer) -> Result<(), Error> {
        let (from, to) = (clean(from)?, clean(to)?);
        match (is_own(&from), is_own(&to)) {
            (false, false) => self.rename(&from, &to),
            (true, true) if !generated(&from) && !generated(&to) => {
                let person = Library::person_of(viewer, &from)?;
                let moved = self
                    .db()
                    .execute(
                        "update own_files set path = ?3, changed = ?4 where person = ?1 and path = ?2",
                        params![person, from, to, now() as i64],
                    )
                    .map_err(store_error)?;
                if moved == 0 { Err(Error::NotFound(from)) } else { Ok(()) }
            }
            _ => Err(Error::Outside(format!("{from} → {to}: not across one's own folder"))),
        }
    }

    /// Who `owner`'s shelf is shared with.
    pub fn shares(&self, owner: i64) -> Result<Shares, Error> {
        let db = self.db();
        let mut query = db
            .prepare("select person from shares where owner = ?1 order by person")
            .map_err(store_error)?;
        let people: Vec<i64> = query
            .query_map([owner], |row| row.get(0))
            .and_then(|rows| rows.collect::<Result<_, _>>())
            .map_err(store_error)?;
        Ok(Shares {
            everyone: people.contains(&EVERYONE),
            people: people.into_iter().filter(|person| *person != EVERYONE).collect(),
        })
    }

    /// Shares `owner`'s shelf with everyone, or with these people (none: with no one).
    pub fn set_shares(&self, owner: i64, everyone: bool, people: &[i64]) -> Result<(), Error> {
        let db = self.db();
        db.execute("delete from shares where owner = ?1", [owner])
            .map_err(store_error)?;
        let with: Vec<i64> = if everyone {
            vec![EVERYONE]
        } else {
            people
                .iter()
                .copied()
                .filter(|person| *person != owner && *person != EVERYONE)
                .collect()
        };
        for person in with {
            db.execute(
                "insert or ignore into shares (owner, person) values (?1, ?2)",
                params![owner, person],
            )
            .map_err(store_error)?;
        }
        Ok(())
    }

    /// Whether `person` may see `owner`'s shelf: their own, or shared with them.
    pub fn may_see(&self, person: i64, owner: i64) -> bool {
        person == owner
            || self
                .db()
                .query_row(
                    "select count(*) > 0 from shares where owner = ?1 and person in (?2, ?3)",
                    params![owner, person, EVERYONE],
                    |row| row.get(0),
                )
                .unwrap_or(false)
    }

    /// The people whose shelves `person` may see, besides their own.
    pub fn shared_with(&self, person: i64) -> Result<Vec<i64>, Error> {
        let db = self.db();
        let mut query = db
            .prepare("select distinct owner from shares where person in (?1, ?2) and owner != ?1 order by owner")
            .map_err(store_error)?;
        let owners = query
            .query_map(params![person, EVERYONE], |row| row.get(0))
            .and_then(|rows| rows.collect::<Result<_, _>>())
            .map_err(store_error)?;
        Ok(owners)
    }

    /// The song a play or a favourite names, by id (for tests and the service).
    pub fn song_path(&self, id: i64) -> Option<String> {
        self.song_by_id(id).map(|song| song.path)
    }
}
