//! jackbird's family library (F1, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-09
//! 13:46): one shared library, kept by the service in a store of its own.
//!
//! - **Blobs**: each song is the file as it was imported, whole and never changed, named by the
//!   SHA-256 of its audio region (`blobs/ab/cd/<sha256>.<mp3|flac>`). The same audio imported again
//!   is not stored twice.
//! - **Layers**: the file's own tags (read once, kept in the catalogue) and the family's (what
//!   editors set, field by field, covers as blobs of their own in `covers/`). What everyone sees
//!   is the family's over the file's. A save writes the family's layer; no file is rewritten.
//! - **Out**: a song leaves (playback, downloads) as `jackbird_tags::write_head` of its head with
//!   the family's layer, then the blob from the end of its tags on (`Outgoing`).
//! - **A root**: to the interface the library is a folder like any other (walk, list, stat, inspect,
//!   save, rename, delete, small files): its songs sit at the paths they were imported with, under
//!   the import's name; renaming moves a song in the catalogue, deleting takes it out of it (its
//!   blob stays, for F4's trash). The interface's small files (`.meta/`, playlists) are kept in
//!   `files/`.
//! - **Importing** copies (a folder of the machine) or moves (an upload, already in `tmp/`) a file
//!   in; the same audio with other tags is kept beside the song as a suggestion, until F3.
//!
//! Like `jackbird-core`, it touches the file system (`AGENTS.md`); it adds SQLite
//! (`catalogue.db`, in the library's folder, so the folder is the whole library).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use jackbird_core::{Entry, Error, Inspection, Root, Stat, examine, head_of};
use jackbird_tags::{Cover, CoverEdit, Edit, Fields};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(test)]
mod tests;

/// The formats the library keeps.
pub const AUDIO: [&str; 2] = ["mp3", "flac"];

/// Whether a path names a song (by its extension).
pub fn is_audio(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, extension)| AUDIO.contains(&extension.to_ascii_lowercase().as_str()))
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn store_error(error: rusqlite::Error) -> Error {
    Error::Io(format!("the library's catalogue: {error}"))
}

/// The six fields, as the catalogue keeps them.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct FieldsJson {
    /// The title.
    pub title: String,
    /// The artist.
    pub artist: String,
    /// The album.
    pub album: String,
    /// The year.
    pub year: String,
    /// The genre.
    pub genre: String,
    /// The track number.
    pub track: String,
}

impl From<&Fields> for FieldsJson {
    fn from(fields: &Fields) -> Self {
        FieldsJson {
            title: fields.title.clone(),
            artist: fields.artist.clone(),
            album: fields.album.clone(),
            year: fields.year.clone(),
            genre: fields.genre.clone(),
            track: fields.track.clone(),
        }
    }
}

impl From<&FieldsJson> for Fields {
    fn from(fields: &FieldsJson) -> Self {
        Fields {
            title: fields.title.clone(),
            artist: fields.artist.clone(),
            album: fields.album.clone(),
            year: fields.year.clone(),
            genre: fields.genre.clone(),
            track: fields.track.clone(),
        }
    }
}

/// What the family's layer does to the cover.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CoverLayer {
    /// This cover, kept in `covers/` by the SHA-256 of its bytes.
    Set {
        /// Its name in `covers/`.
        hash: String,
        /// Its MIME type.
        mime: String,
    },
    /// No cover, though the file has one.
    Remove,
}

/// A layer: the fields it sets (`None` leaves the file's), and the cover.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Layer {
    /// The title it sets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The artist it sets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    /// The album it sets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    /// The year it sets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    /// The genre it sets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    /// The track number it sets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track: Option<String>,
    /// What it does to the cover.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<CoverLayer>,
}

impl Layer {
    /// Whether it changes nothing.
    pub fn is_empty(&self) -> bool {
        *self == Layer::default()
    }

    /// The fields everyone sees: this layer's over the file's.
    pub fn over(&self, file: &FieldsJson) -> FieldsJson {
        let pick = |own: &Option<String>, under: &String| own.clone().unwrap_or_else(|| under.clone());
        FieldsJson {
            title: pick(&self.title, &file.title),
            artist: pick(&self.artist, &file.artist),
            album: pick(&self.album, &file.album),
            year: pick(&self.year, &file.year),
            genre: pick(&self.genre, &file.genre),
            track: pick(&self.track, &file.track),
        }
    }
}

/// A song of the library.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Song {
    /// Its id.
    pub id: i64,
    /// Its place in the library.
    pub path: String,
    /// The SHA-256 of its audio region: its blob's name.
    pub blob: String,
    /// `mp3` or `flac`.
    pub format: String,
    /// Its blob's size.
    pub size: u64,
    /// When it was imported, in milliseconds since 1970.
    pub added: u64,
    /// When it last changed (its layer, its place).
    pub changed: u64,
    /// Its layer's version, one more on each save.
    pub version: i64,
    /// The file's own fields.
    pub file: FieldsJson,
    /// The family's layer.
    pub family: Layer,
}

impl Song {
    /// The fields everyone sees.
    pub fn fields(&self) -> FieldsJson {
        self.family.over(&self.file)
    }
}

/// Other tags someone brought with the same audio (kept until F3 makes them their layer).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Suggestion {
    /// The fields they brought.
    pub fields: FieldsJson,
    /// Who brought them.
    pub by: String,
    /// When, in milliseconds since 1970.
    pub at: u64,
}

/// What importing one file did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Imported {
    /// A new song, at this path.
    Added(String),
    /// The library had this audio already, with the same tags, at this path.
    Existing(String),
    /// The library had this audio already, at this path; the file's other tags are a suggestion.
    Suggested(String),
    /// Not a song the engine can read, and why.
    Unreadable(String),
}

/// What an import did, file by file.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// New songs.
    pub added: usize,
    /// Songs the library had, with the same tags.
    pub existing: usize,
    /// Songs the library had, with other tags (kept as suggestions).
    pub suggested: usize,
    /// Files left out, with why.
    pub unreadable: Vec<(String, String)>,
}

impl Report {
    /// Counts one file's result.
    pub fn count(&mut self, source: &str, imported: &Imported) {
        match imported {
            Imported::Added(_) => self.added += 1,
            Imported::Existing(_) => self.existing += 1,
            Imported::Suggested(_) => self.suggested += 1,
            Imported::Unreadable(why) => self.unreadable.push((source.to_owned(), why.clone())),
        }
    }
}

/// A song on its way out: `head`, then the blob's bytes `from..to`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outgoing {
    /// Its tags, with the family's layer.
    pub head: Vec<u8>,
    /// Its blob.
    pub blob: PathBuf,
    /// Where in the blob the rest starts (the end of its own tags).
    pub from: u64,
    /// Where it ends (the blob's size).
    pub to: u64,
    /// Its file name, for a download.
    pub name: String,
    /// Its MIME type.
    pub mime: &'static str,
}

impl Outgoing {
    /// Its size.
    pub fn len(&self) -> u64 {
        self.head.len() as u64 + (self.to - self.from)
    }

    /// Whether it is empty (never, for a song).
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The bytes `start..end` of it, read from the head and the blob.
    pub fn read(&self, start: u64, end: u64) -> Result<Vec<u8>, Error> {
        use std::io::{Read, Seek, SeekFrom};
        let end = end.min(self.len());
        let mut out = Vec::with_capacity(end.saturating_sub(start) as usize);
        let head = self.head.len() as u64;
        if start < head {
            out.extend_from_slice(&self.head[start as usize..end.min(head) as usize]);
        }
        if end > head {
            let from = self.from + start.max(head) - head;
            let shown = self.blob.display().to_string();
            let mut file = fs::File::open(&self.blob).map_err(|error| Error::Io(format!("{shown}: {error}")))?;
            file.seek(SeekFrom::Start(from))
                .map_err(|error| Error::Io(format!("{shown}: {error}")))?;
            let mut rest = vec![0; (end - start.max(head)) as usize];
            file.read_exact(&mut rest)
                .map_err(|error| Error::Io(format!("{shown}: {error}")))?;
            out.extend(rest);
        }
        Ok(out)
    }
}

const SCHEMA: &str = "
create table if not exists songs (
  id integer primary key,
  path text not null unique,
  blob text not null unique,
  format text not null,
  size integer not null,
  added integer not null,
  changed integer not null,
  version integer not null default 1,
  file text not null,
  family text not null default '{}'
);
create table if not exists suggestions (
  id integer primary key,
  song integer not null references songs(id) on delete cascade,
  fields text not null,
  by text not null,
  at integer not null
);
";

const SONG: &str = "select id, path, blob, format, size, added, changed, version, file, family from songs";

fn song_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<Song> {
    let file: String = row.get(8)?;
    let family: String = row.get(9)?;
    Ok(Song {
        id: row.get(0)?,
        path: row.get(1)?,
        blob: row.get(2)?,
        format: row.get(3)?,
        size: row.get::<_, i64>(4)? as u64,
        added: row.get::<_, i64>(5)? as u64,
        changed: row.get::<_, i64>(6)? as u64,
        version: row.get(7)?,
        file: serde_json::from_str(&file).unwrap_or_default(),
        family: serde_json::from_str(&family).unwrap_or_default(),
    })
}

/// A path as the library keeps it: relative, with `/`, no empty, `.` or `..` part.
pub fn clean(path: &str) -> Result<String, Error> {
    let parts: Vec<&str> = path
        .split(['/', '\\'])
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    if parts.is_empty() || parts.contains(&"..") || path.starts_with('/') {
        return Err(Error::Outside(path.to_owned()));
    }
    Ok(parts.join("/"))
}

fn name_of(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_owned()
}

/// The library.
pub struct Library {
    dir: PathBuf,
    files: Root,
    db: Mutex<Connection>,
}

impl Library {
    /// Opens the library in `dir`, making it if it is new.
    pub fn open(dir: &Path) -> Result<Library, Error> {
        let shown = dir.display().to_string();
        for part in ["blobs", "covers", "files", "tmp"] {
            fs::create_dir_all(dir.join(part)).map_err(|error| Error::Io(format!("{shown}: {error}")))?;
        }
        let files = Root::open(dir.join("files"))?;
        let db = Connection::open(dir.join("catalogue.db")).map_err(store_error)?;
        db.execute_batch("pragma foreign_keys = on; pragma journal_mode = wal;")
            .and_then(|()| db.execute_batch(SCHEMA))
            .map_err(store_error)?;
        Ok(Library {
            dir: dir.to_owned(),
            files,
            db: Mutex::new(db),
        })
    }

    /// Its folder.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Where uploads are written before they are imported (moved in from there).
    pub fn upload_path(&self) -> PathBuf {
        let unique = format!("{}-{}", now(), std::process::id());
        let count = UPLOADS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.dir.join("tmp").join(format!("upload-{unique}-{count}"))
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn blob_path(&self, hash: &str, format: &str) -> PathBuf {
        self.dir
            .join("blobs")
            .join(&hash[..2])
            .join(&hash[2..4])
            .join(format!("{hash}.{format}"))
    }

    fn cover_path(&self, hash: &str) -> PathBuf {
        self.dir.join("covers").join(hash)
    }

    /// Every song, by path.
    pub fn songs(&self) -> Result<Vec<Song>, Error> {
        let db = self.db();
        let mut query = db.prepare(&format!("{SONG} order by path")).map_err(store_error)?;
        let songs = query
            .query_map([], song_of)
            .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            .map_err(store_error)?;
        Ok(songs)
    }

    /// The song at a path.
    pub fn song(&self, path: &str) -> Option<Song> {
        self.db()
            .query_row(&format!("{SONG} where path = ?1"), [path], song_of)
            .optional()
            .ok()
            .flatten()
    }

    fn song_by_blob(&self, blob: &str) -> Option<Song> {
        self.db()
            .query_row(&format!("{SONG} where blob = ?1"), [blob], song_of)
            .optional()
            .ok()
            .flatten()
    }

    fn song_or_not_found(&self, path: &str) -> Result<Song, Error> {
        self.song(path).ok_or_else(|| Error::NotFound(path.to_owned()))
    }

    /// A free path like `wanted`: itself, or with ` (2)`, ` (3)`… before its extension.
    fn free_path(&self, wanted: &str) -> String {
        if self.song(wanted).is_none() {
            return wanted.to_owned();
        }
        let (stem, extension) = wanted.rsplit_once('.').unwrap_or((wanted, ""));
        (2..)
            .map(|n| format!("{stem} ({n}).{extension}"))
            .find(|path| self.song(path).is_none())
            .unwrap_or_default()
    }

    // -----------------------------------------------------------------------------------------
    // Importing.

    /// Imports one file as `wanted` (a library path): copied in, or moved when `take` (an
    /// upload in `tmp/`). Never changes `source` otherwise.
    pub fn import_file(&self, source: &Path, wanted: &str, by: &str, take: bool) -> Result<Imported, Error> {
        let wanted = clean(wanted)?;
        if !is_audio(&wanted) {
            return Ok(Imported::Unreadable("not an MP3 or FLAC file".into()));
        }
        let examined = match examine(source) {
            Ok(examined) if examined.layout.format.is_some() => examined,
            Ok(_) => {
                return Ok(Imported::Unreadable(
                    "not an MP3 or FLAC file the engine can read".into(),
                ));
            }
            Err(error) => return Ok(Imported::Unreadable(error.to_string())),
        };
        // The format is the content's; a name that says otherwise gets the right extension.
        let format = match examined.layout.format {
            Some(jackbird_tags::Format::Flac) => "flac",
            _ => "mp3",
        };
        let wanted = match wanted.rsplit_once('.') {
            Some((stem, extension)) if !extension.eq_ignore_ascii_case(format) => format!("{stem}.{format}"),
            _ => wanted,
        };
        let fields = FieldsJson::from(&examined.tags.0);
        let hash = examined.audio_sha256.clone();
        if let Some(song) = self.song_by_blob(&hash) {
            if take {
                let _ = fs::remove_file(source);
            }
            if song.file == fields {
                return Ok(Imported::Existing(song.path));
            }
            let known: bool = self
                .db()
                .query_row(
                    "select count(*) > 0 from suggestions where song = ?1 and fields = ?2",
                    params![song.id, serde_json::to_string(&fields).unwrap_or_default()],
                    |row| row.get(0),
                )
                .map_err(store_error)?;
            if !known {
                self.db()
                    .execute(
                        "insert into suggestions (song, fields, by, at) values (?1, ?2, ?3, ?4)",
                        params![
                            song.id,
                            serde_json::to_string(&fields).unwrap_or_default(),
                            by,
                            now() as i64
                        ],
                    )
                    .map_err(store_error)?;
            }
            return Ok(Imported::Suggested(song.path));
        }
        let blob = self.blob_path(&hash, format);
        if !blob.exists() {
            self.put_blob(source, &blob, &hash, take)?;
        } else if take {
            let _ = fs::remove_file(source);
        }
        let size = fs::metadata(&blob).map_err(|error| Error::Io(error.to_string()))?.len();
        let path = self.free_path(&wanted);
        let at = now() as i64;
        self.db()
            .execute(
                "insert into songs (path, blob, format, size, added, changed, file) values (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
                params![path, hash, format, size as i64, at, serde_json::to_string(&fields).unwrap_or_default()],
            )
            .map_err(store_error)?;
        Ok(Imported::Added(path))
    }

    /// Puts a blob in place: copied (or moved) into `tmp/`, its audio hashed again, renamed in.
    fn put_blob(&self, source: &Path, blob: &Path, hash: &str, take: bool) -> Result<(), Error> {
        let io = |error: std::io::Error| Error::Io(format!("{}: {error}", blob.display()));
        if let Some(parent) = blob.parent() {
            fs::create_dir_all(parent).map_err(io)?;
        }
        let temporary = self.upload_path();
        let moved = take && fs::rename(source, &temporary).is_ok();
        if !moved {
            fs::copy(source, &temporary).map_err(io)?;
            if take {
                let _ = fs::remove_file(source);
            }
        }
        let checked = examine(&temporary).map(|copy| copy.audio_sha256 == hash);
        if !matches!(checked, Ok(true)) {
            let _ = fs::remove_file(&temporary);
            return Err(Error::Io(format!("{}: the copy is not the file", blob.display())));
        }
        fs::rename(&temporary, blob).map_err(io)
    }

    /// Imports every MP3 and FLAC under a folder of the machine, as `name/<its path>`, telling
    /// `progress` how far it is (done, total).
    pub fn import_folder(
        &self,
        folder: &Path,
        name: &str,
        by: &str,
        mut progress: impl FnMut(usize, usize),
    ) -> Result<Report, Error> {
        let root = Root::open(folder)?;
        let files: Vec<Entry> = root.walk()?.into_iter().filter(|entry| is_audio(&entry.path)).collect();
        let mut report = Report::default();
        for (done, entry) in files.iter().enumerate() {
            progress(done, files.len());
            let imported = self.import_file(
                &root.resolve(&entry.path)?,
                &format!("{name}/{}", entry.path),
                by,
                false,
            )?;
            report.count(&entry.path, &imported);
        }
        progress(files.len(), files.len());
        Ok(report)
    }

    /// The other tags brought with a song's audio.
    pub fn suggestions(&self, path: &str) -> Result<Vec<Suggestion>, Error> {
        let song = self.song_or_not_found(path)?;
        let db = self.db();
        let mut query = db
            .prepare("select fields, by, at from suggestions where song = ?1 order by id")
            .map_err(store_error)?;
        let found = query
            .query_map([song.id], |row| {
                let fields: String = row.get(0)?;
                Ok(Suggestion {
                    fields: serde_json::from_str(&fields).unwrap_or_default(),
                    by: row.get(1)?,
                    at: row.get::<_, i64>(2)? as u64,
                })
            })
            .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            .map_err(store_error)?;
        Ok(found)
    }

    // -----------------------------------------------------------------------------------------
    // The library as a root.

    fn stat_of(song: &Song) -> Stat {
        Stat {
            folder: false,
            size: song.size,
            mtime: song.changed,
        }
    }

    /// Every file: its songs and its small files.
    pub fn walk(&self) -> Result<Vec<Entry>, Error> {
        let mut out: Vec<Entry> = self
            .songs()?
            .iter()
            .map(|song| Entry {
                path: song.path.clone(),
                name: name_of(&song.path),
                stat: Library::stat_of(song),
            })
            .collect();
        out.extend(self.files.walk()?);
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// One folder's entries.
    pub fn list(&self, relative: &str) -> Result<Vec<Entry>, Error> {
        let prefix = if relative.trim_matches('/').is_empty() {
            String::new()
        } else {
            format!("{}/", clean(relative)?)
        };
        let mut out: Vec<Entry> = Vec::new();
        for song in self.songs()? {
            let Some(rest) = song.path.strip_prefix(&prefix) else {
                continue;
            };
            let entry = match rest.split_once('/') {
                Some((folder, _)) => Entry {
                    path: format!("{prefix}{folder}"),
                    name: folder.to_owned(),
                    stat: Stat {
                        folder: true,
                        size: 0,
                        mtime: song.changed,
                    },
                },
                None => Entry {
                    path: song.path.clone(),
                    name: rest.to_owned(),
                    stat: Library::stat_of(&song),
                },
            };
            if !out.iter().any(|known| known.path == entry.path) {
                out.push(entry);
            }
        }
        match self.files.list(relative) {
            Ok(entries) => {
                for entry in entries {
                    if !out.iter().any(|known| known.path == entry.path) {
                        out.push(entry);
                    }
                }
            }
            Err(Error::NotFound(_)) => {}
            Err(error) => return Err(error),
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// A path's size and date: a song's, a folder of songs', or a small file's.
    pub fn stat(&self, relative: &str) -> Result<Option<Stat>, Error> {
        let path = clean(relative)?;
        if let Some(song) = self.song(&path) {
            return Ok(Some(Library::stat_of(&song)));
        }
        let prefix = format!("{path}/");
        if let Some(song) = self.songs()?.iter().find(|song| song.path.starts_with(&prefix)) {
            return Ok(Some(Stat {
                folder: true,
                size: 0,
                mtime: song.changed,
            }));
        }
        self.files.stat(&path)
    }

    /// A small file's bytes; songs leave through [`Library::outgoing`].
    pub fn read(&self, relative: &str) -> Result<Vec<u8>, Error> {
        if is_audio(relative) {
            return Err(Error::Outside(format!("{relative}: songs are played or downloaded")));
        }
        self.files.read(&clean(relative)?)
    }

    /// Writes a small file; songs come in by importing.
    pub fn write(&self, relative: &str, bytes: &[u8]) -> Result<(), Error> {
        if is_audio(relative) {
            return Err(Error::Outside(format!("{relative}: songs come in by importing")));
        }
        self.files.write(&clean(relative)?, bytes)
    }

    /// Makes a folder of small files (a folder of songs needs none).
    pub fn mkdir(&self, relative: &str) -> Result<(), Error> {
        self.files.mkdir(&clean(relative)?)
    }

    /// Takes a song, or a folder of songs, out of the catalogue (their blobs stay); or deletes a
    /// small file.
    pub fn delete(&self, relative: &str) -> Result<(), Error> {
        let path = clean(relative)?;
        let taken = self
            .db()
            .execute(
                "delete from songs where path = ?1 or substr(path, 1, length(?1) + 1) = ?1 || '/'",
                [&path],
            )
            .map_err(store_error)?;
        match self.files.delete(&path) {
            Err(Error::NotFound(_)) if taken > 0 => Ok(()),
            other => other,
        }
    }

    /// Moves a song, or a folder of songs, in the catalogue; or renames a small file.
    pub fn rename(&self, from: &str, to: &str) -> Result<(), Error> {
        let (from, to) = (clean(from)?, clean(to)?);
        if self.song(&to).is_some() {
            return Err(Error::Outside(format!("{to}: a song is there already")));
        }
        let at = now() as i64;
        let moved = self
            .db()
            .execute(
                "update songs set path = ?2 || substr(path, length(?1) + 1), changed = ?3
                 where path = ?1 or substr(path, 1, length(?1) + 1) = ?1 || '/'",
                params![from, to, at],
            )
            .map_err(store_error)?;
        match self.files.rename(&from, &to) {
            Err(Error::NotFound(_)) if moved > 0 => Ok(()),
            other => other,
        }
    }

    fn file_cover(&self, song: &Song) -> Result<Option<Cover>, Error> {
        let (layout, head) = head_of(&self.blob_path(&song.blob, &song.format))?;
        Ok(jackbird_tags::read_head(&head, &layout)
            .ok()
            .and_then(|tags| tags.cover))
    }

    /// The cover everyone sees: the file's, or, when the family's layer touches it, the one its
    /// song leaves with (removing the cover shown can show the file's next picture).
    fn cover(&self, song: &Song) -> Result<Option<Cover>, Error> {
        match &song.family.cover {
            None => self.file_cover(song),
            Some(CoverLayer::Set { hash, mime }) => Ok(Some(Cover {
                data: fs::read(self.cover_path(hash)).map_err(|error| Error::Io(error.to_string()))?,
                mime: mime.clone(),
            })),
            Some(CoverLayer::Remove) => {
                let out = self.outgoing(&song.path)?;
                let tail = out.read(out.len().saturating_sub(jackbird_tags::TAIL_LEN as u64), out.len())?;
                let mut want = out.head.len() as u64 + jackbird_tags::FIRST_HEAD as u64;
                loop {
                    let head = out.read(0, want)?;
                    match jackbird_tags::layout(&head, &tail, out.len())? {
                        jackbird_tags::Layout::Known(layout) => {
                            return Ok(jackbird_tags::read_head(&head, &layout)
                                .ok()
                                .and_then(|tags| tags.cover));
                        }
                        jackbird_tags::Layout::NeedHead(n) if n > want && want < out.len() => want = n,
                        jackbird_tags::Layout::NeedHead(_) => return Ok(None),
                    }
                }
            }
        }
    }

    /// The edit that writes a layer into its song's file as it leaves.
    fn edit_of(&self, layer: &Layer) -> Result<Edit, Error> {
        Ok(Edit {
            title: layer.title.clone(),
            artist: layer.artist.clone(),
            album: layer.album.clone(),
            year: layer.year.clone(),
            genre: layer.genre.clone(),
            track: layer.track.clone(),
            cover: match &layer.cover {
                None => CoverEdit::Keep,
                Some(CoverLayer::Remove) => CoverEdit::Remove,
                Some(CoverLayer::Set { hash, mime }) => CoverEdit::Set(Cover {
                    data: fs::read(self.cover_path(hash)).map_err(|error| Error::Io(error.to_string()))?,
                    mime: mime.clone(),
                }),
            },
        })
    }

    /// A song as the interface inspects it: its tags as everyone sees them (unless `known` is its
    /// full checksum, which changes with its layer), and its checksums: the blob's name, and that
    /// with the layer's version.
    pub fn inspect(&self, relative: &str, known: Option<&str>) -> Result<Inspection, Error> {
        let song = self.song_or_not_found(&clean(relative)?)?;
        let full_checksum = format!("{}-{}", song.blob, song.version);
        let tags = if known == Some(full_checksum.as_str()) {
            None
        } else {
            Some((Fields::from(&song.fields()), self.cover(&song)?))
        };
        Ok(Inspection {
            stat: Library::stat_of(&song),
            full_checksum,
            audio_checksum: song.blob.clone(),
            tags,
        })
    }

    /// Saves an edit into a song's family layer: a field set to the file's own value, or a cover
    /// that is the file's, leaves the file's. The edit is tried on the song's head first, so what
    /// the engine refuses for a file it refuses here. No file is written.
    pub fn save(&self, relative: &str, edit: &Edit) -> Result<Inspection, Error> {
        let song = self.song_or_not_found(&clean(relative)?)?;
        let mut layer = song.family.clone();
        let set = |own: &mut Option<String>, new: &Option<String>, file: &String| {
            if let Some(value) = new {
                *own = (value != file).then(|| value.clone());
            }
        };
        set(&mut layer.title, &edit.title, &song.file.title);
        set(&mut layer.artist, &edit.artist, &song.file.artist);
        set(&mut layer.album, &edit.album, &song.file.album);
        set(&mut layer.year, &edit.year, &song.file.year);
        set(&mut layer.genre, &edit.genre, &song.file.genre);
        set(&mut layer.track, &edit.track, &song.file.track);
        match &edit.cover {
            CoverEdit::Keep => {}
            CoverEdit::Set(cover) => {
                if self.file_cover(&song)?.as_ref() == Some(cover) {
                    layer.cover = None;
                } else {
                    let hash = hex(&Sha256::digest(&cover.data));
                    let path = self.cover_path(&hash);
                    if !path.exists() {
                        fs::write(&path, &cover.data).map_err(|error| Error::Io(error.to_string()))?;
                    }
                    layer.cover = Some(CoverLayer::Set {
                        hash,
                        mime: cover.mime.clone(),
                    });
                }
            }
            CoverEdit::Remove => {
                layer.cover = self.file_cover(&song)?.map(|_| CoverLayer::Remove);
            }
        }
        if layer != song.family {
            let (file_layout, head) = head_of(&self.blob_path(&song.blob, &song.format))?;
            jackbird_tags::write_head(&head, &file_layout, &self.edit_of(&layer)?)?;
            self.db()
                .execute(
                    "update songs set family = ?1, version = version + 1, changed = ?2 where id = ?3",
                    params![serde_json::to_string(&layer).unwrap_or_default(), now() as i64, song.id],
                )
                .map_err(store_error)?;
        }
        self.inspect(&song.path, None)
    }

    /// A song as it leaves: its head with the family's layer written in, then its blob.
    pub fn outgoing(&self, relative: &str) -> Result<Outgoing, Error> {
        let song = self.song_or_not_found(&clean(relative)?)?;
        let blob = self.blob_path(&song.blob, &song.format);
        let (layout, head) = head_of(&blob)?;
        let (head, from) = if song.family.is_empty() {
            (head[..layout.tags_end as usize].to_vec(), layout.tags_end)
        } else {
            let splice = jackbird_tags::write_head(&head, &layout, &self.edit_of(&song.family)?)?;
            (splice.with, splice.replace.end)
        };
        Ok(Outgoing {
            head,
            from,
            to: song.size,
            name: name_of(&song.path),
            mime: if song.format == "flac" {
                "audio/flac"
            } else {
                "audio/mpeg"
            },
            blob,
        })
    }
}

static UPLOADS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
