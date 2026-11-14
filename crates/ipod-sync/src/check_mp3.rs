//! `ipod-check-mp3`: reads every MP3 an iPod already holds with [`read_mp3`],
//! the code `ipod-add` reads new ones with, and compares what it finds with
//! what Apple wrote for each in the iPod's databases. It writes nothing.
//!
//! ```text
//! cargo run -p jackbird-ipod-sync --bin ipod-check-mp3 -- "/Volumes/<the iPod>"
//! ```

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::ExitCode;

use jackbird_ipod::library::Value;
use jackbird_ipod::song::MP3;
use jackbird_ipod_sync::{open, read_mp3};

fn main() -> ExitCode {
    let Some(root) = std::env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("usage: ipod-check-mp3 <the iPod's mount point>");
        return ExitCode::from(2);
    };
    let device = match open(&root) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };
    let rows = |file: &str, table: &str| {
        device
            .ipod
            .rows
            .iter()
            .find(|r| r.file == file)
            .and_then(|r| r.table(table))
            .cloned()
            .unwrap_or_default()
    };
    let (item, av, loc, genres) = (
        rows("Library.itdb", "item"),
        rows("Library.itdb", "avformat_info"),
        rows("Locations.itdb", "location"),
        rows("Library.itdb", "genre_map"),
    );
    let int = |v: Value| match v {
        Value::Integer(i) => i,
        Value::Real(r) => r as i64,
        _ => 0,
    };
    let by = |t: &jackbird_ipod::library::Table, key: &str| -> HashMap<i64, Vec<Value>> {
        t.rows.iter().map(|r| (int(t.get(r, key)), r.clone())).collect()
    };
    let (avs, items) = (by(&av, "item_pid"), by(&item, "pid"));
    let genre_names: HashMap<i64, Value> = genres
        .rows
        .iter()
        .map(|r| (int(genres.get(r, "id")), genres.get(r, "genre")))
        .collect();
    // The VBR flag, from the mhits.
    let mut vbr_flag: HashMap<i64, bool> = HashMap::new();
    fn walk(c: &jackbird_ipod::chunk::Chunk, out: &mut HashMap<i64, bool>) {
        if c.name() == *b"mhit" && c.header.len() > 0x78 {
            let pid = i64::from_le_bytes(c.header[0x70..0x78].try_into().unwrap());
            out.insert(pid, c.header[0x1c] == 1);
        }
        for child in c.children() {
            walk(child, out);
        }
    }
    walk(&device.ipod.tree, &mut vbr_flag);

    let mut differs: BTreeMap<&str, (usize, Vec<String>)> = BTreeMap::new();
    let (mut checked, mut unreadable) = (0, 0);
    for l in &loc.rows {
        if int(loc.get(l, "extension")) != i64::from(MP3) {
            continue;
        }
        let pid = int(loc.get(l, "item_pid"));
        let (Some(i), Some(a)) = (items.get(&pid), avs.get(&pid)) else {
            continue;
        };
        let Value::Text(place) = loc.get(l, "location") else {
            continue;
        };
        let path = root.join("iPod_Control").join("Music").join(&place);
        let song = match read_mp3(&path, &|_| 0) {
            Ok(s) => s,
            Err(e) => {
                unreadable += 1;
                eprintln!("{place}: {e}");
                continue;
            }
        };
        checked += 1;
        let text = |v: Option<String>| v.map_or(Value::Null, Value::Text);
        let n = |v: u32| Value::Integer(i64::from(v));
        let fields: [(&str, Value, Value); 15] = [
            ("size", n(song.size), loc.get(l, "file_size")),
            ("samples", Value::Integer(song.samples as i64), av.get(a, "duration")),
            (
                "length_ms",
                n(song.length_ms),
                Value::Integer(int(item.get(i, "total_time_ms"))),
            ),
            ("bitrate", n(song.bitrate), av.get(a, "bit_rate")),
            (
                "sample_rate",
                n(song.sample_rate),
                Value::Integer(int(av.get(a, "sample_rate"))),
            ),
            (
                "vbr",
                Value::Integer(i64::from(song.vbr)),
                Value::Integer(i64::from(vbr_flag.get(&pid) == Some(&true))),
            ),
            ("title", text(song.title.clone()), item.get(i, "title")),
            ("artist", text(song.artist.clone()), item.get(i, "artist")),
            ("album", text(song.album.clone()), item.get(i, "album")),
            (
                "album_artist",
                text(song.album_artist.clone()),
                item.get(i, "album_artist"),
            ),
            (
                "genre",
                text(song.genre.clone()),
                genre_names
                    .get(&int(item.get(i, "genre_id")))
                    .cloned()
                    .unwrap_or(Value::Null),
            ),
            ("year", n(song.year), item.get(i, "year")),
            (
                "track",
                Value::Text(format!("{}/{}", song.track_number, song.track_count)),
                Value::Text(format!(
                    "{}/{}",
                    int(item.get(i, "track_number")),
                    int(item.get(i, "track_count"))
                )),
            ),
            (
                "disc",
                Value::Text(format!("{}/{}", song.disc_number, song.disc_count)),
                Value::Text(format!(
                    "{}/{}",
                    int(item.get(i, "disc_number")),
                    int(item.get(i, "disc_count"))
                )),
            ),
            (
                "compilation",
                Value::Integer(i64::from(song.compilation)),
                item.get(i, "is_compilation"),
            ),
        ];
        for (name, ours, apple) in fields {
            if ours != apple {
                let entry = differs.entry(name).or_default();
                entry.0 += 1;
                if entry.1.len() < 3 || name == "length_ms" {
                    entry.1.push(format!("{place}: jackbird {ours:?}, Apple {apple:?}"));
                }
            }
        }
    }
    println!("{checked} MP3s read and compared ({unreadable} could not be read)");
    for (name, (count, examples)) in &differs {
        println!("  {name} differs in {count}");
        for e in examples {
            println!("    {e}");
        }
    }
    if differs.is_empty() && unreadable == 0 {
        println!("every field the same");
    }
    ExitCode::SUCCESS
}
