//! `ipod-roundtrip`: reads a copy of an iPod's databases, writes them back into
//! another folder, and checks what it wrote against what it read (N3 of
//! `RECORD/2026-11-14.ipod-sync.WIP.md`).
//!
//! ```text
//! cargo run -p jackbird-ipod-usb --bin ipod-roundtrip -- <iTunes folder> <SysInfoExtended> <out folder>
//! ```
//!
//! The `iTunes` folder is a copy of `iPod_Control/iTunes/`, never the iPod's own:
//! this tool writes only into the output folder, which must not hold a library
//! yet.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use jackbird_ipod::device::find_guid;
use jackbird_ipod::library::{self, schema::FILES};
use jackbird_ipod::{cdb, chunk, db, hashab, sysinfo};
use jackbird_ipod_sqlite as sqlite;

fn main() -> ExitCode {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    let [itunes, extended, out] = args.as_slice() else {
        eprintln!("usage: ipod-roundtrip <iTunes folder> <SysInfoExtended> <out folder>");
        return ExitCode::from(2);
    };
    match run(itunes, extended, out) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => {
            println!("FAILED: what was written differs from what was read");
            ExitCode::FAILURE
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("reading {}: {e}", path.display()))
}

fn check(ok: bool, what: &str) -> bool {
    println!("{} {what}", if ok { "ok  " } else { "FAIL" });
    ok
}

fn run(itunes: &Path, extended: &Path, out: &Path) -> Result<bool, String> {
    if out.starts_with(itunes) || itunes.starts_with(out) {
        return Err("the output folder must be apart from the iTunes folder".into());
    }
    let extended = String::from_utf8_lossy(&read(extended)?).into_owned();
    let values = sysinfo::extended_values(&extended);
    let (guid, _) = find_guid(&values, &Default::default(), None).ok_or("SysInfoExtended names no GUID")?;
    std::fs::create_dir_all(out).map_err(|e| format!("creating {}: {e}", out.display()))?;
    let mut all = true;

    // The iTunesCDB.
    let raw = read(&itunes.join("iTunesCDB"))?;
    all &= check(
        hashab::verify_database(&raw, &guid.0),
        "the iTunesCDB read is signed for the GUID",
    );
    let inflated = cdb::inflate(&raw).map_err(|e| format!("iTunesCDB: {e}"))?;
    let tree = chunk::parse(&inflated).map_err(|e| format!("iTunesCDB: {e}"))?;
    let rewritten = tree.write().map_err(|e| format!("iTunesCDB: {e}"))?;
    all &= check(
        rewritten == inflated,
        "the chunk tree writes the inflated iTunesCDB back byte for byte",
    );
    let mut written = cdb::compress(&rewritten, cdb::LEVEL).map_err(|e| format!("iTunesCDB: {e}"))?;
    if !hashab::sign_database(&mut written, &guid.0, &hashab::LIBGPOD_RANDOM) {
        return Err("the iTunesCDB is too short to sign".into());
    }
    all &= check(
        hashab::verify_database(&written, &guid.0),
        "the iTunesCDB written is signed for the GUID",
    );
    let back = cdb::inflate(&written).map_err(|e| format!("written iTunesCDB: {e}"))?;
    all &= check(
        mask_signature(&back) == mask_signature(&inflated),
        "the iTunesCDB written inflates to the same bytes, but for the length, the signature",
    );
    let (a, b) = (db::parse(&inflated), db::parse(&back));
    all &= check(a.is_ok() && a == b, "and lists the same tracks and playlists");
    std::fs::write(out.join("iTunesCDB"), &written).map_err(|e| format!("writing iTunesCDB: {e}"))?;
    println!("     {} bytes written ({} read)", written.len(), raw.len());

    // The SQLite library.
    let itlp_in = itunes.join("iTunes Library.itlp");
    let itlp_out = out.join("iTunes Library.itlp");
    std::fs::create_dir_all(&itlp_out).map_err(|e| format!("creating {}: {e}", itlp_out.display()))?;
    let mut rows = sqlite::read(&itlp_in).map_err(|e| e.to_string())?;
    for r in &mut rows {
        if r.file == "Library.itdb" {
            library::strip_post_processed(r);
        }
    }
    let library_version = FILES[0].user_version;
    let commands = library::post_process(&extended, library_version).map_err(|e| e.to_string())?;
    let failed = sqlite::write(&itlp_out, &rows, &commands).map_err(|e| e.to_string())?;
    println!(
        "info the post-process for user_version {library_version}: {} commands, {} failed",
        commands.len(),
        failed.len()
    );
    for f in failed.iter().filter(|f| !f.is_duplicate_column()) {
        println!("     {}: {}", f.name, f.error);
    }
    all &= check(
        failed.iter().all(sqlite::Failed::is_duplicate_column),
        "only ALTER TABLE … ADD COLUMNs of columns already there failed",
    );
    for file in &FILES {
        let (a, b) = (
            sqlite::snapshot(&itlp_in.join(file.name)).map_err(|e| e.to_string())?,
            sqlite::snapshot(&itlp_out.join(file.name)).map_err(|e| e.to_string())?,
        );
        all &= check(
            a.master == b.master,
            &format!("{}: the same schema, in the same order", file.name),
        );
        all &= check(
            a.pragmas == b.pragmas,
            &format!("{}: the same user_version, page size and auto_vacuum", file.name),
        );
        let rows: usize = a.tables.iter().map(|t| t.rows.len()).sum();
        all &= check(
            a.tables == b.tables,
            &format!("{}: the same rows in every table ({rows})", file.name),
        );
        if a.tables != b.tables {
            for (x, y) in a.tables.iter().zip(&b.tables) {
                if x != y {
                    println!(
                        "     {} differs ({} rows read, {} written)",
                        x.name,
                        x.rows.len(),
                        y.rows.len()
                    );
                }
            }
        }
    }

    // Locations.itdb.cbk.
    let locations = read(&itlp_out.join("Locations.itdb"))?;
    let book = hashab::checksum_book(&locations, &guid.0, &hashab::LIBGPOD_RANDOM);
    all &= check(
        hashab::verify_checksum_book(&book, &locations, &guid.0),
        "Locations.itdb.cbk written is valid for the Locations.itdb written",
    );
    std::fs::write(itlp_out.join("Locations.itdb.cbk"), &book)
        .map_err(|e| format!("writing Locations.itdb.cbk: {e}"))?;
    let apple = read(&itlp_in.join("Locations.itdb.cbk"))?;
    println!(
        "info Locations.itdb is {} bytes written, {} read; {}",
        locations.len(),
        read(&itlp_in.join("Locations.itdb"))?.len(),
        if apple[hashab::SIGNATURE_LEN..] == book[hashab::SIGNATURE_LEN..] {
            "the checksum books' digests are the same: the file is the same, byte for byte"
        } else {
            "the files differ in their bytes (expected: SQLite lays out pages its own way)"
        }
    );
    Ok(all)
}

/// An inflated database with the fields signing and compressing change set to
/// zero: the total length at `0x08` (the compressed file's, before inflating)
/// and the signature.
fn mask_signature(db: &[u8]) -> Vec<u8> {
    let mut copy = db.to_vec();
    if copy.len() >= hashab::DATABASE_SIGNATURE.end {
        copy[8..12].fill(0);
        copy[hashab::DATABASE_SIGNATURE].fill(0);
    }
    copy
}
