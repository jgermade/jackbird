//! What the app shows of a mounted iPod, read-only: the iPods mounted on this
//! machine, the songs one holds as its database lists them (so the AAC songs,
//! which jackbird's tag engine does not read, show too), and a song's cover as
//! a PNG. See `RECORD/2026-11-14.ipod-sync.WIP.md` (the panel).

use std::path::{Path, PathBuf};

use jackbird_ipod::artwork::{self, ArtworkDb};
use jackbird_ipod::device::{self, Checksum, Facts};
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

/// The mount points that hold an iPod (an `iPod_Control/iTunes` folder), looked at cheaply: for
/// watching what is plugged in. [`find_ipods`] reads them.
pub fn ipod_mounts() -> Vec<PathBuf> {
    candidates()
        .into_iter()
        .filter(|p| p.join("iPod_Control").join("iTunes").is_dir())
        .collect()
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

/// What the app shows of a mounted iPod beside its songs (`RECORD/2026-11-14.ipod-sync.WIP.md`, W5).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Info {
    /// What it says of itself on its disk.
    pub facts: Facts,
    /// The checksum scheme its database's header names (`mhbd` `0x30`).
    pub checksum: Option<u16>,
    /// Its drive's size and free space, in bytes, as the system reports them.
    pub space: Option<Space>,
}

/// A drive's size and free space, in bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Space {
    /// Its size.
    pub total: u64,
    /// What is free on it.
    pub free: u64,
}

/// [`Info`] of the iPod at `root`.
pub fn info(root: &Path) -> Info {
    let text = |path: PathBuf| {
        std::fs::read(path)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    };
    let device = root.join("iPod_Control").join("Device");
    let facts = device::facts(
        text(device.join("SysInfo")).as_deref(),
        text(device.join("SysInfoExtended")).as_deref(),
        text(root.join(".rockbox").join("rockbox-info.txt")).as_deref(),
    );
    // The scheme is in the header, which an iTunesCDB keeps uncompressed: its first bytes do.
    let checksum = ["iTunesCDB", "iTunesDB"].iter().find_map(|name| {
        use std::io::Read;
        let mut head = [0u8; 0x32];
        let mut file = std::fs::File::open(itunes(root).join(name)).ok()?;
        file.read_exact(&mut head).ok()?;
        (head.starts_with(b"mhbd")).then(|| u16::from_le_bytes([head[0x30], head[0x31]]))
    });
    Info {
        facts,
        checksum,
        space: space(root),
    }
}

/// The size and free space of the drive `root` is on, from the system's own tools: `df` on macOS
/// and Linux, PowerShell's `Get-PSDrive` on Windows. `None` when they do not answer.
pub fn space(root: &Path) -> Option<Space> {
    if cfg!(windows) {
        let letter = root
            .to_string_lossy()
            .chars()
            .next()
            .filter(char::is_ascii_alphabetic)?;
        let script = format!("$d = Get-PSDrive -Name {letter}; \"$($d.Used) $($d.Free)\"");
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut numbers = text.split_whitespace().map(|n| n.parse::<u64>().ok());
        let (used, free) = (numbers.next()??, numbers.next()??);
        return Some(Space {
            total: used + free,
            free,
        });
    }
    let out = std::process::Command::new("df").arg("-kP").arg(root).output().ok()?;
    out.status.success().then_some(())?;
    parse_df(&String::from_utf8_lossy(&out.stdout))
}

/// The size and free space in `df -kP`'s answer: its second line's blocks and available (in KiB),
/// the two numbers before the capacity's percentage (a device's name may hold spaces).
pub fn parse_df(text: &str) -> Option<Space> {
    let line = text.lines().nth(1)?;
    let fields: Vec<&str> = line.split_whitespace().collect();
    let at = fields.iter().position(|f| f.ends_with('%'))?;
    let number = |i: usize| fields.get(i)?.parse::<u64>().ok();
    let (blocks, available) = (number(at.checked_sub(3)?)?, number(at - 1)?);
    Some(Space {
        total: blocks * 1024,
        free: available * 1024,
    })
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

/// An iPod's covers, its `ArtworkDB` and image files read once, each image given as a PNG.
pub struct Covers {
    root: PathBuf,
    images: std::collections::HashMap<u32, artwork::Image>,
    files: std::collections::HashMap<String, Option<Vec<u8>>>,
}

impl Covers {
    /// The covers of the iPod at `root`; none when it has no `ArtworkDB`.
    pub fn open(root: &Path) -> Covers {
        let images = std::fs::read(artwork_dir(root).join("ArtworkDB"))
            .ok()
            .and_then(|bytes| ArtworkDb::parse(&bytes).ok())
            .map(|db| db.images().into_iter().map(|i| (i.id, i)).collect())
            .unwrap_or_default();
        Covers {
            root: root.to_path_buf(),
            images,
            files: Default::default(),
        }
    }

    /// Image `id` as a PNG: its largest size, decoded from its image file (read the first time
    /// an image needs it). `None` when there is no such image or it cannot be read.
    pub fn png(&mut self, id: u32) -> Option<Vec<u8>> {
        let thumb = self.images.get(&id)?.largest()?;
        let name = thumb.file.trim_start_matches(':').to_string();
        let dir = artwork_dir(&self.root);
        let file = self
            .files
            .entry(name.clone())
            .or_insert_with(|| std::fs::read(dir.join(&name)).ok())
            .as_ref()?;
        let slot = file.get(thumb.offset as usize..thumb.offset as usize + thumb.size as usize)?;
        artwork::cover_png(slot, thumb)
    }
}

/// The cover of image `id` on the iPod at `root`, as a PNG (one image: [`Covers`] for many).
pub fn cover_png(root: &Path, id: u32) -> Option<Vec<u8>> {
    Covers::open(root).png(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_df_and_the_drive_here() {
        let text = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk4s2 My Disk 15433728 12822528 2611200 84% /Volumes/NANO\n";
        assert_eq!(
            parse_df(text),
            Some(Space {
                total: 15_433_728 * 1024,
                free: 2_611_200 * 1024
            })
        );
        assert_eq!(parse_df("Filesystem\n"), None);
        assert_eq!(parse_df("header\nno numbers 12%\n"), None);
        // The drive this crate is on: some size, less free than that.
        if !cfg!(windows) {
            let here = space(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
            assert!(here.total > 0 && here.free <= here.total);
        }
        let none = info(Path::new(env!("CARGO_MANIFEST_DIR")));
        assert_eq!((none.facts, none.checksum), (Facts::default(), None));
    }

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
        // Every image the songs show, as a PNG that decodes again.
        let ids: std::collections::BTreeSet<u32> = listing.songs.iter().filter_map(|s| s.track.artwork_id).collect();
        let mut covers = Covers::open(&root);
        for id in &ids {
            let png = covers.png(*id).unwrap_or_else(|| panic!("image {id}"));
            let mut reader = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
            let mut buf = vec![0; reader.output_buffer_size().unwrap()];
            reader
                .next_frame(&mut buf)
                .unwrap_or_else(|e| panic!("image {id}: {e}"));
        }
        eprintln!("{} images, every one a PNG", ids.len());
    }
}
