//! Adding MP3s to a mounted iPod nano 6G or 7G (N4c of
//! `RECORD/2026-11-14.ipod-sync.WIP.md`).
//!
//! - [`open`] reads the iPod's databases, and its `SysInfoExtended` from the
//!   copy on its disk (`ipod-info --save-sysinfo` writes it).
//! - [`read_mp3`] makes a [`Song`] of a file: its tags (`jackbird-tags`), its
//!   audio ([`mpeg`]), its size and date.
//! - [`Device::add`] places each song under `iPod_Control/Music/Fnn/` and adds it
//!   to the databases in memory ([`jackbird_ipod::add`]).
//! - [`Device::commit`] writes it all: the new databases are made in a staging
//!   folder and checked, the MP3s copied, then each database is swapped in,
//!   its old file kept, the `iTunesCDB` last. A failure at
//!   any step puts the old files back and removes the copied MP3s. The old
//!   files are kept in `iPod_Control/iTunes/.jackbird-backups/<when>/`.

pub mod genres;
pub mod mpeg;

use std::path::{Path, PathBuf};

use jackbird_ipod::add::{self, Ipod};
use jackbird_ipod::device::{Guid, find_guid};
use jackbird_ipod::library::{self, schema::FILES};
use jackbird_ipod::song::{Song, Stamp};
use jackbird_ipod::{cdb, chunk, db, hashab, sysinfo};
use jackbird_ipod_sqlite as sqlite;

/// Why the iPod could not be read or written: what failed, in words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

fn err(what: impl std::fmt::Display) -> Error {
    Error(what.to_string())
}

fn io(path: &Path) -> impl Fn(std::io::Error) -> Error + '_ {
    move |e| Error(format!("{}: {e}", path.display()))
}

/// Eight random bytes, from the system.
pub fn random_u64() -> u64 {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("the system's random source");
    u64::from_le_bytes(bytes)
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the system's random source");
    bytes
}

/// A mounted iPod, its databases in memory.
pub struct Device {
    /// Its mount point.
    pub root: PathBuf,
    /// Its FireWire GUID, which its signatures are keyed on.
    pub guid: Guid,
    /// Its `SysInfoExtended`, for the library's post-process.
    pub extended: String,
    /// Its databases.
    pub ipod: Ipod,
    /// Files to copy onto it on [`Device::commit`]: from, and to (under
    /// `iPod_Control/Music/`).
    pub copies: Vec<(PathBuf, String)>,
}

/// The folder of the iPod's databases.
pub fn itunes(root: &Path) -> PathBuf {
    root.join("iPod_Control").join("iTunes")
}

/// Reads a mounted iPod nano 6G or 7G.
pub fn open(root: &Path) -> Result<Device, Error> {
    let control = root.join("iPod_Control");
    let extended_path = control.join("Device").join("SysInfoExtended");
    let extended = String::from_utf8_lossy(&std::fs::read(&extended_path).map_err(|e| {
        Error(format!(
            "{}: {e} (run `ipod-info --save-sysinfo` with the iPod plugged in first)",
            extended_path.display()
        ))
    })?)
    .into_owned();
    let values = sysinfo::extended_values(&extended);
    let (guid, _) =
        find_guid(&values, &Default::default(), None).ok_or_else(|| err("SysInfoExtended names no GUID"))?;
    let cdb_path = itunes(root).join("iTunesCDB");
    let raw = std::fs::read(&cdb_path).map_err(io(&cdb_path))?;
    if !hashab::verify_database(&raw, &guid.0) {
        return Err(err(
            "the iTunesCDB on the iPod is not signed for its GUID; jackbird leaves it alone",
        ));
    }
    let inflated = cdb::inflate(&raw).map_err(|e| err(format!("iTunesCDB: {e}")))?;
    let tree = chunk::parse(&inflated).map_err(|e| err(format!("iTunesCDB: {e}")))?;
    let mut rows = sqlite::read(&itunes(root).join("iTunes Library.itlp")).map_err(err)?;
    if rows.len() != FILES.len() {
        return Err(err("the iPod's iTunes Library.itlp lacks some of its files"));
    }
    for r in &mut rows {
        if r.file == "Library.itdb" {
            library::strip_post_processed(r);
        }
    }
    Ok(Device {
        root: root.to_path_buf(),
        guid,
        extended,
        ipod: Ipod { tree, rows },
        copies: Vec::new(),
    })
}

/// The leading number of `text`, such as `3` in `3/12` or `1999` in `1999-05-01`.
fn number(text: &str) -> u32 {
    let digits: String = text.trim().chars().take_while(char::is_ascii_digit).collect();
    digits.parse().unwrap_or(0)
}

/// The number after the `/` of `n/total`.
fn total(text: &str) -> u32 {
    text.split_once('/').map_or(0, |(_, t)| number(t))
}

fn some(text: &str) -> Option<String> {
    let t = text.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// A song of an MP3 file: its tags, its audio, its size, and when it was last
/// changed (with the local offset `offset_at` gives for that moment). Its
/// place on the iPod, IDs and the rest are set when it is added.
pub fn read_mp3(path: &Path, offset_at: &dyn Fn(i64) -> i32) -> Result<Song, Error> {
    let bytes = std::fs::read(path).map_err(io(path))?;
    let size = u32::try_from(bytes.len()).map_err(|_| err(format!("{}: larger than 4 GB", path.display())))?;
    let tags = jackbird_tags::read(&bytes).map_err(|e| err(format!("{}: {e:?}", path.display())))?;
    if tags.format != jackbird_tags::Format::Mp3 {
        return Err(err(format!("{}: not an MP3", path.display())));
    }
    let audio = mpeg::audio(&bytes).ok_or_else(|| err(format!("{}: no MPEG audio in it", path.display())))?;
    if audio.samples == 0 {
        return Err(err(format!("{}: its length cannot be read", path.display())));
    }
    let modified = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs() as i64);
    let f = &tags.fields;
    Ok(Song {
        title: some(&f.title).or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned())),
        artist: some(&f.artist),
        album: some(&f.album),
        album_artist: some(&f.album_artist),
        genre: some(&f.genre).map(|g| genres::name(&g)),
        size,
        length_ms: audio.length_ms,
        samples: audio.samples,
        bitrate: audio.bitrate,
        sample_rate: audio.first.sample_rate,
        vbr: audio.first.vbr.is_some(),
        track_number: number(&f.track),
        track_count: total(&f.track),
        disc_number: number(&f.disc),
        disc_count: total(&f.disc),
        year: number(&f.year),
        compilation: !matches!(f.compilation.trim(), "" | "0"),
        modified: Stamp {
            unix: modified,
            offset: offset_at(modified),
        },
        ..Song::default()
    })
}

impl Device {
    /// A free place for a new file: an existing `Fnn` folder under
    /// `iPod_Control/Music/`, and four random capital letters with `extension`.
    fn place(&self, extension: &str) -> Result<String, Error> {
        let music = self.root.join("iPod_Control").join("Music");
        let mut folders: Vec<String> = std::fs::read_dir(&music)
            .map_err(io(&music))?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.len() == 3 && n.starts_with('F') && n[1..].chars().all(|c| c.is_ascii_digit()))
            .collect();
        folders.sort();
        if folders.is_empty() {
            return Err(err(format!("{} has no Fnn folder", music.display())));
        }
        // The places the library already gives songs (their files may be
        // missing, or not yet on a copy of the iPod).
        let known: std::collections::HashSet<String> = self
            .ipod
            .rows
            .iter()
            .find(|r| r.file == "Locations.itdb")
            .and_then(|r| r.table("location"))
            .map(|t| {
                t.rows
                    .iter()
                    .filter_map(|row| match t.get(row, "location") {
                        library::Value::Text(p) => Some(p.to_ascii_uppercase()),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        loop {
            let r = random_u64();
            let folder = &folders[(r % folders.len() as u64) as usize];
            let name: String = (0..4)
                .map(|i| char::from(b'A' + ((r >> (16 + i * 8)) % 26) as u8))
                .collect();
            let place = format!("{folder}/{name}.{extension}");
            if !music.join(&place).exists()
                && !known.contains(&place.to_ascii_uppercase())
                && !self.copies.iter().any(|(_, p)| *p == place)
            {
                return Ok(place);
            }
        }
    }

    /// Adds an MP3 to the databases in memory, into the master playlist and
    /// `playlist` when one is named; the file is copied on [`Device::commit`].
    /// `now` is when it is added, with its local offset.
    pub fn add(&mut self, file: &Path, song: Song, playlist: Option<&str>, now: Stamp) -> Result<Song, Error> {
        let path = self.place("mp3")?;
        let song = Song {
            path: path.clone(),
            ..song
        };
        let added = add::add(&mut self.ipod, song, playlist, now, &mut random_u64).map_err(err)?;
        self.copies.push((file.to_path_buf(), path));
        Ok(added)
    }

    /// Writes what [`Device::add`] added: see the module's documentation.
    /// Gives back the backups it kept.
    pub fn commit(&self) -> Result<Vec<PathBuf>, Error> {
        let itunes = itunes(&self.root);
        let itlp = itunes.join("iTunes Library.itlp");
        let staging = itunes.join(".jackbird-staging");
        if staging.exists() {
            return Err(err(format!(
                "{} is there from an earlier run; look at it and remove it first",
                staging.display()
            )));
        }
        // What is swapped in, in this order: the library's files, then the iTunesCDB.
        let mut targets: Vec<(PathBuf, PathBuf)> = FILES
            .iter()
            .map(|f| (staging.join("iTunes Library.itlp").join(f.name), itlp.join(f.name)))
            .collect();
        targets.push((
            staging.join("iTunes Library.itlp").join("Locations.itdb.cbk"),
            itlp.join("Locations.itdb.cbk"),
        ));
        targets.push((staging.join("iTunesCDB"), itunes.join("iTunesCDB")));
        // The old files go to a folder of this sync's own, outside the
        // library's folder (the firmware reads whatever is in it).
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let backups = itunes.join(".jackbird-backups").join(stamp.to_string());
        if backups.exists() {
            return Err(err(format!("{} is there already; try again", backups.display())));
        }
        std::fs::create_dir_all(backups.join("iTunes Library.itlp")).map_err(io(&backups))?;
        let backup = |live: &Path| backups.join(live.strip_prefix(&itunes).unwrap_or(live));

        let result = self
            .stage(&staging)
            .and_then(|()| self.copy_and_swap(&targets, &backup));
        let _ = std::fs::remove_dir_all(&staging);
        if result.is_err() {
            // Everything was put back: the folder is empty (remove_dir refuses otherwise).
            let _ = std::fs::remove_dir(backups.join("iTunes Library.itlp"));
            let _ = std::fs::remove_dir(&backups);
        }
        result?;
        Ok(targets
            .iter()
            .map(|(_, live)| backup(live))
            .filter(|b| b.exists())
            .collect())
    }

    /// Makes the new databases in `staging` and checks them.
    fn stage(&self, staging: &Path) -> Result<(), Error> {
        let itlp = staging.join("iTunes Library.itlp");
        std::fs::create_dir_all(&itlp).map_err(io(&itlp))?;
        let commands = library::post_process(&self.extended, FILES[0].user_version).map_err(err)?;
        let failed = sqlite::write(&itlp, &self.ipod.rows, &commands).map_err(err)?;
        if let Some(f) = failed.iter().find(|f| !f.is_duplicate_column()) {
            return Err(err(format!(
                "the library's post-process failed at {}: {}",
                f.name, f.error
            )));
        }
        let locations_path = itlp.join("Locations.itdb");
        let locations = std::fs::read(&locations_path).map_err(io(&locations_path))?;
        let book = hashab::checksum_book(&locations, &self.guid.0, &random_bytes());
        write_synced(&itlp.join("Locations.itdb.cbk"), &book)?;

        let inflated = self.ipod.tree.write().map_err(|e| err(format!("iTunesCDB: {e}")))?;
        let mut cdb = cdb::compress(&inflated, cdb::LEVEL).map_err(|e| err(format!("iTunesCDB: {e}")))?;
        if !hashab::sign_database(&mut cdb, &self.guid.0, &random_bytes()) {
            return Err(err("the iTunesCDB is too short to sign"));
        }
        // Read back as the iPod will, before anything on it changes.
        let back = cdb::inflate(&cdb).map_err(|e| err(format!("the new iTunesCDB: {e}")))?;
        db::parse(&back).map_err(|e| err(format!("the new iTunesCDB: {e}")))?;
        if !hashab::verify_database(&cdb, &self.guid.0)
            || !hashab::verify_checksum_book(&book, &locations, &self.guid.0)
        {
            return Err(err("a new signature does not verify"));
        }
        write_synced(&staging.join("iTunesCDB"), &cdb)?;
        for f in &FILES {
            sync(&itlp.join(f.name))?;
        }
        Ok(())
    }

    /// Copies the MP3s, then swaps each staged database in; undoes all of it
    /// on any failure.
    fn copy_and_swap(&self, targets: &[(PathBuf, PathBuf)], backup: &dyn Fn(&Path) -> PathBuf) -> Result<(), Error> {
        let music = self.root.join("iPod_Control").join("Music");
        let mut copied: Vec<PathBuf> = Vec::new();
        let mut swapped: Vec<&Path> = Vec::new();
        let undo = |copied: &[PathBuf], swapped: &[&Path]| {
            for live in swapped.iter().rev() {
                let _ = std::fs::remove_file(live);
                let _ = std::fs::rename(backup(live), live);
            }
            for file in copied {
                let _ = std::fs::remove_file(file);
            }
        };
        let run = (|| -> Result<(), Error> {
            for (from, to) in &self.copies {
                let to = music.join(to);
                if to.exists() {
                    return Err(err(format!("{} is already there", to.display())));
                }
                copied.push(to.clone());
                std::fs::copy(from, &to).map_err(io(&to))?;
                sync(&to)?;
            }
            for (staged, live) in targets {
                if live.exists() {
                    std::fs::rename(live, backup(live)).map_err(io(live))?;
                }
                swapped.push(live);
                std::fs::rename(staged, live).map_err(io(live))?;
            }
            Ok(())
        })();
        if run.is_err() {
            undo(&copied, &swapped);
        }
        run
    }
}

fn sync(path: &Path) -> Result<(), Error> {
    std::fs::File::open(path).and_then(|f| f.sync_all()).map_err(io(path))
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    std::fs::write(path, bytes).map_err(io(path))?;
    sync(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_of_tags() {
        assert_eq!(number("3/12"), 3);
        assert_eq!(total("3/12"), 12);
        assert_eq!(total("3"), 0);
        assert_eq!(number("1999-05-01"), 1999);
        assert_eq!(number(""), 0);
        assert_eq!(some("  "), None);
        assert_eq!(some(" a "), Some("a".into()));
    }
}
