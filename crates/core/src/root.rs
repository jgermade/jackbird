//! A root: a folder the person opened, and the files under it, reached by
//! paths relative to it. Nothing outside it can be reached: a path that is
//! absolute, climbs out with `..`, or goes through a link that leads out is
//! refused, as the browser's folder permission would.

use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Why something could not be done.
#[derive(Debug)]
pub enum Error {
    /// The path is not under the root, or not a relative path.
    Outside(String),
    /// What was opened as a root is not a folder.
    NotAFolder(String),
    /// Nothing at that path.
    NotFound(String),
    /// The system said no.
    Io(String),
    /// The tag engine said no (its code is for the interface).
    Tags(jackbird_tags::Error),
}

impl Error {
    /// A stable code for the interface: the tag engine's own codes, or these.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Outside(_) => "outside",
            Error::NotAFolder(_) => "not-a-folder",
            Error::NotFound(_) => "not-found",
            Error::Io(_) => "io",
            Error::Tags(error) => error.code(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Outside(path) => write!(f, "{path:?} is not inside the folder"),
            Error::NotAFolder(path) => write!(f, "{path:?} is not a folder"),
            Error::NotFound(path) => write!(f, "{path:?} was not found"),
            Error::Io(why) => write!(f, "{why}"),
            Error::Tags(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<jackbird_tags::Error> for Error {
    fn from(error: jackbird_tags::Error) -> Self {
        Error::Tags(error)
    }
}

pub(crate) fn io(path: &str) -> impl Fn(io::Error) -> Error + '_ {
    move |error| match error.kind() {
        io::ErrorKind::NotFound => Error::NotFound(path.to_owned()),
        _ => Error::Io(format!("{path}: {error}")),
    }
}

/// A file's or folder's size and date (milliseconds since 1970).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stat {
    /// Whether it is a folder.
    pub folder: bool,
    /// Its size in bytes.
    pub size: u64,
    /// When it last changed, in milliseconds since 1970.
    pub mtime: u64,
}

impl Stat {
    pub(crate) fn of(metadata: &fs::Metadata) -> Stat {
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |since| since.as_millis() as u64);
        Stat {
            folder: metadata.is_dir(),
            size: metadata.len(),
            mtime,
        }
    }
}

/// One entry of a listing or a walk: its path relative to the root (with `/`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// Its path relative to the root.
    pub path: String,
    /// Its name.
    pub name: String,
    /// Its size and date.
    pub stat: Stat,
}

/// An open folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Root {
    path: PathBuf,
}

impl Root {
    /// Opens a folder as a root.
    pub fn open(path: impl AsRef<Path>) -> Result<Root, Error> {
        let shown = path.as_ref().display().to_string();
        let path = fs::canonicalize(path.as_ref()).map_err(io(&shown))?;
        if !path.is_dir() {
            return Err(Error::NotAFolder(shown));
        }
        Ok(Root { path })
    }

    /// The folder's own path (resolved).
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The folder's name, for its tab.
    pub fn name(&self) -> String {
        self.path.file_name().map_or_else(
            || self.path.display().to_string(),
            |name| name.to_string_lossy().into_owned(),
        )
    }

    /// Where a relative path is on disk, if it is under the root: no absolute
    /// path, no `..`, and no link on the way that leads out.
    pub fn resolve(&self, relative: &str) -> Result<PathBuf, Error> {
        let outside = || Error::Outside(relative.to_owned());
        if relative.starts_with(['/', '\\']) {
            return Err(outside());
        }
        let mut path = self.path.clone();
        for part in relative.split('/').filter(|part| !part.is_empty() && *part != ".") {
            let mut components = Path::new(part).components();
            match (components.next(), components.next()) {
                (Some(Component::Normal(name)), None) => path.push(name),
                _ => return Err(outside()),
            }
        }
        // The deepest part that exists, resolved, must still be under the root.
        let mut existing = path.as_path();
        while !existing.exists() {
            existing = existing.parent().ok_or_else(outside)?;
        }
        let resolved = fs::canonicalize(existing).map_err(|_| outside())?;
        if !resolved.starts_with(&self.path) {
            return Err(outside());
        }
        Ok(path)
    }

    /// Every file under the root, with its size and date. Links are not
    /// followed, so none leads out of it or round in a loop.
    pub fn walk(&self) -> Result<Vec<Entry>, Error> {
        let mut out = Vec::new();
        let mut folders = vec![(self.path.clone(), String::new())];
        while let Some((folder, prefix)) = folders.pop() {
            let entries = fs::read_dir(&folder).map_err(io(&prefix))?;
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let path = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                };
                let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                    continue;
                };
                if metadata.is_dir() {
                    folders.push((entry.path(), path));
                } else if metadata.is_file() {
                    out.push(Entry {
                        path,
                        name,
                        stat: Stat::of(&metadata),
                    });
                }
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// The entries of one folder (files and folders).
    pub fn list(&self, relative: &str) -> Result<Vec<Entry>, Error> {
        let folder = self.resolve(relative)?;
        let mut out = Vec::new();
        for entry in fs::read_dir(&folder).map_err(io(relative))?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if metadata.is_dir() || metadata.is_file() {
                let path = join(relative, &name);
                out.push(Entry {
                    path,
                    name,
                    stat: Stat::of(&metadata),
                });
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// A small file's bytes (`.meta/`, a playlist).
    pub fn read(&self, relative: &str) -> Result<Vec<u8>, Error> {
        fs::read(self.resolve(relative)?).map_err(io(relative))
    }

    /// Writes a small file whole: into a new file beside it, then renamed over
    /// it, so a crash leaves the old one. Its folders are made if missing.
    pub fn write(&self, relative: &str, bytes: &[u8]) -> Result<(), Error> {
        let path = self.resolve(relative)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(io(relative))?;
        }
        let temporary = beside(&path);
        let written = (|| {
            let mut file = fs::File::create(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, &path)
        })();
        if written.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        written.map_err(io(relative))
    }

    /// A path's size and date, or `None` when nothing is there.
    pub fn stat(&self, relative: &str) -> Result<Option<Stat>, Error> {
        match fs::metadata(self.resolve(relative)?) {
            Ok(metadata) => Ok(Some(Stat::of(&metadata))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io(relative)(error)),
        }
    }

    /// Deletes a file, or an empty folder.
    pub fn delete(&self, relative: &str) -> Result<(), Error> {
        let path = self.resolve(relative)?;
        if path == self.path {
            return Err(Error::Outside(relative.to_owned()));
        }
        if path.is_dir() {
            fs::remove_dir(&path)
        } else {
            fs::remove_file(&path)
        }
        .map_err(io(relative))
    }

    /// Moves a file; the folders of its new place are made if missing.
    pub fn rename(&self, from: &str, to: &str) -> Result<(), Error> {
        let (source, target) = (self.resolve(from)?, self.resolve(to)?);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(io(to))?;
        }
        fs::rename(source, target).map_err(io(from))
    }

    /// Makes a folder, and those above it.
    pub fn mkdir(&self, relative: &str) -> Result<(), Error> {
        fs::create_dir_all(self.resolve(relative)?).map_err(io(relative))
    }
}

/// A relative path's child.
fn join(relative: &str, name: &str) -> String {
    let relative = relative.trim_matches('/');
    if relative.is_empty() || relative == "." {
        name.to_owned()
    } else {
        format!("{relative}/{name}")
    }
}

/// A new file's path beside `path`, for writing before renaming it over.
pub(crate) fn beside(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
    path.with_file_name(format!(".{name}.jackbird-{}.tmp", std::process::id()))
}
