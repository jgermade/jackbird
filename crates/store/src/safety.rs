//! Safety (F4, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-09 15:18):
//!
//! - **Saves carry the version they read**: a save whose full checksum is no longer the song's
//!   (as its person sees it) is refused, with the song as it is now and who changed it.
//! - **Shared small files too**: a write that carries the size and date it read is refused when the
//!   file changed since (one's own folder needs none).
//! - **The trash**: deleted songs are kept, restored, or emptied; after 30 days they go by
//!   themselves, and a blob no song uses any more is deleted.
//! - **Snapshots** of the catalogue (and the service's people, which it hands in) into
//!   `backups/<yyyy-mm-dd>/`, kept 7 daily, 4 weekly, 12 monthly ([`keep_backups`]).
//! - **The scrub**: every blob's audio hashed again and compared with its name.
//! - **The export**: the library as a plain `Artist/Album/NN - Title.ext` tree, the family's tags
//!   written in.

use std::io::{Read, Seek, SeekFrom, Write};

use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use super::*;

/// How long a song stays in the trash: 30 days, in milliseconds.
pub const TRASH_MS: u64 = 30 * 24 * 3600 * 1000;

/// A save refused because the song changed since it was read.
#[derive(Clone, Debug)]
pub struct Stale {
    /// The song as it is now, as its person sees it.
    pub current: Inspection,
    /// Who changed the family's version last ("" for one's own version, from another device).
    pub by: String,
}

/// What a checked save did.
#[derive(Clone, Debug)]
pub enum Saved {
    /// Saved: the song as it is now.
    Done(Inspection),
    /// Refused: it changed since.
    Stale(Stale),
}

/// A song in the trash.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct TrashedSong {
    /// Its id.
    pub id: i64,
    /// Its place in the library.
    pub path: String,
    /// Who deleted it.
    pub by: String,
    /// When, in milliseconds since 1970.
    pub at: u64,
}

/// What an export did.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Exported {
    /// Songs written.
    pub written: usize,
    /// Songs that could not be, with why.
    pub failed: Vec<(String, String)>,
}

/// Days since 1970 to a civil date (Howard Hinnant's algorithm).
pub(crate) fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// A civil date to days since 1970.
pub(crate) fn days_of(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Today's name for a snapshot (UTC): `yyyy-mm-dd`.
pub fn today() -> String {
    let (year, month, day) = civil((now() / 86_400_000) as i64);
    format!("{year:04}-{month:02}-{day:02}")
}

fn parse_day(name: &str) -> Option<i64> {
    let mut parts = name.split('-').map(|part| part.parse::<i64>().ok());
    let (year, month, day) = (parts.next()??, parts.next()??, parts.next()??);
    Some(days_of(year, month, day))
}

/// Which snapshots to keep of those named (`yyyy-mm-dd`): the 7 newest, the newest of each of the
/// 4 newest weeks, and the newest of each of the 12 newest months.
pub fn keep_backups(names: &[String]) -> Vec<String> {
    let mut dated: Vec<(i64, &String)> = names
        .iter()
        .filter_map(|name| parse_day(name).map(|day| (day, name)))
        .collect();
    dated.sort_by_key(|(day, _)| std::cmp::Reverse(*day));
    let mut keep: Vec<String> = dated.iter().take(7).map(|(_, name)| (*name).clone()).collect();
    let mut by = |key: &dyn Fn(i64) -> i64, count: usize| {
        let mut seen = Vec::new();
        for (day, name) in &dated {
            let group = key(*day);
            if !seen.contains(&group) {
                seen.push(group);
                if seen.len() > count {
                    break;
                }
                if !keep.contains(name) {
                    keep.push((*name).clone());
                }
            }
        }
    };
    // Weeks from Monday (1970-01-01 was a Thursday).
    by(&|day| (day + 3).div_euclid(7), 4);
    by(
        &|day| {
            let (year, month, _) = civil(day);
            year * 12 + month
        },
        12,
    );
    keep.sort();
    keep
}

fn io_error(error: std::io::Error) -> Error {
    Error::Io(error.to_string())
}

/// A name a file system takes: no separators or reserved characters, no dots or spaces at its
/// ends, at most 100 characters; empty becomes `fallback`.
fn file_name(text: &str, fallback: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(100)
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim().to_owned();
    if cleaned.is_empty() {
        fallback.to_owned()
    } else {
        cleaned
    }
}

impl Library {
    /// Saves an edit as [`Library::save_as`] does, unless `expected` (the full checksum the saver
    /// read, as `seen` sees the song) is no longer the song's. `by` is who saves (kept for the
    /// family's layer).
    pub fn save_checked(
        &self,
        relative: &str,
        edit: &Edit,
        scope: Scope,
        seen: Viewer,
        expected: Option<&str>,
        by: &str,
    ) -> Result<Saved, Error> {
        let path = clean(relative)?;
        if let Some(expected) = expected {
            let current = self.inspect_as(&path, None, seen)?;
            if current.full_checksum != expected {
                let by = self
                    .db()
                    .query_row(
                        "select coalesce(changed_by, '') from songs where path = ?1 and trashed is null",
                        [&path],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(store_error)?
                    .unwrap_or_default();
                return Ok(Saved::Stale(Stale { current, by }));
            }
        }
        let saved = self.save_as(&path, edit, scope)?;
        if scope == Scope::Family {
            self.db()
                .execute(
                    "update songs set changed_by = ?1 where path = ?2 and trashed is null",
                    params![by, path],
                )
                .map_err(store_error)?;
        }
        // The saver sees what they just saved, through their own view.
        Ok(Saved::Done(if seen.person.is_some() {
            self.inspect_as(&path, None, seen)?
        } else {
            saved
        }))
    }

    /// Writes a small file as [`Library::write_as`] does, unless `expected` (its size and date when
    /// it was read) is no longer the file's; whether it was written. One's own folder needs none.
    pub fn write_checked(
        &self,
        relative: &str,
        bytes: &[u8],
        viewer: Viewer,
        expected: Option<(u64, u64)>,
    ) -> Result<bool, Error> {
        let path = clean(relative)?;
        if let Some((size, mtime)) = expected
            && !is_own(&path)
            && let Some(now) = self.stat(&path)?
            && (now.size, now.mtime) != (size, mtime)
        {
            return Ok(false);
        }
        self.write_as(&path, bytes, viewer)?;
        Ok(true)
    }

    // -----------------------------------------------------------------------------------------
    // The trash.

    /// The songs in the trash, the latest deleted first.
    pub fn trash(&self) -> Result<Vec<TrashedSong>, Error> {
        let db = self.db();
        let mut query = db
            .prepare("select id, path, coalesce(trashed_by, ''), trashed from songs where trashed is not null order by trashed desc, path")
            .map_err(store_error)?;
        let songs = query
            .query_map([], |row| {
                Ok(TrashedSong {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    by: row.get(2)?,
                    at: row.get::<_, i64>(3)? as u64,
                })
            })
            .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            .map_err(store_error)?;
        Ok(songs)
    }

    /// Brings a song back from the trash; its path.
    pub fn restore(&self, id: i64) -> Result<String, Error> {
        let path: Option<String> = self
            .db()
            .query_row(
                "select path from songs where id = ?1 and trashed is not null",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(store_error)?;
        let path = path.ok_or_else(|| Error::NotFound(format!("song {id} in the trash")))?;
        self.db()
            .execute(
                "update songs set trashed = null, trashed_by = null, changed = ?2 where id = ?1",
                params![id, now() as i64],
            )
            .map_err(store_error)?;
        Ok(path)
    }

    /// Empties the trash of the songs deleted before `before` (all of them, given none): they leave
    /// the catalogue with their layers, favourites and plays, and their blobs are deleted. How many.
    pub fn empty_trash(&self, before: Option<u64>) -> Result<usize, Error> {
        let before = before.map_or(i64::MAX, |before| before as i64);
        let gone: Vec<(String, String)> = {
            let db = self.db();
            let mut query = db
                .prepare("select blob, format from songs where trashed is not null and trashed < ?1")
                .map_err(store_error)?;
            query
                .query_map([before], |row| Ok((row.get(0)?, row.get(1)?)))
                .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
                .map_err(store_error)?
        };
        self.db()
            .execute("delete from songs where trashed is not null and trashed < ?1", [before])
            .map_err(store_error)?;
        for (blob, format) in &gone {
            // A blob is its audio's: gone once no song, on any shelf, uses it.
            let used: bool = self
                .db()
                .query_row("select count(*) > 0 from songs where blob = ?1", [blob], |row| {
                    row.get(0)
                })
                .unwrap_or(true);
            if !used {
                let _ = fs::remove_file(self.blob_path(blob, format));
            }
        }
        Ok(gone.len())
    }

    /// Empties what has been in the trash for 30 days.
    pub fn expire_trash(&self) -> Result<usize, Error> {
        self.empty_trash(Some(now().saturating_sub(TRASH_MS)))
    }

    // -----------------------------------------------------------------------------------------
    // Snapshots.

    /// Where snapshots are kept.
    pub fn backups_dir(&self) -> PathBuf {
        self.dir.join("backups")
    }

    /// Copies the catalogue, whole and consistent, to `to` (SQLite's `VACUUM INTO`).
    pub fn snapshot_catalogue(&self, to: &Path) -> Result<(), Error> {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        let _ = fs::remove_file(to);
        let target = to.display().to_string().replace('\'', "''");
        self.db()
            .execute_batch(&format!("vacuum into '{target}'"))
            .map_err(store_error)
    }

    /// The snapshots there are, oldest first.
    pub fn backups(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.backups_dir())
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| entry.path().is_dir())
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .filter(|name| parse_day(name).is_some())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    /// Takes today's snapshot of the catalogue into `backups/<today>/`, and gives its folder for
    /// the service to put its own database beside it.
    pub fn snapshot(&self) -> Result<PathBuf, Error> {
        let folder = self.backups_dir().join(today());
        self.snapshot_catalogue(&folder.join("catalogue.db"))?;
        Ok(folder)
    }

    /// Deletes the snapshots [`keep_backups`] does not keep; their names.
    pub fn rotate_backups(&self) -> Result<Vec<String>, Error> {
        let names = self.backups();
        let keep = keep_backups(&names);
        let mut removed = Vec::new();
        for name in names.into_iter().filter(|name| !keep.contains(name)) {
            fs::remove_dir_all(self.backups_dir().join(&name)).map_err(io_error)?;
            removed.push(name);
        }
        Ok(removed)
    }

    // -----------------------------------------------------------------------------------------
    // The scrub.

    /// Hashes every blob's audio again; those whose hash is not their name, with the songs that
    /// use them (in the trash too). Tells `progress` how far it is (done, total).
    pub fn scrub(&self, mut progress: impl FnMut(usize, usize)) -> Result<Vec<(String, Vec<String>)>, Error> {
        let mut blobs = Vec::new();
        let mut folders = vec![self.dir.join("blobs")];
        while let Some(folder) = folders.pop() {
            for entry in fs::read_dir(&folder).map_err(io_error)?.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    folders.push(path);
                } else {
                    blobs.push(path);
                }
            }
        }
        blobs.sort();
        let mut bad = Vec::new();
        for (done, blob) in blobs.iter().enumerate() {
            progress(done, blobs.len());
            let name = blob
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default();
            let sound = examine(blob)
                .map(|examined| examined.audio_sha256 == name)
                .unwrap_or(false);
            if !sound {
                let db = self.db();
                let mut query = db
                    .prepare("select path from songs where blob = ?1")
                    .map_err(store_error)?;
                let paths = query
                    .query_map([&name], |row| row.get(0))
                    .and_then(|rows| rows.collect::<Result<Vec<String>, _>>())
                    .map_err(store_error)?;
                bad.push((name, paths));
            }
        }
        progress(blobs.len(), blobs.len());
        Ok(bad)
    }

    // -----------------------------------------------------------------------------------------
    // The export.

    /// Writes the library to `to` as `Artist/Album/NN - Title.ext`, each song with the family's
    /// tags in it. Tells `progress` how far it is (done, total).
    pub fn export(&self, to: &Path, mut progress: impl FnMut(usize, usize)) -> Result<Exported, Error> {
        let songs = self.songs()?;
        let mut exported = Exported::default();
        let mut used: Vec<PathBuf> = Vec::new();
        for (done, song) in songs.iter().enumerate() {
            progress(done, songs.len());
            let fields = song.fields();
            let number: String = fields.track.chars().take_while(char::is_ascii_digit).collect();
            let stem = name_of(&song.path);
            let stem = stem.rsplit_once('.').map_or(stem.as_str(), |(stem, _)| stem);
            let title = file_name(&fields.title, &file_name(stem, "Untitled"));
            let name = if number.is_empty() {
                title
            } else {
                format!("{:0>2} - {title}", number)
            };
            let folder = to
                .join(file_name(&fields.artist, "Unknown artist"))
                .join(file_name(&fields.album, "Unknown album"));
            let mut target = folder.join(format!("{name}.{}", song.format));
            let mut n = 2;
            while used.contains(&target) {
                target = folder.join(format!("{name} ({n}).{}", song.format));
                n += 1;
            }
            used.push(target.clone());
            let written = (|| -> Result<(), Error> {
                fs::create_dir_all(&folder).map_err(io_error)?;
                let out = self.outgoing(&song.path)?;
                let mut file = fs::File::create(&target).map_err(io_error)?;
                file.write_all(&out.head).map_err(io_error)?;
                let mut blob = fs::File::open(&out.blob).map_err(io_error)?;
                blob.seek(SeekFrom::Start(out.from)).map_err(io_error)?;
                std::io::copy(&mut blob.take(out.to - out.from), &mut file).map_err(io_error)?;
                file.sync_all().map_err(io_error)
            })();
            match written {
                Ok(()) => exported.written += 1,
                Err(error) => exported.failed.push((song.path.clone(), error.to_string())),
            }
        }
        progress(songs.len(), songs.len());
        Ok(exported)
    }
}
