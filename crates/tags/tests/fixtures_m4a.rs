//! The `.m4a` fixtures (`fixtures/tags/`, made by `make-m4a.mjs`): what reading each gives, its
//! audio region, its layout from any head, and its audio; and, by hand, every `.m4a` of a folder
//! (the owner's iPod). See RECORD/2026-11-28.aac-m4a.WIP.md (A0, A1).

use std::fs;
use std::path::{Path, PathBuf};

use jackbird_tags::{
    Cover, CoverEdit, Edit, FIRST_HEAD, Field, Fields, FileLayout, Format, Layout, TAIL_LEN, audio, audio_region,
    format_of, layout, read, read_head, write, write_head,
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

// ---------------------------------------------------------------- saving (A2)

fn be32(bytes: &[u8], at: usize) -> usize {
    u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize
}

/// Every sample of every track, found by the test's own walk of the sample tables (`stsz`,
/// `stsc`, `stco` or `co64`): what a save must leave as it was, wherever it put it.
fn samples(bytes: &[u8]) -> Vec<Vec<u8>> {
    let (boxes, _) = jackbird_mp4::top_level(bytes, bytes.len() as u64).unwrap();
    let moov = boxes
        .iter()
        .find(|placed| placed.header.kind == *b"moov")
        .unwrap()
        .content();
    let moov = &bytes[moov.start as usize..moov.end as usize];
    let mut out = Vec::new();
    for trak in jackbird_mp4::children(moov)
        .unwrap()
        .into_iter()
        .filter(|kid| kid.kind == *b"trak")
    {
        let stbl = jackbird_mp4::path(trak.body, &[b"mdia", b"minf", b"stbl"])
            .unwrap()
            .unwrap()
            .body;
        let table = |kind: &[u8; 4]| jackbird_mp4::child(stbl, kind).unwrap().map(|found| found.body);
        let stsz = table(b"stsz").unwrap();
        let (fixed, count) = (be32(stsz, 4), be32(stsz, 8));
        let sizes: Vec<usize> = (0..count)
            .map(|n| if fixed > 0 { fixed } else { be32(stsz, 12 + 4 * n) })
            .collect();
        let stsc = table(b"stsc").unwrap();
        let runs: Vec<(usize, usize)> = (0..be32(stsc, 4))
            .map(|n| (be32(stsc, 8 + 12 * n), be32(stsc, 12 + 12 * n)))
            .collect();
        let offsets: Vec<usize> = match (table(b"stco"), table(b"co64")) {
            (Some(stco), _) => (0..be32(stco, 4)).map(|n| be32(stco, 8 + 4 * n)).collect(),
            (_, Some(co64)) => (0..be32(co64, 4))
                .map(|n| u64::from_be_bytes(co64[8 + 8 * n..16 + 8 * n].try_into().unwrap()) as usize)
                .collect(),
            _ => panic!("no chunk offsets"),
        };
        let mut next = 0;
        for (chunk, offset) in offsets.iter().enumerate() {
            let per = runs.iter().rfind(|run| run.0 <= chunk + 1).unwrap().1;
            let mut at = *offset;
            for _ in 0..per {
                if next == sizes.len() {
                    break;
                }
                out.push(bytes[at..at + sizes[next]].to_vec());
                at += sizes[next];
                next += 1;
            }
        }
        assert_eq!(next, sizes.len());
    }
    out
}

/// Saves `edit` into a case both ways (the whole file; the head and its splice, as the apps do),
/// checks they agree and that every sample is the source's, and gives the new file.
fn saved(case: &Case, edit: &Edit) -> Vec<u8> {
    let out = write(&case.bytes, edit).unwrap_or_else(|error| panic!("{}: {error}", case.name));
    let (layout, _) = found(&case.bytes);
    let splice = write_head(&case.bytes[..layout.tags_end as usize], &layout, edit).unwrap();
    let mut by_head = splice.with.clone();
    by_head.extend_from_slice(&case.bytes[splice.replace.end as usize..]);
    assert_eq!(by_head, out, "{}: the head's splice gives other bytes", case.name);
    assert_eq!(samples(&out), samples(&case.bytes), "{}: the audio changed", case.name);
    let (after, _) = found(&out);
    assert_eq!(
        out[after.audio.start as usize..after.audio.end as usize],
        case.bytes[case.region.0..case.region.1],
        "{}",
        case.name
    );
    out
}

fn title(value: &str) -> Edit {
    Edit {
        title: Some(value.into()),
        ..Edit::default()
    }
}

#[test]
fn a_new_title_saves_in_every_case() {
    for case in cases() {
        for value in [
            "After",
            "A title much longer than the one it replaces, to make the tags grow",
        ] {
            let out = saved(&case, &title(value));
            let back = read(&out).unwrap();
            let mut fields = case.fields.clone();
            fields.title = value.into();
            assert_eq!(back.fields, fields, "{}", case.name);
            assert_eq!(back.cover, case.cover, "{}", case.name);
        }
    }
}

#[test]
fn every_field_at_once() {
    let wanted = Fields {
        title: "Ñandú — 東京".into(),
        artist: "One/Two".into(),
        album: "Album".into(),
        year: "2001-05-04T07:00:00Z".into(),
        genre: "Rock Galego".into(),
        track: "7/9".into(),
        disc: "2".into(),
        album_artist: "Album Artist".into(),
        compilation: "1".into(),
        composer: "Composer".into(),
        comment: "A comment".into(),
        lyrics: "La la la\nLa la".into(),
        bpm: "98".into(),
        mb_album_id: "a1".into(),
        mb_release_group_id: "a2".into(),
        mb_album_artist_id: "a3".into(),
        mb_release_track_id: "a4".into(),
        mb_recording_id: "a5".into(),
        discogs_release_id: "12345".into(),
        jackbird_track_id: "jb-1".into(),
    };
    for case in cases() {
        let out = saved(&case, &Edit::all(&wanted));
        assert_eq!(read(&out).unwrap().fields, wanted, "{}", case.name);
    }
}

#[test]
fn emptied_fields_go_and_the_rest_stays() {
    for case in cases() {
        let out = saved(&case, &Edit::all(&Fields::default()));
        assert_eq!(read(&out).unwrap().fields, Fields::default(), "{}", case.name);
        // The items jackbird has no field for stay: in the full list, ©too, soar, apID, xqzw and
        // two freeform items (iTunSMPB, a ReplayGain value).
        if case.name == "m4a-faststart-padded" {
            let (boxes, _) = jackbird_mp4::top_level(&out, out.len() as u64).unwrap();
            let moov = boxes
                .iter()
                .find(|placed| placed.header.kind == *b"moov")
                .unwrap()
                .content();
            let items = jackbird_mp4::tags(&out[moov.start as usize..moov.end as usize]).unwrap();
            let kinds: Vec<String> = items.iter().map(|item| jackbird_mp4::name(&item.kind)).collect();
            assert_eq!(kinds, ["covr", "----", "----", "\u{a9}too", "soar", "apID", "xqzw"]);
        }
    }
}

#[test]
fn a_cover_set_replaces_the_one_shown_and_a_removal_takes_it_out() {
    let new = Cover {
        data: fs::read(root().join("covers/cover9.jpg")).unwrap(),
        mime: "image/jpeg".into(),
    };
    let png = Cover {
        data: fs::read(root().join("covers/cover3.png")).unwrap(),
        mime: "image/png".into(),
    };
    let second = Cover {
        data: fs::read(root().join("covers/cover2.jpg")).unwrap(),
        mime: "image/jpeg".into(),
    };
    for case in cases() {
        for cover in [&new, &png] {
            let edit = Edit {
                cover: CoverEdit::Set(cover.clone()),
                ..Edit::default()
            };
            let out = saved(&case, &edit);
            let back = read(&out).unwrap();
            assert_eq!(back.cover.as_ref(), Some(cover), "{}", case.name);
            assert_eq!(back.fields, case.fields, "{}", case.name);
        }
        let remove = Edit {
            cover: CoverEdit::Remove,
            ..Edit::default()
        };
        let out = saved(&case, &remove);
        // The full list has a second picture, which is shown next; the others had one or none.
        let next = (case.fields.title == "Before").then(|| second.clone());
        assert_eq!(read(&out).unwrap().cover, next, "{}", case.name);
    }
}

#[test]
fn an_edit_that_changes_nothing_gives_the_same_bytes() {
    for case in cases() {
        assert_eq!(
            write(&case.bytes, &Edit::all(&case.fields)).unwrap(),
            case.bytes,
            "{}",
            case.name
        );
        assert_eq!(
            write(&case.bytes, &Edit::default()).unwrap(),
            case.bytes,
            "{}",
            case.name
        );
    }
}

#[test]
fn the_room_after_ilst_keeps_the_audio_in_place_and_without_it_the_offsets_move() {
    let by_name = |name: &str| cases().into_iter().find(|case| case.name == name).unwrap();
    let audio_start = |bytes: &[u8]| found(bytes).0.audio.start;
    // 1 KiB of free after ilst: a new title fits, the file keeps its size and its audio its place.
    let padded = by_name("m4a-faststart-padded");
    let out = saved(&padded, &title("A somewhat longer title"));
    assert_eq!(
        (out.len(), audio_start(&out)),
        (padded.bytes.len(), padded.region.0 as u64)
    );
    // No free: moov grows (with 2 KiB of room for the next save), the audio and its offsets move.
    for name in ["m4a-faststart-tight", "m4a-co64", "m4a-no-udta", "m4a-empty-ilst"] {
        let case = by_name(name);
        let out = saved(&case, &title("A somewhat longer title"));
        assert!(audio_start(&out) > case.region.0 as u64, "{name}");
        // The next save fits in that room.
        let again = write(&out, &title("Another title, a little longer still")).unwrap();
        assert_eq!(
            (again.len(), audio_start(&again)),
            (out.len(), audio_start(&out)),
            "{name}"
        );
    }
    // afconvert's 3 KiB of free after moov takes moov's growth: the audio stays where it was.
    let apple = by_name("m4a-made-by-afconvert");
    let out = saved(&apple, &title("A title"));
    assert_eq!(
        (out.len(), audio_start(&out)),
        (apple.bytes.len(), apple.region.0 as u64)
    );
    // moov last: it changes at the end, the audio does not move.
    let last = by_name("m4a-moov-last");
    let out = saved(&last, &title("A somewhat longer title"));
    assert_eq!(audio_start(&out), last.region.0 as u64);
}

#[test]
fn numbers_that_are_not_numbers_are_refused() {
    let case = &cases()[0];
    for edit in [
        Edit {
            track: Some("three".into()),
            ..Edit::default()
        },
        Edit {
            disc: Some("1/two".into()),
            ..Edit::default()
        },
        Edit {
            bpm: Some("fast".into()),
            ..Edit::default()
        },
    ] {
        assert_eq!(
            write(&case.bytes, &edit).unwrap_err().code(),
            "refused-fields",
            "{edit:?}"
        );
    }
}

#[test]
fn lofty_reads_what_jackbird_writes() {
    use lofty::prelude::*;
    for case in cases() {
        let out = saved(&case, &title("Read by lofty"));
        let tagged = lofty::probe::Probe::new(std::io::Cursor::new(&out))
            .guess_file_type()
            .unwrap()
            .read()
            .unwrap_or_else(|error| panic!("{}: {error}", case.name));
        let tag = tagged.primary_tag().unwrap_or_else(|| panic!("{}: no tag", case.name));
        assert_eq!(tag.title().as_deref(), Some("Read by lofty"), "{}", case.name);
        assert_eq!(
            tag.artist().as_deref(),
            (!case.fields.artist.is_empty()).then_some(case.fields.artist.as_str()),
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

/// What the corpus tests and the copies for other tools save: the fields the iPod's database gives
/// a copy (A4), and a cover.
fn tagging() -> Edit {
    let mut edit = Edit::all(&Fields {
        title: "Saved by jackbird".into(),
        artist: "An Artist".into(),
        album: "An Album".into(),
        year: "2001-05-04T07:00:00Z".into(),
        genre: "Rock".into(),
        track: "3/12".into(),
        disc: "1/2".into(),
        album_artist: "An Artist".into(),
        ..Fields::default()
    });
    edit.cover = CoverEdit::Set(Cover {
        data: fs::read(root().join("covers/cover1.jpg")).unwrap(),
        mime: "image/jpeg".into(),
    });
    edit
}

/// Writes each fixture saved with [`tagging`] into `JACKBIRD_M4A_OUT`, for other tools to read and
/// play (`afinfo`, `ffprobe`, `ffmpeg`): `cargo test -p jackbird-tags --test fixtures_m4a
/// saved_copies -- --ignored`.
#[test]
#[ignore = "writes into a folder given by JACKBIRD_M4A_OUT"]
fn saved_copies_for_other_tools() {
    let folder = PathBuf::from(std::env::var("JACKBIRD_M4A_OUT").expect("JACKBIRD_M4A_OUT: a folder"));
    for case in cases() {
        fs::write(folder.join(format!("{}.m4a", case.name)), saved(&case, &tagging())).unwrap();
    }
}

/// Saves [`tagging`] into every `.m4a` under `JACKBIRD_M4A_CORPUS` as the apps do, from its head
/// alone (the safeguards run on each), and reads the new head back; the first
/// `JACKBIRD_M4A_COPIES` (default 0) are written whole into `JACKBIRD_M4A_OUT`, for other tools.
/// The files themselves are only read. `cargo test -p jackbird-tags --test fixtures_m4a
/// a_corpus_of_m4a_files_saves -- --ignored --nocapture`.
#[test]
#[ignore = "reads a folder given by JACKBIRD_M4A_CORPUS"]
fn a_corpus_of_m4a_files_saves() {
    let folder = std::env::var("JACKBIRD_M4A_CORPUS").expect("JACKBIRD_M4A_CORPUS: a folder of .m4a files");
    let copies: usize = std::env::var("JACKBIRD_M4A_COPIES")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    let out_folder = std::env::var("JACKBIRD_M4A_OUT").ok().map(PathBuf::from);
    let mut files = Vec::new();
    m4a_files(Path::new(&folder), &mut files);
    let edit = tagging();
    let (mut in_place, mut moved, mut written) = (0, 0, 0);
    let mut failures = Vec::new();
    for path in &files {
        let len = fs::metadata(path).unwrap().len();
        let tail = tail_of_file(path, len, TAIL_LEN as u64);
        let outcome = (|| -> Result<(), String> {
            let mut head = head_of(path, (FIRST_HEAD as u64).min(len));
            let layout = loop {
                match layout(&head, &tail, len).map_err(|error| error.to_string())? {
                    Layout::Known(found) => break found,
                    Layout::NeedHead(n) => head = head_of(path, n),
                }
            };
            let head = &head[..layout.tags_end as usize];
            let splice = write_head(head, &layout, &edit).map_err(|error| error.to_string())?;
            if splice.with.len() == head.len() {
                in_place += 1;
            } else {
                moved += 1;
            }
            let back = read(&splice.with).map_err(|error| error.to_string())?;
            if back.fields.title != "Saved by jackbird" || back.cover.is_none() {
                return Err("the new head does not read back".into());
            }
            if let Some(out) = out_folder.as_ref().filter(|_| written < copies) {
                let whole = fs::read(path).map_err(|error| error.to_string())?;
                let mut file = splice.with.clone();
                file.extend_from_slice(&whole[splice.replace.end as usize..]);
                if write(&whole, &edit).map_err(|error| error.to_string())? != file {
                    return Err("the whole file's save differs from the head's".into());
                }
                let name = path.file_name().unwrap();
                fs::write(out.join(name), &file).map_err(|error| error.to_string())?;
                written += 1;
            }
            Ok(())
        })();
        if let Err(why) = outcome {
            failures.push(format!("{}: {why}", path.display()));
        }
    }
    println!(
        "{} files saved in memory: {in_place} in their own room, {moved} with the audio moved; {written} written whole",
        files.len()
    );
    assert!(
        failures.is_empty(),
        "{} failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
