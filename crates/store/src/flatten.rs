//! Uploads at the root of one's music (RECORD/2026-11-03.deck-design-system.WIP.md, 2026-11-19,
//! plan E): an upload used to land at `Uploads/<who>/<path>`, `<who>` the uploader's name then, so a
//! renamed person's music split in two folders, and since shelves (SH-D1) the two levels said
//! nothing. Once, every song at `@<shelf>/Uploads/<name>/<path>` moves to `@<shelf>/<path>`, the
//! shelf's small files (`.meta/`, playlists) with it, and the playlists that list them follow.

use std::collections::HashMap;

use super::*;

/// This migration's name in the catalogue's `migrations`.
const UPLOADS_AT_ROOT: &str = "uploads-at-root";

impl Library {
    /// Whether a migration was done, by its name.
    fn migrated(&self, name: &str) -> Result<bool, Error> {
        let db = self.db();
        db.execute_batch("create table if not exists migrations (name text primary key, at integer not null)")
            .map_err(store_error)?;
        db.query_row("select count(*) > 0 from migrations where name = ?1", [name], |row| {
            row.get(0)
        })
        .map_err(store_error)
    }

    fn mark_migrated(&self, name: &str) -> Result<(), Error> {
        self.db()
            .execute(
                "insert or ignore into migrations (name, at) values (?1, ?2)",
                params![name, now() as i64],
            )
            .map(|_| ())
            .map_err(store_error)
    }

    /// Once: each song at `@<shelf>/Uploads/<name>/<path>` (the trash's too) moves to
    /// `@<shelf>/<path>`, with ` (2)`, ` (3)`… where a song is there already; the shelf's small
    /// files under `Uploads/<name>/` move with them (a folder's `.meta/` already at the root is
    /// kept, the moved one's dropped); the playlists of the shelf and its owner's own follow their
    /// songs. Waits while songs are on no shelf yet (`into_shelves`, which needs an owner). How
    /// many songs moved.
    pub fn uploads_to_root(&self) -> Result<usize, Error> {
        if self.migrated(UPLOADS_AT_ROOT)? {
            return Ok(0);
        }
        let unshelved: i64 = self
            .db()
            .query_row(
                "select count(*) from songs where substr(path, 1, 1) != '@'",
                [],
                |row| row.get(0),
            )
            .map_err(store_error)?;
        if unshelved > 0 {
            return Ok(0);
        }
        let songs: Vec<(i64, String)> = {
            let db = self.db();
            let mut statement = db
                .prepare("select id, path from songs where path like '@%/Uploads/%/%' order by path")
                .map_err(store_error)?;
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .and_then(Iterator::collect)
                .map_err(store_error)?
        };
        // Each shelf's moves, its paths within it: from, to.
        let mut moves: HashMap<i64, HashMap<String, String>> = HashMap::new();
        for (id, path) in songs {
            let Some((shelf, inner)) = on_shelf(&path) else {
                continue;
            };
            let Some(rest) = out_of_uploads(inner) else {
                continue;
            };
            let to = self.free_path(&shelf_path(shelf, rest));
            self.db()
                .execute("update songs set path = ?2 where id = ?1", params![id, to])
                .map_err(store_error)?;
            let to_inner = on_shelf(&to).map_or(rest, |(_, inner)| inner).to_owned();
            moves.entry(shelf).or_default().insert(inner.to_owned(), to_inner);
        }
        let count = moves.values().map(HashMap::len).sum();

        // The shelves' small files: the playlists rewritten where they are, then moved.
        let files = self.dir.join("files");
        let shelves: Vec<(i64, PathBuf)> = fs::read_dir(&files)
            .map_err(|error| Error::Io(error.to_string()))?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                let shelf = name.strip_prefix('@')?.parse().ok()?;
                Some((shelf, entry.path()))
            })
            .collect();
        let none = HashMap::new();
        for (shelf, dir) in &shelves {
            let moved = moves.get(shelf).unwrap_or(&none);
            for (playlist, inner) in playlists_under(dir, "") {
                let after = out_of_uploads(&inner).unwrap_or(&inner).to_owned();
                if let Ok(text) = fs::read_to_string(&playlist)
                    && let Some(text) = rewrite_playlist(&text, &inner, &after, moved)
                {
                    fs::write(&playlist, text).map_err(|error| Error::Io(error.to_string()))?;
                }
            }
            let uploads = dir.join("Uploads");
            if let Ok(entries) = fs::read_dir(&uploads) {
                // By name, as the songs went (by path): the first to arrive keeps its place.
                let mut names: Vec<PathBuf> = entries.filter_map(Result::ok).map(|entry| entry.path()).collect();
                names.sort();
                for name in names.iter().filter(|path| path.is_dir()) {
                    merge_into(name, dir).map_err(|error| Error::Io(error.to_string()))?;
                }
                let _ = fs::remove_dir(&uploads);
            }
        }

        // Each person's own playlists ("My playlists"), which list their own shelf's songs.
        for (shelf, moved) in &moves {
            let own: Vec<(String, Vec<u8>)> = {
                let db = self.db();
                let mut statement = db
                    .prepare("select path, bytes from own_files where person = ?1")
                    .map_err(store_error)?;
                statement
                    .query_map([shelf], |row| Ok((row.get(0)?, row.get(1)?)))
                    .and_then(Iterator::collect)
                    .map_err(store_error)?
            };
            for (path, bytes) in own {
                if !is_playlist(&path) {
                    continue;
                }
                let Ok(text) = String::from_utf8(bytes) else {
                    continue;
                };
                if let Some(text) = rewrite_playlist(&text, &path, &path, moved) {
                    self.db()
                        .execute(
                            "update own_files set bytes = ?3, changed = ?4 where person = ?1 and path = ?2",
                            params![shelf, path, text.into_bytes(), now() as i64],
                        )
                        .map_err(store_error)?;
                }
            }
        }
        self.mark_migrated(UPLOADS_AT_ROOT)?;
        Ok(count)
    }
}

/// `Uploads/<name>/<path>` → `<path>`; anything else, none.
pub(crate) fn out_of_uploads(inner: &str) -> Option<&str> {
    let (_, rest) = inner.strip_prefix("Uploads/")?.split_once('/')?;
    (!rest.is_empty()).then_some(rest)
}

fn is_playlist(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".m3u") || lower.ends_with(".m3u8")
}

/// The playlists in a shelf's small files: where each is on disk, and its path within the shelf.
fn playlists_under(dir: &Path, inner: &str) -> Vec<(PathBuf, String)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = if inner.is_empty() {
            name.clone()
        } else {
            format!("{inner}/{name}")
        };
        if entry.path().is_dir() {
            found.extend(playlists_under(&entry.path(), &path));
        } else if is_playlist(&name) {
            found.push((entry.path(), path));
        }
    }
    found
}

/// A playlist at `before` (its path within the shelf), to be at `after`, its lines pointing where
/// their songs went (`moved`, within the shelf) and relative to where it will be. `None` when
/// nothing changes. Comments, URLs and lines leading out of the shelf are kept as they are.
pub(crate) fn rewrite_playlist(
    text: &str,
    before: &str,
    after: &str,
    moved: &HashMap<String, String>,
) -> Option<String> {
    let folder = |path: &str| path.rsplit_once('/').map_or(String::new(), |(dir, _)| dir.to_owned());
    let (from_dir, to_dir) = (folder(before), folder(after));
    let mut changed = false;
    let lines: Vec<String> = text
        .split('\n')
        .map(|raw| {
            let (line, cr) = raw.strip_suffix('\r').map_or((raw, ""), |line| (line, "\r"));
            let entry = line.trim();
            if entry.is_empty() || entry.starts_with('#') || entry.contains("://") {
                return raw.to_owned();
            }
            let Some(target) = resolve(&from_dir, entry) else {
                return raw.to_owned();
            };
            let target = moved
                .get(&target)
                .cloned()
                .or_else(|| out_of_uploads(&target).map(str::to_owned))
                .unwrap_or(target);
            let new = relative(&to_dir, &target);
            if new == entry {
                raw.to_owned()
            } else {
                changed = true;
                format!("{new}{cr}")
            }
        })
        .collect();
    changed.then(|| lines.join("\n"))
}

/// `entry` from the folder `dir` (both within the shelf), as a path within it; none when it leads
/// out of it.
fn resolve(dir: &str, entry: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|part| !part.is_empty()).collect();
    for part in entry.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    Some(parts.join("/"))
}

/// `target` (within the shelf) as seen from the folder `dir`.
fn relative(dir: &str, target: &str) -> String {
    let from: Vec<&str> = dir.split('/').filter(|part| !part.is_empty()).collect();
    let to: Vec<&str> = target.split('/').filter(|part| !part.is_empty()).collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts = vec![".."; from.len() - common];
    parts.extend(&to[common..]);
    parts.join("/")
}

/// Moves what `from` holds into `to`, folder into folder: what is not there yet is moved; a file
/// that is (a `.meta/`'s, already the root folder's, is kept and the moved one dropped; any other
/// gets ` (2)`…); `from` is removed once empty.
fn merge_into(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    let mut entries: Vec<_> = fs::read_dir(from)?.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            if target.is_dir() {
                merge_into(&source, &target)?;
            } else if !target.exists() {
                fs::rename(&source, &target)?;
            }
        } else if !target.exists() {
            fs::rename(&source, &target)?;
        } else if source.components().any(|part| part.as_os_str() == ".meta") {
            fs::remove_file(&source)?;
        } else {
            let name = entry.file_name().to_string_lossy().into_owned();
            let (stem, extension) = name.rsplit_once('.').map_or((name.as_str(), ""), |pair| pair);
            let free = (2..)
                .map(|n| {
                    to.join(if extension.is_empty() {
                        format!("{stem} ({n})")
                    } else {
                        format!("{stem} ({n}).{extension}")
                    })
                })
                .find(|path| !path.exists());
            if let Some(free) = free {
                fs::rename(&source, free)?;
            }
        }
    }
    let _ = fs::remove_dir(from);
    Ok(())
}
