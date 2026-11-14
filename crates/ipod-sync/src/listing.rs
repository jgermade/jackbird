//! What the app shows of a mounted iPod, read-only: the iPods mounted on this
//! machine, the songs one holds as its database lists them (so the AAC songs,
//! which jackbird's tag engine does not read, show too), and a song's cover as
//! a PNG. See `RECORD/2026-11-14.ipod-sync.WIP.md` (the panel).

use std::path::{Path, PathBuf};

use jackbird_ipod::artwork::{self, ArtworkDb};
use jackbird_ipod::device::Checksum;
use jackbird_ipod::{cdb, db, sysinfo};

use crate::{Error, artwork_dir, err, io, itunes};

/// An iPod mounted on this machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    /// Its mount point.
    pub root: PathBuf,
    /// Its name: its master playlist's, else its volume's.
    pub name: String,
    /// Whether jackbird can write to it, or why not.
    pub writable: Result<(), String>,
}

/// The folders volumes are mounted in, on this system.
pub fn mount_folders() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(target_os = "macos") {
        out.push(PathBuf::from("/Volumes"));
    } else if cfg!(target_os = "windows") {
        // Each drive letter is a "folder" holding one volume: listed as roots below.
    } else if let Ok(user) = std::env::var("USER") {
        out.push(Path::new("/media").join(&user));
        out.push(Path::new("/run/media").join(&user));
    }
    out
}

/// The mount points to look at: every entry of [`mount_folders`], and the
/// drive letters on Windows.
fn candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = mount_folders()
        .iter()
        .filter_map(|f| std::fs::read_dir(f).ok())
        .flat_map(|entries| entries.filter_map(|e| e.ok()).map(|e| e.path()))
        .collect();
    if cfg!(target_os = "windows") {
        out.extend((b'D'..=b'Z').map(|l| PathBuf::from(format!("{}:\\", l as char))));
    }
    out
}

/// The iPods mounted on this machine.
pub fn find_ipods() -> Vec<Found> {
    find_in(candidates())
}

/// The iPods among `places`: those holding an `iPod_Control` folder.
pub fn find_in(places: impl IntoIterator<Item = PathBuf>) -> Vec<Found> {
    places
        .into_iter()
        .filter(|p| p.join("iPod_Control").join("iTunes").is_dir())
        .map(|root| {
            let volume = root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let name = list(&root)
                .ok()
                .and_then(|l| l.name)
                .filter(|n| !n.is_empty())
                .unwrap_or(volume);
            let writable = writable(&root);
            Found { root, name, writable }
        })
        .collect()
}

/// Whether jackbird can write to the iPod at `root`: a nano 6G or 7G (an
/// `iTunesCDB` signed with `hashAB`) whose `SysInfoExtended` is on its disk.
pub fn writable(root: &Path) -> Result<(), String> {
    let raw = std::fs::read(itunes(root).join("iTunesCDB"))
        .map_err(|_| "jackbird writes only to an iPod nano 6G or 7G (an iTunesCDB)".to_string())?;
    let data = cdb::inflate(&raw).map_err(|e| e.to_string())?;
    let database = db::parse(&data).map_err(|e| e.to_string())?;
    if Checksum::from_scheme(database.checksum_scheme) != Some(Checksum::HashAb) {
        return Err("jackbird writes only to an iPod nano 6G or 7G (hashAB)".into());
    }
    let extended = root.join("iPod_Control").join("Device").join("SysInfoExtended");
    let text = std::fs::read_to_string(&extended).map_err(|_| "no SysInfoExtended on the iPod yet".to_string())?;
    if sysinfo::extended_values(&text).is_empty() {
        return Err("its SysInfoExtended is empty".into());
    }
    Ok(())
}

/// A song as the iPod's database lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listed {
    /// Its file, relative to the iPod's root, with `/`.
    pub path: String,
    /// The fields, as the database has them.
    pub track: db::Track,
}

/// What an iPod holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listing {
    /// Its master playlist's name.
    pub name: Option<String>,
    /// Its songs that have a file.
    pub songs: Vec<Listed>,
}

/// The songs of the iPod at `root`, from its `iTunesCDB` (or `iTunesDB`).
pub fn list(root: &Path) -> Result<Listing, Error> {
    let dir = itunes(root);
    let path = ["iTunesCDB", "iTunesDB"]
        .iter()
        .map(|f| dir.join(f))
        .find(|p| p.is_file())
        .ok_or_else(|| err(format!("{} holds no database", dir.display())))?;
    let raw = std::fs::read(&path).map_err(io(&path))?;
    let data = cdb::inflate(&raw).map_err(|e| err(format!("{}: {e}", path.display())))?;
    let database = db::parse(&data).map_err(|e| err(format!("{}: {e}", path.display())))?;
    let name = database
        .playlists
        .iter()
        .find(|p| p.master)
        .and_then(|p| p.name.clone());
    let songs = database
        .tracks
        .into_iter()
        .filter_map(|track| {
            Some(Listed {
                path: track.path()?,
                track,
            })
        })
        .collect();
    Ok(Listing { name, songs })
}

/// The cover of image `id` on the iPod at `root`, as a PNG: its largest size,
/// decoded from its image file. `None` when there is no such image.
pub fn cover_png(root: &Path, id: u32) -> Option<Vec<u8>> {
    let dir = artwork_dir(root);
    let db = ArtworkDb::parse(&std::fs::read(dir.join("ArtworkDB")).ok()?).ok()?;
    let image = db.images().into_iter().find(|i| i.id == id)?;
    let thumb = image
        .thumbs
        .iter()
        .max_by_key(|t| u32::from(t.width) * u32::from(t.height))?;
    let rows = usize::from(thumb.height);
    if rows == 0 || thumb.width == 0 {
        return None;
    }
    let row_bytes = thumb.size as usize / rows.max(1);
    let file = std::fs::read(dir.join(thumb.file.trim_start_matches(':'))).ok()?;
    let slot = file.get(thumb.offset as usize..thumb.offset as usize + thumb.size as usize)?;
    // A cover Apple centres keeps blank rows above it: they are left out.
    let top = usize::try_from(thumb.top.max(0)).unwrap_or(0).min(rows);
    let rgb = artwork::decode(
        &slot[top * row_bytes..],
        thumb.width,
        thumb.height - top as u16,
        row_bytes,
    );
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, u32::from(thumb.width), u32::from(thumb.height) - top as u32);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&rgb).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_mounted_where_there_is_no_ipod() {
        let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        assert!(find_in([here.clone(), here.join("missing")]).is_empty());
        assert!(list(&here).is_err());
        assert!(writable(&here).is_err());
        assert_eq!(cover_png(&here, 1), None);
    }

    /// On a copy of a real iPod, when `JACKBIRD_IPOD_COPY` names one (its root,
    /// holding `iPod_Control/`); skipped otherwise, so the repository needs no
    /// one's library.
    #[test]
    fn on_a_copy_of_an_ipod() {
        let Some(root) = std::env::var_os("JACKBIRD_IPOD_COPY").map(PathBuf::from) else {
            return;
        };
        let found = find_in([root.clone()]);
        assert_eq!(found.len(), 1);
        eprintln!("found {:?}, writable {:?}", found[0].name, found[0].writable);
        let listing = list(&root).unwrap();
        assert!(!listing.songs.is_empty());
        let with_art = listing.songs.iter().find_map(|s| s.track.artwork_id).unwrap();
        let png = cover_png(&root, with_art).unwrap();
        assert!(png.starts_with(b"\x89PNG"));
        let out = std::env::temp_dir().join("jackbird-ipod-cover.png");
        std::fs::write(&out, &png).unwrap();
        eprintln!(
            "{} songs; image {with_art} written to {}",
            listing.songs.len(),
            out.display()
        );
    }
}
