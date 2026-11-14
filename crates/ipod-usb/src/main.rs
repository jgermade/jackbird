//! `ipod-info`: describes a mounted iPod, to check jackbird's reading of it
//! against the device (N1 of `RECORD/2026-11-14.ipod-sync.WIP.md`).
//!
//! ```text
//! cargo run -p jackbird-ipod-usb -- "/Volumes/<the iPod>" [--tracks N] [--save-sysinfo]
//! ```
//!
//! It reads; the one thing it may write is, with `--save-sysinfo`, a copy of
//! `SysInfoExtended` at `iPod_Control/Device/SysInfoExtended` when there is none.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use jackbird_ipod::device::{Checksum, Generation, GuidSource, find_guid};
use jackbird_ipod::{cdb, db, hashab, sysinfo};
use jackbird_ipod_usb::{UsbIpod, list_apple_devices, read_sysinfo_extended};

struct Args {
    root: PathBuf,
    tracks: usize,
    save_sysinfo: bool,
}

fn args() -> Result<Args, String> {
    let mut root = None;
    let mut tracks = 10;
    let mut save_sysinfo = false;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--tracks" => {
                tracks = it
                    .next()
                    .and_then(|n| n.parse().ok())
                    .ok_or("--tracks needs a number")?
            }
            "--save-sysinfo" => save_sysinfo = true,
            "-h" | "--help" => return Err(String::new()),
            _ if root.is_none() => root = Some(PathBuf::from(arg)),
            _ => return Err(format!("unexpected argument: {arg}")),
        }
    }
    Ok(Args {
        root: root.ok_or("the iPod's mount point is missing")?,
        tracks,
        save_sysinfo,
    })
}

fn main() -> ExitCode {
    let args = match args() {
        Ok(a) => a,
        Err(e) => {
            if !e.is_empty() {
                eprintln!("{e}");
            }
            eprintln!("usage: ipod-info <the iPod's mount point> [--tracks N] [--save-sysinfo]");
            return ExitCode::from(2);
        }
    };
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn read_text(path: &Path) -> Option<String> {
    std::fs::read(path)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn run(args: &Args) -> Result<(), String> {
    let control = args.root.join("iPod_Control");
    if !control.is_dir() {
        return Err(format!("{} has no iPod_Control folder", args.root.display()));
    }
    let device_dir = control.join("Device");

    // The device's files.
    let sysinfo_text = read_text(&device_dir.join("SysInfo"));
    let sysinfo = sysinfo_text.as_deref().map(sysinfo::parse_sysinfo).unwrap_or_default();
    let disk_extended = read_text(&device_dir.join("SysInfoExtended"));
    println!("SysInfo: {}", describe_file(sysinfo_text.as_deref(), sysinfo.len()));

    // USB.
    let usb = match list_apple_devices() {
        Ok(devices) => devices,
        Err(e) => {
            println!("USB: could not list devices ({e})");
            Vec::new()
        }
    };
    for d in &usb {
        println!(
            "USB: Apple {:#06x} {} serial {}",
            d.product_id,
            d.generation.map_or("(not an iPod in disk mode)", Generation::name),
            d.serial.as_deref().unwrap_or("?")
        );
    }
    let ipods: Vec<&UsbIpod> = usb.iter().filter(|d| d.generation.is_some()).collect();
    let ipod = pick(&ipods, &sysinfo, disk_extended.as_deref());
    if ipods.len() > 1 && ipod.is_none() {
        println!("USB: several iPods and none matches this disk's GUID; USB is left out");
    }

    let usb_extended = ipod.and_then(|d| match read_sysinfo_extended(d) {
        Ok(xml) if !xml.trim().is_empty() => Some(xml),
        Ok(_) => {
            println!("SysInfoExtended over USB: empty answer");
            None
        }
        Err(e) => {
            println!("SysInfoExtended over USB: {e}");
            None
        }
    });
    let (extended_text, extended_from) = match (&usb_extended, &disk_extended) {
        (Some(x), _) => (Some(x.as_str()), "USB"),
        (None, Some(x)) => (Some(x.as_str()), "the copy on the disk"),
        _ => (None, "nowhere"),
    };
    let extended = extended_text.map(sysinfo::extended_values).unwrap_or_default();
    println!(
        "SysInfoExtended: from {extended_from}, {} values{}",
        extended.len(),
        if extended_text.is_some_and(|x| x.contains("SQL")) {
            ", holds SQL"
        } else {
            ""
        }
    );
    for key in [
        "SerialNumber",
        "FamilyID",
        "UpdaterFamilyID",
        "VisibleBuildID",
        "BuildID",
    ] {
        if let Some(v) = extended.get(key) {
            println!("  {key}: {v}");
        }
    }

    if args.save_sysinfo {
        save_extended(&device_dir, usb_extended.as_deref(), disk_extended.is_some())?;
    }

    // Which iPod, its GUID.
    let generation = ipod.and_then(|d| d.generation);
    let found_guid = find_guid(&extended, &sysinfo, ipod.and_then(|d| d.serial.as_deref()));
    match found_guid {
        Some((guid, source)) => println!(
            "GUID: {} (from {})",
            guid.to_hex(),
            match source {
                GuidSource::SysInfoExtended => "SysInfoExtended",
                GuidSource::SysInfo => "SysInfo",
                GuidSource::UsbSerial => "the USB serial number",
            }
        ),
        None => println!("GUID: not found"),
    }

    // The database.
    let itunes = control.join("iTunes");
    let file = match generation {
        Some(g) => g.database_file(),
        None if itunes.join("iTunesCDB").is_file() => "iTunesCDB",
        None => "iTunesDB",
    };
    let raw = std::fs::read(itunes.join(file)).map_err(|e| format!("reading iTunes/{file}: {e}"))?;
    let compressed = cdb::is_compressed(&raw);
    let data = cdb::inflate(&raw).map_err(|e| format!("iTunes/{file}: {e}"))?;
    let database = db::parse(&data).map_err(|e| format!("iTunes/{file}: {e}"))?;
    println!(
        "Database: iTunes/{file}, {} bytes{}, version {:#x}",
        raw.len(),
        if compressed {
            format!(" ({} inflated)", data.len())
        } else {
            String::new()
        },
        database.version
    );
    let scheme = Checksum::from_scheme(database.checksum_scheme);
    println!(
        "Model: {}",
        generation.map_or("unknown (no iPod on USB)", Generation::name)
    );
    println!(
        "Checksum: the database names {}{}",
        scheme.map_or_else(
            || format!("scheme {}", database.checksum_scheme),
            |c| c.name().to_string()
        ),
        match (generation, scheme) {
            (Some(g), Some(s)) if g.checksum() != s => format!(" (the model expects {})", g.checksum().name()),
            _ => String::new(),
        }
    );
    if generation.is_some_and(Generation::uses_sqlite_library) {
        let itlp = itunes.join("iTunes Library.itlp");
        println!(
            "SQLite library: {}",
            if itlp.is_dir() {
                std::fs::read_dir(&itlp)
                    .map(|entries| {
                        let mut names: Vec<String> = entries
                            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
                            .collect();
                        names.sort();
                        names.join(", ")
                    })
                    .unwrap_or_else(|e| e.to_string())
            } else {
                "missing".to_string()
            }
        );
    }

    // The signatures (N2): checked, never written.
    if scheme == Some(Checksum::HashAb) || generation.is_some_and(|g| g.checksum() == Checksum::HashAb) {
        match found_guid {
            None => println!("hashAB: no GUID to check the signatures with"),
            Some((guid, _)) => check_hashab(&itunes, &raw, &data, &guid.0),
        }
    }

    // Tracks.
    let missing = database
        .tracks
        .iter()
        .filter(|t| t.path().is_none_or(|p| !args.root.join(p).is_file()))
        .count();
    println!(
        "Tracks: {} ({missing} without their file on the disk)",
        database.tracks.len()
    );
    for t in database.tracks.iter().take(args.tracks) {
        println!(
            "  {} — {} — {} [{}:{:02}] {}",
            t.title.as_deref().unwrap_or("?"),
            t.artist.as_deref().unwrap_or("?"),
            t.album.as_deref().unwrap_or("?"),
            t.length_ms / 60_000,
            t.length_ms / 1000 % 60,
            t.path().unwrap_or_default()
        );
    }

    // Playlists.
    println!("Playlists: {}", database.playlists.len());
    for p in &database.playlists {
        let mut kinds = Vec::new();
        if p.master {
            kinds.push("master");
        }
        if p.smart {
            kinds.push("smart");
        }
        if p.podcast {
            kinds.push("podcasts");
        }
        println!(
            "  {} — {} tracks{}",
            p.name.as_deref().unwrap_or("?"),
            p.track_ids.len(),
            if kinds.is_empty() {
                String::new()
            } else {
                format!(" ({})", kinds.join(", "))
            }
        );
    }
    Ok(())
}

/// Whether the `iTunesCDB` and `Locations.itdb.cbk` iTunes wrote are signed
/// for this GUID: the proof that `hashAB` and the GUID are right, without
/// writing anything.
fn check_hashab(itunes: &Path, raw: &[u8], inflated: &[u8], guid: &[u8; 8]) {
    let yes = |b: bool| if b { "valid" } else { "NOT valid" };
    let on_file = hashab::verify_database(raw, guid);
    print!("hashAB: the database's signature is {} for this GUID", yes(on_file));
    if !on_file && inflated != raw {
        print!(
            " (over the inflated database: {})",
            yes(hashab::verify_database(inflated, guid))
        );
    }
    println!();
    let itlp = itunes.join("iTunes Library.itlp");
    match (
        std::fs::read(itlp.join("Locations.itdb.cbk")),
        std::fs::read(itlp.join("Locations.itdb")),
    ) {
        (Ok(book), Ok(locations)) => println!(
            "hashAB: Locations.itdb.cbk ({} bytes) is {} for Locations.itdb ({} bytes)",
            book.len(),
            yes(hashab::verify_checksum_book(&book, &locations, guid)),
            locations.len()
        ),
        _ => println!("hashAB: no Locations.itdb.cbk and Locations.itdb to check"),
    }
}

fn describe_file(text: Option<&str>, values: usize) -> String {
    match text {
        None => "missing".to_string(),
        Some(t) if t.trim().is_empty() => "empty".to_string(),
        Some(_) => format!("{values} values"),
    }
}

/// The iPod on USB that is this disk: the only one, or the one whose serial
/// starts with the disk's GUID.
fn pick<'a>(
    ipods: &[&'a UsbIpod],
    sysinfo: &BTreeMap<String, String>,
    disk_extended: Option<&str>,
) -> Option<&'a UsbIpod> {
    if ipods.len() == 1 {
        return Some(ipods[0]);
    }
    let extended = disk_extended.map(sysinfo::extended_values).unwrap_or_default();
    let (guid, _) = find_guid(&extended, sysinfo, None)?;
    let hex = guid.to_hex();
    ipods.iter().copied().find(|d| {
        d.serial
            .as_deref()
            .is_some_and(|s| s.to_ascii_uppercase().starts_with(&hex))
    })
}

fn save_extended(device_dir: &Path, xml: Option<&str>, exists: bool) -> Result<(), String> {
    let path = device_dir.join("SysInfoExtended");
    match (xml, exists) {
        (_, true) => println!("--save-sysinfo: {} already exists, left as it is", path.display()),
        (None, false) => println!("--save-sysinfo: nothing read over USB to save"),
        (Some(xml), false) => {
            std::fs::create_dir_all(device_dir).map_err(|e| e.to_string())?;
            std::fs::write(&path, xml).map_err(|e| format!("writing {}: {e}", path.display()))?;
            println!("--save-sysinfo: saved {}", path.display());
        }
    }
    Ok(())
}
