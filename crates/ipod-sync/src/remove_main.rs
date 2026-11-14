//! `ipod-remove`: finds songs on a mounted iPod nano 6G or 7G, and takes them
//! off it: out of both databases, and their files deleted.
//!
//! ```text
//! cargo run -p jackbird-ipod-sync --bin ipod-remove -- <the iPod's root> --find <text>
//! cargo run -p jackbird-ipod-sync --bin ipod-remove -- <the iPod's root> <pid>…
//! ```
//!
//! `--find` lists the songs whose title, artist or album holds the text (case
//! and accents aside), with their pids; it writes nothing. The old databases are
//! kept in `iPod_Control/iTunes/.jackbird-backups/<when>/`.

use std::path::PathBuf;
use std::process::ExitCode;

use jackbird_ipod::library::{Table, Value};
use jackbird_ipod_sync::open;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
        [root, flag, text] if flag == "--find" => find(&PathBuf::from(root), text),
        [root, pids @ ..] if !pids.is_empty() => remove(&PathBuf::from(root), pids),
        _ => {
            eprintln!(
                "usage: ipod-remove <the iPod's root> --find <text>\n       ipod-remove <the iPod's root> <pid>…"
            );
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Lower case, accents off, for finding.
fn folded(text: &str) -> String {
    jackbird_ipod::collate::fold_for_search(text)
}

fn text(t: &Table, row: &[Value], column: &str) -> String {
    match t.get(row, column) {
        Value::Text(s) => s,
        _ => String::new(),
    }
}

fn find(root: &std::path::Path, needle: &str) -> Result<(), String> {
    let device = open(root).map_err(|e| e.to_string())?;
    let table = |file: &str, name: &str| {
        device
            .ipod
            .rows
            .iter()
            .find(|r| r.file == file)
            .and_then(|r| r.table(name))
            .cloned()
            .unwrap_or_default()
    };
    let (items, locations) = (table("Library.itdb", "item"), table("Locations.itdb", "location"));
    let needle = folded(needle);
    let mut found = 0;
    for row in &items.rows {
        let (title, artist, album) = (
            text(&items, row, "title"),
            text(&items, row, "artist"),
            text(&items, row, "album"),
        );
        if ![&title, &artist, &album].iter().any(|f| folded(f).contains(&needle)) {
            continue;
        }
        found += 1;
        let pid = items.get(row, "pid");
        let place = locations
            .find("item_pid", &pid)
            .next()
            .map(|l| text(&locations, l, "location"))
            .unwrap_or_default();
        let added = match locations
            .find("item_pid", &pid)
            .next()
            .map(|l| locations.get(l, "date_created"))
        {
            Some(Value::Integer(t)) if t > 0 => format_utc(t + jackbird_ipod::song::UNIX_TO_2001),
            _ => "?".into(),
        };
        let artwork = items.get(row, "artwork_status") == Value::Integer(1);
        let Value::Integer(pid) = pid else { continue };
        println!(
            "{pid}  {title} — {artist} — {album}  [{place}, added {added} UTC{}]",
            if artwork { ", with artwork" } else { ", no artwork" }
        );
    }
    println!("{found} found");
    Ok(())
}

/// `YYYY-MM-DD HH:MM` of a Unix time, UTC.
fn format_utc(unix: i64) -> String {
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = era * 400 + yoe + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", secs / 3600, secs % 3600 / 60)
}

fn remove(root: &std::path::Path, pids: &[String]) -> Result<(), String> {
    let mut device = open(root).map_err(|e| e.to_string())?;
    for pid in pids {
        let pid: i64 = pid.parse().map_err(|_| format!("{pid:?} is not a pid (see --find)"))?;
        let removed = device.remove(pid).map_err(|e| e.to_string())?;
        println!(
            "removing {} ({})",
            removed.title.as_deref().unwrap_or("?"),
            removed
                .path
                .as_deref()
                .map_or("no file".into(), |p| format!("iPod_Control/Music/{p}"))
        );
    }
    let backups = device.commit().map_err(|e| e.to_string())?;
    println!("written; the old databases are kept as:");
    for b in backups {
        println!("  {}", b.display());
    }
    Ok(())
}
