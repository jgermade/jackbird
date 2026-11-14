//! `ipod-add`: copies MP3s onto a mounted iPod nano 6G or 7G and adds them to
//! its databases, into the master playlist and a playlist when one is named.
//!
//! ```text
//! cargo run -p jackbird-ipod-sync --bin ipod-add -- <the iPod's root> <file.mp3>… [--playlist <name>]
//! ```
//!
//! The root may be a copy of an iPod (a folder holding its `iPod_Control/`):
//! N4 is checked on one before N5 runs it on the device. The old databases are
//! kept in `iPod_Control/iTunes/.jackbird-backups/<when>/`.

use std::path::PathBuf;
use std::process::ExitCode;

use jackbird_ipod::song::Stamp;
use jackbird_ipod_sync::{open, read_cover, read_mp3};

/// This machine's offset from UTC at the moment `unix`, in seconds, from
/// `date` (`+0100`): BSD's and macOS's `-r`, else GNU's `-d @`; 0 when it
/// cannot say.
fn local_offset(unix: i64) -> i32 {
    let ask = |args: &[String]| {
        std::process::Command::new("date")
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let text = ask(&["-r".into(), unix.to_string(), "+%z".into()])
        .or_else(|| ask(&["-d".into(), format!("@{unix}"), "+%z".into()]))
        .unwrap_or_default();
    let (sign, digits) = match text.split_at_checked(1) {
        Some(("+", d)) => (1, d),
        Some(("-", d)) => (-1, d),
        _ => return 0,
    };
    match (
        digits.get(..2).and_then(|h| h.parse::<i32>().ok()),
        digits.get(2..4).and_then(|m| m.parse::<i32>().ok()),
    ) {
        (Some(h), Some(m)) => sign * (h * 3600 + m * 60),
        _ => 0,
    }
}

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let mut root = None;
    let mut files = Vec::new();
    let mut playlist = None;
    while let Some(arg) = args.next() {
        if arg == "--playlist" {
            playlist = args.next().map(|p| p.to_string_lossy().into_owned());
        } else if root.is_none() {
            root = Some(PathBuf::from(arg));
        } else {
            files.push(PathBuf::from(arg));
        }
    }
    let (Some(root), false) = (root, files.is_empty()) else {
        eprintln!("usage: ipod-add <the iPod's root> <file.mp3>… [--playlist <name>]");
        return ExitCode::from(2);
    };
    match run(&root, &files, playlist.as_deref()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(root: &std::path::Path, files: &[PathBuf], playlist: Option<&str>) -> Result<(), String> {
    let mut device = open(root).map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let offset = local_offset(now);
    for file in files {
        let song = read_mp3(file, &local_offset).map_err(|e| e.to_string())?;
        let added = device
            .add(
                file,
                song,
                playlist,
                Stamp { unix: now, offset },
                read_cover(file).as_ref(),
            )
            .map_err(|e| e.to_string())?;
        println!(
            "adding {} as iPod_Control/Music/{} ({} — {}, {} ms, {} kbit/s{})",
            file.display(),
            added.path,
            added.title.as_deref().unwrap_or("?"),
            added.artist.as_deref().unwrap_or("?"),
            added.length_ms,
            added.bitrate,
            if added.vbr { ", VBR" } else { "" }
        );
        if let Some(id) = added.artwork_id {
            println!("  with its cover (image {id})");
        }
    }
    let backups = device.commit().map_err(|e| e.to_string())?;
    println!("written; the old databases are kept as:");
    for b in backups {
        println!("  {}", b.display());
    }
    Ok(())
}
