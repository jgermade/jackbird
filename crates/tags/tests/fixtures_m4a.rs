//! The `.m4a` fixtures (`fixtures/tags/`, made by `make-m4a.mjs`): what reading each gives, its
//! audio region, its layout from any head, and its audio; and, by hand, every `.m4a` of a folder
//! (the owner's iPod). See RECORD/2026-11-28.aac-m4a.WIP.md (A0, A1).

use std::fs;
use std::path::{Path, PathBuf};

use jackbird_tags::{
    Cover, Edit, FIRST_HEAD, Field, Fields, FileLayout, Format, Layout, TAIL_LEN, audio, audio_region, format_of,
    layout, read, read_head, write,
};
use serde_json::Value;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tags")
}

struct Case {
    name: String,
    bytes: Vec<u8>,
    codec: String,
    fields: Fields,
    cover: Option<Cover>,
    region: (usize, usize),
}

/// The wire's names of the fields (`src/helpers/tagwire.ts`), as `cases-m4a.json` has them.
const KEYS: [(Field, &str); 20] = [
    (Field::Title, "title"),
    (Field::Artist, "artist"),
    (Field::Album, "album"),
    (Field::Year, "year"),
    (Field::Genre, "genre"),
    (Field::Track, "track"),
    (Field::Disc, "disc"),
    (Field::AlbumArtist, "albumArtist"),
    (Field::Compilation, "compilation"),
    (Field::Composer, "composer"),
    (Field::Comment, "comment"),
    (Field::Lyrics, "lyrics"),
    (Field::Bpm, "bpm"),
    (Field::MbAlbumId, "mbAlbumId"),
    (Field::MbReleaseGroupId, "mbReleaseGroupId"),
    (Field::MbAlbumArtistId, "mbAlbumArtistId"),
    (Field::MbReleaseTrackId, "mbReleaseTrackId"),
    (Field::MbRecordingId, "mbRecordingId"),
    (Field::DiscogsReleaseId, "discogsReleaseId"),
    (Field::JackbirdTrackId, "jackbirdTrackId"),
];

fn cases() -> Vec<Case> {
    let json: Value = serde_json::from_str(&fs::read_to_string(root().join("cases-m4a.json")).unwrap()).unwrap();
    json["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            let mut fields = Fields::default();
            for (field, key) in KEYS {
                let value = case["fields"][key].as_str().unwrap_or_default().to_owned();
                set(&mut fields, field, value);
            }
            assert_eq!(case["format"], "mp4");
            Case {
                name: case["name"].as_str().unwrap().to_owned(),
                bytes: fs::read(root().join(case["file"].as_str().unwrap())).unwrap(),
                codec: case["codec"].as_str().unwrap().to_owned(),
                fields,
                cover: case["cover"].as_object().map(|cover| Cover {
                    data: fs::read(root().join(cover["file"].as_str().unwrap())).unwrap(),
                    mime: cover["mime"].as_str().unwrap().to_owned(),
                }),
                region: (
                    case["region"]["start"].as_u64().unwrap() as usize,
                    case["region"]["end"].as_u64().unwrap() as usize,
                ),
            }
        })
        .collect()
}

/// `Fields` has no public setter: each field by its name.
fn set(fields: &mut Fields, field: Field, value: String) {
    let slot = match field {
        Field::Title => &mut fields.title,
        Field::Artist => &mut fields.artist,
        Field::Album => &mut fields.album,
        Field::Year => &mut fields.year,
        Field::Genre => &mut fields.genre,
        Field::Track => &mut fields.track,
        Field::Disc => &mut fields.disc,
        Field::AlbumArtist => &mut fields.album_artist,
        Field::Compilation => &mut fields.compilation,
        Field::Composer => &mut fields.composer,
        Field::Comment => &mut fields.comment,
        Field::Lyrics => &mut fields.lyrics,
        Field::Bpm => &mut fields.bpm,
        Field::MbAlbumId => &mut fields.mb_album_id,
        Field::MbReleaseGroupId => &mut fields.mb_release_group_id,
        Field::MbAlbumArtistId => &mut fields.mb_album_artist_id,
        Field::MbReleaseTrackId => &mut fields.mb_release_track_id,
        Field::MbRecordingId => &mut fields.mb_recording_id,
        Field::DiscogsReleaseId => &mut fields.discogs_release_id,
        Field::JackbirdTrackId => &mut fields.jackbird_track_id,
    };
    *slot = value;
}

fn tail_of(bytes: &[u8]) -> &[u8] {
    &bytes[bytes.len().saturating_sub(TAIL_LEN)..]
}

/// The layout as an app finds it: the first head, then what it asks for; and how many heads it took.
fn found(bytes: &[u8]) -> (FileLayout, usize) {
    let mut given = FIRST_HEAD.min(bytes.len());
    for steps in 1..=8 {
        match layout(&bytes[..given], tail_of(bytes), bytes.len() as u64).unwrap() {
            Layout::Known(found) => return (found, steps),
            Layout::NeedHead(n) => {
                assert!(
                    n as usize > given && n as usize <= bytes.len(),
                    "asked for {n} with {given}"
                );
                given = n as usize;
            }
        }
    }
    panic!("no layout in eight steps");
}

/// Whether `moov` follows `mdat` (the fixtures built so, `m4a-moov-last`).
fn moov_last(bytes: &[u8]) -> bool {
    let (boxes, _) = jackbird_mp4::top_level(bytes, bytes.len() as u64).unwrap();
    let at = |kind: &[u8; 4]| boxes.iter().position(|placed| placed.header.kind == *kind).unwrap();
    at(b"mdat") < at(b"moov")
}

#[test]
fn every_case_reads_as_cases_m4a_json_says() {
    let all = cases();
    assert_eq!(all.len(), 13);
    for case in all {
        assert_eq!(format_of(&case.bytes), Some(Format::Mp4), "{}", case.name);
        let tags = read(&case.bytes).unwrap_or_else(|error| panic!("{}: {error}", case.name));
        assert_eq!(tags.format, Format::Mp4, "{}", case.name);
        assert_eq!(tags.fields, case.fields, "{}", case.name);
        assert_eq!(tags.cover, case.cover, "{}", case.name);
    }
}

#[test]
fn every_audio_region_is_mdats_content() {
    for case in cases() {
        assert_eq!(audio_region(&case.bytes), case.region.0..case.region.1, "{}", case.name);
    }
}

#[test]
fn layout_gives_each_fixtures_tags_and_region() {
    for case in cases() {
        let (layout, steps) = found(&case.bytes);
        assert_eq!(layout.format, Some(Format::Mp4), "{}", case.name);
        assert_eq!(
            layout.audio,
            case.region.0 as u64..case.region.1 as u64,
            "{}",
            case.name
        );
        // The tags end where the audio starts, or with moov last, at the file's end.
        let tags_end = if moov_last(&case.bytes) {
            case.bytes.len()
        } else {
            case.region.0
        };
        assert_eq!(layout.tags_end, tags_end as u64, "{}", case.name);
        assert_eq!(steps, 1, "{}: the fixtures fit the first head", case.name);
        assert_eq!(
            read_head(&case.bytes[..layout.tags_end as usize], &layout),
            read(&case.bytes),
            "{}",
            case.name
        );
    }
}

#[test]
fn layout_from_any_head_asks_for_more_or_knows_the_same() {
    for case in cases() {
        let (whole, _) = found(&case.bytes);
        let len = case.bytes.len();
        for given in 0..=len {
            let mut at = given;
            loop {
                match layout(&case.bytes[..at], tail_of(&case.bytes), len as u64).unwrap() {
                    Layout::Known(known) => {
                        assert_eq!(known, whole, "{} from {given}", case.name);
                        break;
                    }
                    Layout::NeedHead(n) => {
                        assert!(n as usize > at && n as usize <= len, "{}: {n} after {at}", case.name);
                        at = n as usize;
                    }
                }
            }
        }
    }
}

#[test]
fn every_case_gives_its_length_and_rates() {
    // As make-m4a.mjs makes the audio: 22,050 Hz, mono, half a second (mdhd counts AAC's priming
    // too: 12 frames of 1,024 samples, 557 ms); ALAC at 16 bits; afconvert's, AAC as well.
    for case in cases() {
        let (layout, _) = found(&case.bytes);
        let found = audio(&case.bytes[..layout.tags_end as usize], &layout)
            .unwrap_or_else(|| panic!("{}: no audio", case.name));
        assert_eq!((found.sample_rate, found.channels), (22_050, 1), "{}", case.name);
        assert!(
            (450..700).contains(&found.duration_ms),
            "{}: {} ms",
            case.name,
            found.duration_ms
        );
        let bits = if case.codec == "alac" { 16 } else { 0 };
        assert_eq!(found.bits, bits, "{}", case.name);
        assert!(found.bitrate > 0, "{}", case.name);
    }
}

#[test]
fn a_save_is_refused_until_a2() {
    for case in cases() {
        let edit = Edit {
            title: Some("After".into()),
            ..Edit::default()
        };
        assert_eq!(
            write(&case.bytes, &edit).unwrap_err().code(),
            "not-supported",
            "{}",
            case.name
        );
    }
}

/// Every `.m4a` under a folder.
fn m4a_files(folder: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(folder) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("._") {
            continue;
        }
        if path.is_dir() {
            m4a_files(&path, out);
        } else if name.to_lowercase().ends_with(".m4a") {
            out.push(path);
        }
    }
}

/// A file's first `n` bytes.
fn head_of(path: &Path, n: u64) -> Vec<u8> {
    use std::io::Read;
    let mut out = Vec::new();
    fs::File::open(path).unwrap().take(n).read_to_end(&mut out).unwrap();
    out
}

/// A file's last `n` bytes.
fn tail_of_file(path: &Path, len: u64, n: u64) -> Vec<u8> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(path).unwrap();
    file.seek(SeekFrom::Start(len.saturating_sub(n))).unwrap();
    let mut out = Vec::new();
    file.read_to_end(&mut out).unwrap();
    out
}

/// Reads every `.m4a` under `JACKBIRD_M4A_CORPUS` (the owner's iPod, never committed) as the app
/// does, its first bytes and then what `layout` asks for: each has a layout, its tags read from
/// that head, and its audio. Only the heads are read, not the audio (a USB drive's songs are
/// gigabytes). `cargo test -p jackbird-tags --test fixtures_m4a -- --ignored --nocapture`.
#[test]
#[ignore = "reads a folder given by JACKBIRD_M4A_CORPUS"]
fn a_corpus_of_m4a_files_reads() {
    let folder = std::env::var("JACKBIRD_M4A_CORPUS").expect("JACKBIRD_M4A_CORPUS: a folder of .m4a files");
    let mut files = Vec::new();
    m4a_files(Path::new(&folder), &mut files);
    assert!(!files.is_empty(), "no .m4a under {folder}");
    let mut filled = [0usize; 20];
    let (mut covers, mut heads, mut moov_last, mut head_bytes) = (0, 0, 0, 0u64);
    let mut codecs = std::collections::BTreeMap::<String, usize>::new();
    let mut failures = Vec::new();
    for path in &files {
        let len = fs::metadata(path).unwrap().len();
        let tail = tail_of_file(path, len, TAIL_LEN as u64);
        let outcome = (|| -> Result<(), String> {
            let mut given = (FIRST_HEAD as u64).min(len);
            let mut head = head_of(path, given);
            let layout = loop {
                heads += 1;
                match layout(&head, &tail, len).map_err(|error| error.to_string())? {
                    Layout::Known(found) => break found,
                    Layout::NeedHead(n) if n > given => {
                        given = n;
                        head = head_of(path, n);
                    }
                    Layout::NeedHead(n) => return Err(format!("asked for {n} again")),
                }
            };
            if layout.tags_end == len {
                moov_last += 1;
            }
            let head = &head[..layout.tags_end as usize];
            head_bytes += head.len() as u64;
            let tags = read_head(head, &layout).map_err(|error| error.to_string())?;
            let found = audio(head, &layout).ok_or("no audio")?;
            let (boxes, _) = jackbird_mp4::top_level(head, len).map_err(|error| error.to_string())?;
            let moov = boxes
                .iter()
                .find(|placed| placed.header.kind == *b"moov")
                .ok_or("no moov")?
                .content();
            let codec = jackbird_mp4::audio_track(&head[moov.start as usize..moov.end as usize])
                .ok()
                .flatten()
                .map(|track| format!("{:?}", track.codec))
                .unwrap_or_else(|| format!("{} Hz, {} ch", found.sample_rate, found.channels));
            *codecs
                .entry(format!("{codec} · {} Hz · {} ch", found.sample_rate, found.channels))
                .or_default() += 1;
            for (index, field) in Field::ALL.iter().enumerate() {
                filled[index] += usize::from(!tags.fields.get(*field).is_empty());
            }
            covers += usize::from(tags.cover.is_some());
            Ok(())
        })();
        if let Err(why) = outcome {
            failures.push(format!("{}: {why}", path.display()));
        }
    }
    println!(
        "{} files; {heads} heads read ({} KiB in all); {moov_last} with moov after the audio; {covers} with a cover",
        files.len(),
        head_bytes / 1024
    );
    for (codec, count) in &codecs {
        println!("  {codec}: {count}");
    }
    for ((_, key), count) in KEYS.iter().zip(filled) {
        println!("  {key:<18} {count}");
    }
    assert!(
        failures.is_empty(),
        "{} failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
