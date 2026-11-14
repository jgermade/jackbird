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
use jackbird_ipod::library::Value;
use jackbird_ipod::library::{self, schema::FILES};
use jackbird_ipod::song::{self, MHIT_NOT_KNOWN, Song, Stamp};
use jackbird_ipod::{cdb, chunk, collate, db, hashab, sysinfo};
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

    // Every MP3 rebuilt from its rows, against Apple's mhit.
    let itlp_in_songs = itunes.join("iTunes Library.itlp");
    all &= check_songs(&tree, &sqlite::read(&itlp_in_songs).map_err(|e| e.to_string())?);

    // The SQLite library.
    let itlp_in = itunes.join("iTunes Library.itlp");
    let itlp_out = out.join("iTunes Library.itlp");
    std::fs::create_dir_all(&itlp_out).map_err(|e| format!("creating {}: {e}", itlp_out.display()))?;
    let mut rows = sqlite::read(&itlp_in).map_err(|e| e.to_string())?;
    for r in &mut rows {
        if r.file == "Library.itdb" {
            library::strip_post_processed(r);
            all &= check_ranks(r);
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

    // The artwork, when the copy has it (`Artwork/` beside `iTunes/`).
    if let Some(artwork) = itunes.parent().map(|p| p.join("Artwork")).filter(|a| a.is_dir()) {
        all &= check_artwork(&artwork, &extended)?;
    }
    Ok(all)
}

/// Reads the `ArtworkDB`, writes it back, rebuilds each image's `mhod`s with
/// jackbird's code and decodes every thumbnail from its file.
fn check_artwork(folder: &Path, extended: &str) -> Result<bool, String> {
    use jackbird_ipod::artwork::{self, ArtworkDb};
    let raw = read(&folder.join("ArtworkDB"))?;
    let db = ArtworkDb::parse(&raw).map_err(|e| format!("ArtworkDB: {e}"))?;
    let mut all = check(
        db.write().map_err(|e| e.to_string())? == raw,
        "the ArtworkDB writes back byte for byte",
    );
    let formats = artwork::album_art_formats(extended);
    let images = db.images();
    // Apple's mhii children, against the ones jackbird would write for the same thumbnails.
    let mhli: Vec<&chunk::Chunk> = db
        .tree
        .children()
        .iter()
        .filter(|s| s.header.get(12..14) == Some(&[1, 0][..]))
        .flat_map(|s| s.children().iter().flat_map(|l| l.children()))
        .collect();
    let same = mhli
        .iter()
        .zip(&images)
        .filter(|(m, image)| {
            let mut ours: Vec<chunk::Chunk> = image.thumbs.iter().map(artwork::thumb_mhod).collect();
            ours.push(artwork::mhaf_mhod());
            let bytes = |c: &[chunk::Chunk]| c.iter().map(|x| x.write().unwrap()).collect::<Vec<_>>();
            bytes(m.children()) == bytes(&ours)
        })
        .count();
    all &= check(
        same == images.len(),
        &format!("every image's mhods as jackbird writes them ({same}/{})", images.len()),
    );
    // Every thumbnail inside its file, of its format's slot.
    let mut files: std::collections::HashMap<String, Vec<u8>> = Default::default();
    let mut fine = 0;
    let mut total = 0;
    for t in images.iter().flat_map(|i| &i.thumbs) {
        total += 1;
        let name = t.file.trim_start_matches(':').to_string();
        if !files.contains_key(&name) {
            files.insert(name.clone(), read(&folder.join(&name))?);
        }
        let data = &files[&name];
        let Some(format) = formats.iter().find(|f| f.id == t.format) else {
            continue;
        };
        let (start, end) = (t.offset as usize, t.offset as usize + t.size as usize);
        if t.size as usize == format.slot() && end <= data.len() && t.width <= format.width && t.height <= format.height
        {
            let rgb = artwork::decode(&data[start..end], t.width, t.height, format.row_bytes(format.width));
            fine += usize::from(rgb.len() == usize::from(t.width) * usize::from(t.height) * 3);
        }
    }
    all &= check(
        fine == total,
        &format!("every thumbnail in its file, in its format's slot ({fine}/{total})"),
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

/// The local offset in Madrid (CET, CEST from the last Sunday of March to the
/// last Sunday of October, at 01:00 UTC), to check that the `mhit`'s dates are
/// local time: the rule is the EU's, not taken from the data checked.
fn madrid_offset(unix: i64) -> i32 {
    let (year, ..) = civil(unix);
    let last_sunday = |month: u32| {
        let first_next = days_from_civil(year, month + 1, 1);
        // 1970-01-01 was a Thursday.
        let weekday = (first_next + 4).rem_euclid(7); // 0 = Sunday
        first_next - if weekday == 0 { 7 } else { weekday }
    };
    let start = last_sunday(3) * 86_400 + 3600;
    let end = last_sunday(10) * 86_400 + 3600;
    if unix >= start && unix < end { 7200 } else { 3600 }
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let (y, m) = if m > 12 { (y + 1, m - 12) } else { (y, m) };
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = i64::from((m + 9) % 12);
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil(unix: i64) -> (i64, u32, u32) {
    let z = unix.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { era * 400 + yoe + 1 } else { era * 400 + yoe }, m, d)
}

/// Rebuilds every MP3 of the device from its rows with [`Song::mhit`], and
/// compares each with the `mhit` Apple wrote: the header but for
/// [`MHIT_NOT_KNOWN`], and the `mhod`s byte for byte.
fn check_songs(tree: &chunk::Chunk, rows: &[library::Rows]) -> bool {
    use std::collections::{BTreeMap, HashMap};
    let table = |file: &str, name: &str| {
        rows.iter()
            .find(|r| r.file == file)
            .and_then(|r| r.table(name))
            .cloned()
            .unwrap_or_default()
    };
    let by_pid = |t: &library::Table, key: &str| -> HashMap<i64, Vec<Value>> {
        let k = t.column(key).unwrap_or(0);
        t.rows
            .iter()
            .filter_map(|r| match r[k] {
                Value::Integer(p) => Some((p, r.clone())),
                _ => None,
            })
            .collect()
    };
    let (item, av, loc, kinds) = (
        table("Library.itdb", "item"),
        table("Library.itdb", "avformat_info"),
        table("Locations.itdb", "location"),
        table("Library.itdb", "location_kind_map"),
    );
    let (avs, locs) = (by_pid(&av, "item_pid"), by_pid(&loc, "item_pid"));
    let kind_names = by_pid(&kinds, "id");
    let get = |t: &library::Table, row: &[Value], c: &str| t.column(c).map(|i| row[i].clone()).unwrap_or(Value::Null);
    let int = |v: Value| match v {
        Value::Integer(i) => i,
        Value::Real(r) => r as i64,
        _ => 0,
    };
    let text = |v: Value| match v {
        Value::Text(t) => Some(t),
        _ => None,
    };
    let mhits: Vec<&chunk::Chunk> = tree
        .children()
        .iter()
        .filter(|s| s.header[12..16] == 1u32.to_le_bytes())
        .flat_map(|s| s.children().iter().flat_map(|l| l.children()))
        .collect();
    let (mut songs, mut same_header, mut same_mhods) = (0, 0, 0);
    let mut offsets: BTreeMap<usize, usize> = BTreeMap::new();
    let mut mhod_examples = Vec::new();
    let mut columns: BTreeMap<&str, usize> = BTreeMap::new();
    for apple in mhits {
        let h = &apple.header;
        let u32_at = |at: usize| u32::from_le_bytes(h[at..at + 4].try_into().unwrap());
        if u32_at(0x18) != song::MP3 {
            continue;
        }
        let pid = i64::from_le_bytes(h[0x70..0x78].try_into().unwrap());
        let Some(row) = item.rows.iter().find(|r| int(r[0].clone()) == pid) else {
            continue;
        };
        let (Some(a), Some(l)) = (avs.get(&pid), locs.get(&pid)) else {
            continue;
        };
        let g = |c: &str| get(&item, row, c);
        let unix_2001 = |v: i64| if v == 0 { 0 } else { v + song::UNIX_TO_2001 };
        let stamp = |since_2001: i64| {
            let unix = unix_2001(since_2001);
            Stamp {
                unix,
                offset: madrid_offset(unix),
            }
        };
        let kind_id = int(get(&loc, l, "kind_id"));
        let s = Song {
            pid,
            track_id: u32_at(0x10),
            title: text(g("title")),
            artist: text(g("artist")),
            album: text(g("album")),
            album_artist: text(g("album_artist")),
            genre: None,
            composer: text(g("composer")),
            comment: text(g("comment")),
            sort_title: None,
            sort_artist: None,
            sort_album: None,
            sort_album_artist: None,
            sort_composer: None,
            kind: kind_names
                .get(&kind_id)
                .and_then(|k| text(k[1].clone()))
                .unwrap_or_default(),
            path: text(get(&loc, l, "location")).unwrap_or_default(),
            size: int(get(&loc, l, "file_size")) as u32,
            length_ms: int(g("total_time_ms")) as u32,
            samples: int(get(&av, a, "duration")) as u64,
            bitrate: int(get(&av, a, "bit_rate")) as u32,
            sample_rate: int(get(&av, a, "sample_rate")) as u32,
            vbr: h[0x1c] == 1,
            track_number: int(g("track_number")) as u32,
            track_count: int(g("track_count")) as u32,
            disc_number: int(g("disc_number")) as u32,
            disc_count: int(g("disc_count")) as u32,
            year: int(g("year")) as u32,
            bpm: int(g("bpm")) as u16,
            compilation: int(g("is_compilation")) == 1,
            modified: stamp(int(g("date_modified"))),
            added: stamp(int(get(&loc, l, "date_created"))),
            album_id: u32_at(0x120),
            album_pid: None,
            artist_id: u32_at(0x1e0),
            artist_pid: None,
            composer_pid: 0,
            genre_id: 0,
            artwork_id: (h[0xa4] == 1).then(|| u32_at(0x160)),
        };
        // The genre's name is in genre_map; take it from Apple's mhod 5 to
        // check the rest (genres are N4b's).
        let genre = apple
            .children()
            .iter()
            .find(|m| m.header[12..16] == 5u32.to_le_bytes())
            .map(|m| match &m.body {
                chunk::Body::Raw(b) => String::from_utf16_lossy(
                    &b[16..]
                        .chunks(2)
                        .map(|p| u16::from_le_bytes([p[0], p[1]]))
                        .collect::<Vec<_>>(),
                ),
                _ => String::new(),
            });
        let s = Song { genre, ..s };
        songs += 1;
        for (column, value) in s.item_row() {
            let skip = ["genre_id", "album_pid", "artist_pid", "composer_pid"];
            if !skip.contains(&column) && g(column) != value {
                *columns.entry(column).or_default() += 1;
            }
        }
        let ours = s.mhit();
        let mut differs = false;
        for (at, (mine, theirs)) in ours.header.iter().zip(h.iter()).enumerate() {
            if MHIT_NOT_KNOWN.iter().any(|(o, n, _)| at >= *o && at < o + n) {
                continue;
            }
            if mine != theirs {
                *offsets.entry(at & !3).or_default() += 1;
                differs = true;
            }
        }
        same_header += usize::from(!differs);
        let (a_mhods, o_mhods) = (apple.children(), ours.children());
        let bytes = |c: &[chunk::Chunk]| c.iter().map(|m| m.write().unwrap()).collect::<Vec<_>>();
        if bytes(a_mhods) == bytes(o_mhods) {
            same_mhods += 1;
        } else if mhod_examples.len() < 5 {
            let types = |c: &[chunk::Chunk]| {
                c.iter()
                    .map(|m| u32::from_le_bytes(m.header[12..16].try_into().unwrap()))
                    .collect::<Vec<_>>()
            };
            mhod_examples.push(format!(
                "{:?} against Apple's {:?} ({})",
                types(o_mhods),
                types(a_mhods),
                s.title.clone().unwrap_or_default()
            ));
        }
    }
    println!("info {songs} MP3s rebuilt from their rows");
    for (at, n) in &offsets {
        println!("     the header differs at {at:#05x} in {n}");
    }
    for (column, n) in &columns {
        println!("     item.{column} differs in {n}");
    }
    for e in &mhod_examples {
        println!("     mhods: {e}");
    }
    let header_ok = check(
        same_header == songs,
        &format!("every MP3's mhit header, but for what a new song cannot know ({same_header}/{songs})"),
    );
    let mhods_ok = check(
        same_mhods == songs,
        &format!("every MP3's mhods, byte for byte ({same_mhods}/{songs})"),
    );
    let rows_ok = check(columns.is_empty(), "every MP3's item row, in the columns a song sets");
    header_ok && mhods_ok && rows_ok
}

/// Recomputes every rank of the library with [`collate::rank_library`] and
/// compares each with Apple's.
fn check_ranks(library: &library::Rows) -> bool {
    let mut ours = library.clone();
    collate::rank_library(&mut ours);
    let mut all = true;
    for (table, column) in [
        ("item", "title_order"),
        ("item", "artist_order"),
        ("item", "album_order"),
        ("item", "album_artist_order"),
        ("item", "composer_order"),
        ("item", "genre_order"),
        ("item", "series_name_order"),
        ("artist", "name_order"),
        ("album", "name_order"),
        ("composer", "name_order"),
        ("genre_map", "genre_order"),
    ] {
        let values = |rows: &library::Rows| -> Vec<Value> {
            let t = rows.table(table).cloned().unwrap_or_default();
            let c = t.column(column);
            t.rows.iter().map(|r| c.map_or(Value::Null, |c| r[c].clone())).collect()
        };
        let (a, b) = (values(library), values(&ours));
        let same = a.iter().zip(&b).filter(|(x, y)| x == y).count();
        all &= check(
            same == a.len(),
            &format!("{table}.{column}: every rank as Apple's ({same}/{})", a.len()),
        );
    }
    all
}
