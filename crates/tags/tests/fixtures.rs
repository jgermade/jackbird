//! The shared fixtures (`fixtures/tags/`, made by `make.mjs`): what reading
//! each gives, its audio region, and edits on each, every one passing the
//! safeguards; then lofty and rust-id3 read what was written.

use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use jackbird_tags::{
    Cover, CoverEdit, Edit, FIRST_HEAD, Fields, FileLayout, Format, Layout, TAIL_LEN, audio_region, format_of, layout,
    read, read_head, write, write_head,
};
use serde_json::Value;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tags")
}

struct Case {
    name: String,
    bytes: Vec<u8>,
    format: Format,
    fields: Fields,
    cover: Option<Cover>,
    region: (usize, usize),
    write: String,
}

fn cases() -> Vec<Case> {
    let json: Value = serde_json::from_str(&fs::read_to_string(root().join("cases.json")).unwrap()).unwrap();
    json["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            let text = |key: &str| case["fields"][key].as_str().unwrap().to_owned();
            Case {
                name: case["name"].as_str().unwrap().to_owned(),
                bytes: fs::read(root().join(case["file"].as_str().unwrap())).unwrap(),
                format: if case["format"] == "mp3" {
                    Format::Mp3
                } else {
                    Format::Flac
                },
                fields: Fields {
                    title: text("title"),
                    artist: text("artist"),
                    album: text("album"),
                    year: text("year"),
                    genre: text("genre"),
                    track: text("track"),
                    disc: text("disc"),
                    album_artist: text("albumArtist"),
                    compilation: text("compilation"),
                },
                cover: case["cover"].as_object().map(|cover| Cover {
                    data: fs::read(root().join(cover["file"].as_str().unwrap())).unwrap(),
                    mime: cover["mime"].as_str().unwrap().to_owned(),
                }),
                region: (
                    case["region"]["start"].as_u64().unwrap() as usize,
                    case["region"]["end"].as_u64().unwrap() as usize,
                ),
                write: case["write"].as_str().unwrap().to_owned(),
            }
        })
        .collect()
}

fn writable() -> Vec<Case> {
    cases().into_iter().filter(|case| case.write == "ok").collect()
}

fn new_cover() -> Cover {
    Cover {
        data: fs::read(root().join("covers/cover9.jpg")).unwrap(),
        mime: "image/jpeg".into(),
    }
}

fn title(value: &str) -> Edit {
    Edit {
        title: Some(value.into()),
        ..Edit::default()
    }
}

#[test]
fn every_case_reads_as_cases_json_says() {
    let cases = cases();
    assert_eq!(cases.len(), 26);
    for case in &cases {
        assert_eq!(format_of(&case.bytes), Some(case.format), "{}", case.name);
        let tags = read(&case.bytes).unwrap_or_else(|error| panic!("{}: {error}", case.name));
        assert_eq!(tags.format, case.format, "{}", case.name);
        assert_eq!(tags.fields, case.fields, "{}", case.name);
        assert_eq!(tags.cover, case.cover, "{}", case.name);
    }
}

#[test]
fn every_audio_region_is_where_the_file_was_built_to_have_it() {
    for case in cases() {
        assert_eq!(audio_region(&case.bytes), case.region.0..case.region.1, "{}", case.name);
    }
}

#[test]
fn a_new_title_saves_or_is_refused_as_cases_json_says() {
    for case in cases() {
        match write(&case.bytes, &title("After")) {
            Ok(out) => {
                assert_eq!(case.write, "ok", "{}", case.name);
                let back = read(&out).unwrap();
                assert_eq!(
                    back.fields,
                    Fields {
                        title: "After".into(),
                        ..case.fields.clone()
                    },
                    "{}",
                    case.name
                );
                assert_eq!(back.cover, case.cover, "{}", case.name);
            }
            Err(error) => assert_eq!(error.code(), case.write, "{}: {error}", case.name),
        }
    }
}

#[test]
fn a_title_that_fits_leaves_the_audio_where_it_was() {
    // Every tagged case but flac-no-padding, whose metadata shrinks by a byte: too little to hold a padding block.
    for case in writable() {
        if ["mp3-no-tag", "flac-no-padding", "mp3-saved-by-jackbird"].contains(&case.name.as_str()) {
            continue;
        }
        let out = write(&case.bytes, &title("After")).unwrap();
        assert_eq!(audio_region(&out).start, case.region.0, "{}", case.name);
        assert_eq!(out.len(), case.bytes.len(), "{}", case.name);
    }
}

#[test]
fn every_field_at_once() {
    let wanted = Fields {
        title: "Título nuevo".into(),
        artist: "東京 Ensemble".into(),
        album: "Album II".into(),
        year: "2001-05-06".into(),
        genre: "Post-Rock".into(),
        track: "4/9".into(),
        disc: "2/3".into(),
        album_artist: "Various Artists".into(),
        compilation: "1".into(),
    };
    for case in writable() {
        let out = write(&case.bytes, &Edit::all(&wanted)).unwrap_or_else(|error| panic!("{}: {error}", case.name));
        assert_eq!(read(&out).unwrap().fields, wanted, "{}", case.name);
        // The same edit again changes nothing, and the result does not depend on the run.
        assert_eq!(write(&out, &Edit::all(&wanted)).unwrap(), out, "{}", case.name);
        assert_eq!(write(&case.bytes, &Edit::all(&wanted)).unwrap(), out, "{}", case.name);
    }
}

#[test]
fn emptied_fields_go() {
    let edit = Edit {
        artist: Some(String::new()),
        genre: Some(String::new()),
        year: Some(String::new()),
        track: Some(String::new()),
        ..Edit::default()
    };
    for case in writable() {
        let out = write(&case.bytes, &edit).unwrap_or_else(|error| panic!("{}: {error}", case.name));
        let back = read(&out).unwrap().fields;
        assert_eq!(
            (
                back.artist.as_str(),
                back.genre.as_str(),
                back.year.as_str(),
                back.track.as_str()
            ),
            ("", "", "", ""),
            "{}",
            case.name
        );
        assert_eq!(
            (back.title, back.album),
            (case.fields.title.clone(), case.fields.album.clone()),
            "{}",
            case.name
        );
    }
}

#[test]
fn a_new_cover_replaces_the_one_shown() {
    for case in writable() {
        let edit = Edit {
            cover: CoverEdit::Set(new_cover()),
            ..Edit::default()
        };
        let out = write(&case.bytes, &edit).unwrap_or_else(|error| panic!("{}: {error}", case.name));
        let back = read(&out).unwrap();
        assert_eq!(back.cover, Some(new_cover()), "{}", case.name);
        assert_eq!(back.fields, case.fields, "{}", case.name);
    }
}

/// How many pictures a file holds, counted by the format crates.
fn pictures_in(bytes: &[u8]) -> usize {
    match format_of(bytes) {
        Some(Format::Flac) => jackbird_flac::read(bytes)
            .unwrap()
            .blocks
            .iter()
            .filter(|block| block.kind == jackbird_flac::PICTURE)
            .count(),
        _ => jackbird_id3::read(bytes).unwrap().map_or(0, |tag| {
            tag.frames
                .iter()
                .filter(|frame| frame.id == "APIC" || frame.id == "PIC")
                .count()
        }),
    }
}

#[test]
fn removing_the_cover_takes_out_the_picture_shown_and_keeps_the_rest() {
    for case in writable() {
        let remove = Edit {
            cover: CoverEdit::Remove,
            ..Edit::default()
        };
        // Removed one by one, each picture goes, and the fields and the audio stay.
        let mut bytes = case.bytes.clone();
        let mut removed = 0;
        while let Some(shown) = read(&bytes).unwrap().cover {
            let out = write(&bytes, &remove).unwrap_or_else(|error| panic!("{}: {error}", case.name));
            let back = read(&out).unwrap();
            assert_eq!(back.fields, case.fields, "{}", case.name);
            assert_eq!(
                &out[audio_region(&out)],
                &case.bytes[audio_region(&case.bytes)],
                "{}",
                case.name
            );
            assert!(out.len() <= bytes.len() || shown.data.is_empty(), "{}", case.name);
            bytes = out;
            removed += 1;
            assert!(removed <= 4, "{}: the cover does not go", case.name);
        }
        assert_eq!(removed, pictures_in(&case.bytes), "{}", case.name);
        // Nothing to remove: the same bytes.
        assert_eq!(write(&bytes, &remove).unwrap(), bytes, "{}", case.name);
    }
}

#[test]
fn an_edit_that_changes_nothing_gives_the_same_bytes() {
    for case in cases() {
        assert_eq!(
            write(&case.bytes, &Edit::default()).ok(),
            (case.write == "ok" || case.format == Format::Mp3).then(|| case.bytes.clone()),
            "{}",
            case.name
        );
        let same = Edit {
            cover: case.cover.clone().map_or(CoverEdit::Remove, CoverEdit::Set),
            ..Edit::all(&case.fields)
        };
        assert_eq!(write(&case.bytes, &same).unwrap(), case.bytes, "{}", case.name);
    }
}

#[test]
fn years_are_written_as_dates_or_refused() {
    let v23 = cases().into_iter().find(|case| case.name == "mp3-v23-padded").unwrap();
    let v24 = cases().into_iter().find(|case| case.name == "mp3-v24-padded").unwrap();
    let flac = cases().into_iter().find(|case| case.name == "flac-full").unwrap();
    let year = |value: &str| Edit {
        year: Some(value.into()),
        ..Edit::default()
    };
    let back = |bytes: &[u8]| read(bytes).unwrap().fields.year;

    assert_eq!(back(&write(&v23.bytes, &year("2001")).unwrap()), "2001");
    assert_eq!(back(&write(&v23.bytes, &year("2001-05-06")).unwrap()), "2001-05-06");
    assert_eq!(back(&write(&v24.bytes, &year("2001-05")).unwrap()), "2001-05");
    assert_eq!(
        back(&write(&v24.bytes, &year("2001-05-06T07:08")).unwrap()),
        "2001-05-06T07:08"
    );
    for (case, value) in [
        (&v23, "2001-05"),
        (&v23, "2001-05-06T07:08"),
        (&v24, "c. 1960"),
        (&v24, "59"),
        (&v24, "2001-13"),
        (&v24, "2001-05-06T25"),
    ] {
        assert_eq!(
            write(&case.bytes, &year(value)).unwrap_err().code(),
            "invalid-year",
            "{} {value}",
            case.name
        );
    }
    // FLAC's DATE is free text.
    assert_eq!(back(&write(&flac.bytes, &year("c. 1960")).unwrap()), "c. 1960");
    // A year that is not a date is kept when another field changes.
    let odd = cases().into_iter().find(|case| case.name == "mp3-odd-years").unwrap();
    assert_eq!(back(&write(&odd.bytes, &title("New")).unwrap()), "c. 1959");
}

#[test]
fn flac_track_numbers_split_into_number_and_total() {
    let full = cases().into_iter().find(|case| case.name == "flac-full").unwrap();
    let totals = cases()
        .into_iter()
        .find(|case| case.name == "flac-track-total")
        .unwrap();
    let track = |value: &str| Edit {
        track: Some(value.into()),
        ..Edit::default()
    };
    let entries = |bytes: &[u8]| -> Vec<String> {
        let metadata = jackbird_flac::read(bytes).unwrap();
        let block = metadata
            .blocks
            .iter()
            .find(|block| block.kind == jackbird_flac::VORBIS_COMMENT)
            .unwrap();
        jackbird_flac::Comments::parse(&block.body)
            .unwrap()
            .entries
            .iter()
            .map(|entry| String::from_utf8_lossy(entry).into_owned())
            .collect()
    };
    let out = write(&full.bytes, &track("4/9")).unwrap();
    assert!(entries(&out).contains(&"TRACKNUMBER=4".to_owned()) && entries(&out).contains(&"TRACKTOTAL=9".to_owned()));
    let out = write(&totals.bytes, &track("5/12")).unwrap();
    assert!(
        entries(&out).contains(&"TOTALTRACKS=12".to_owned())
            && !entries(&out).iter().any(|entry| entry.starts_with("TRACKTOTAL"))
    );
    let out = write(&totals.bytes, &track("5")).unwrap();
    assert!(!entries(&out).iter().any(|entry| entry.starts_with("TOTALTRACKS")));
    assert_eq!(read(&out).unwrap().fields.track, "5");
}

#[test]
fn what_is_not_mp3_or_flac_is_refused() {
    for bytes in [&b"OggS\0\x02 not this"[..], b"", b"plain text, no audio"] {
        assert_eq!(format_of(bytes), None);
        assert_eq!(read(bytes).unwrap_err().code(), "not-supported");
        assert_eq!(write(bytes, &title("x")).unwrap_err().code(), "not-supported");
    }
}

// ---------------------------------------------------------------- other readers

/// Cases another library reads differently by design: lofty cannot read a
/// file whose year is "c. 1959", and keeps the later of two TIT2 frames
/// where jackbird (and the TypeScript reader before it) shows the first.
const OUTSIDE_SKIPS: [&str; 2] = ["mp3-odd-years", "mp3-duplicates"];

#[test]
fn lofty_reads_what_jackbird_writes() {
    use lofty::prelude::*;
    let wanted = Fields {
        title: "Título".into(),
        artist: "Artist B".into(),
        album: "Album B".into(),
        year: "2002".into(),
        genre: "Rock".into(),
        track: "2/3".into(),
        ..Fields::default()
    };
    for case in writable() {
        if OUTSIDE_SKIPS.contains(&case.name.as_str()) {
            continue;
        }
        let out = write(
            &case.bytes,
            &Edit {
                cover: CoverEdit::Set(new_cover()),
                ..Edit::all(&wanted)
            },
        )
        .unwrap();
        let tagged = lofty::probe::Probe::new(Cursor::new(&out))
            .guess_file_type()
            .unwrap()
            .read()
            .unwrap_or_else(|error| panic!("{}: {error}", case.name));
        let tag = tagged.primary_tag().unwrap_or_else(|| panic!("{}: no tag", case.name));
        assert_eq!(tag.title().as_deref(), Some("Título"), "{}", case.name);
        assert_eq!(tag.artist().as_deref(), Some("Artist B"), "{}", case.name);
        assert_eq!(tag.album().as_deref(), Some("Album B"), "{}", case.name);
        assert_eq!(tag.genre().as_deref(), Some("Rock"), "{}", case.name);
        assert_eq!(tag.track(), Some(2), "{}", case.name);
        assert_eq!(tag.date().map(|date| date.year), Some(2002), "{}", case.name);
        let front = tag
            .pictures()
            .iter()
            .find(|picture| picture.pic_type() == lofty::picture::PictureType::CoverFront)
            .unwrap();
        assert_eq!(front.data(), new_cover().data, "{}", case.name);
    }
}

#[test]
fn rust_id3_reads_the_mp3s_jackbird_writes() {
    use id3::TagLike;
    let wanted = Fields {
        title: "Título".into(),
        artist: "Artist B".into(),
        album: "Album B".into(),
        year: "2002".into(),
        genre: "Rock".into(),
        track: "2/3".into(),
        ..Fields::default()
    };
    for case in writable().into_iter().filter(|case| case.format == Format::Mp3) {
        // rust-id3 refuses a tag with a grouped frame ("grouping identity is not supported"), which that case keeps.
        if OUTSIDE_SKIPS.contains(&case.name.as_str()) || case.name == "mp3-v24-frame-flags" {
            continue;
        }
        let out = write(
            &case.bytes,
            &Edit {
                cover: CoverEdit::Set(new_cover()),
                ..Edit::all(&wanted)
            },
        )
        .unwrap();
        let tag = id3::Tag::read_from2(Cursor::new(&out)).unwrap_or_else(|error| panic!("{}: {error}", case.name));
        assert_eq!(tag.title(), Some("Título"), "{}", case.name);
        assert_eq!(tag.artist(), Some("Artist B"), "{}", case.name);
        assert_eq!(tag.album(), Some("Album B"), "{}", case.name);
        assert_eq!(tag.track(), Some(2), "{}", case.name);
        assert_eq!(tag.total_tracks(), Some(3), "{}", case.name);
        let pictures: Vec<_> = tag
            .pictures()
            .map(|picture| (picture.picture_type, picture.mime_type.clone(), picture.data.len()))
            .collect();
        let front = tag
            .pictures()
            .find(|picture| picture.picture_type == id3::frame::PictureType::CoverFront);
        assert_eq!(
            front.map(|picture| &picture.data),
            Some(&new_cover().data),
            "{}: {pictures:?}",
            case.name
        );
    }
}

// ---------------------------------------------------------------- by head and splice

fn tail_of(bytes: &[u8]) -> &[u8] {
    &bytes[bytes.len().saturating_sub(TAIL_LEN)..]
}

/// The layout as an app finds it: the first head, then what it asks for. Gives the layout and how
/// many heads it took.
fn found(bytes: &[u8]) -> (FileLayout, usize) {
    let mut given = FIRST_HEAD.min(bytes.len());
    for steps in 1..=4 {
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
    panic!("no layout in four steps");
}

/// Where each fixture's tags end, from its own format's reader.
fn tags_end(case: &Case) -> u64 {
    match case.format {
        Format::Flac => jackbird_flac::read(&case.bytes).unwrap().audio as u64,
        Format::Mp3 => match jackbird_id3::read(&case.bytes) {
            Ok(Some(tag)) => tag.len as u64,
            _ => {
                if case.bytes.starts_with(b"ID3") {
                    case.bytes.len() as u64
                } else {
                    0
                }
            }
        },
    }
}

#[test]
fn layout_gives_each_fixtures_format_tags_and_region() {
    for case in cases() {
        let (layout, steps) = found(&case.bytes);
        assert_eq!(layout.format, Some(case.format), "{}", case.name);
        assert_eq!(layout.tags_end, tags_end(&case), "{}", case.name);
        assert_eq!(
            layout.audio,
            case.region.0 as u64..case.region.1 as u64,
            "{}",
            case.name
        );
        assert_eq!(steps, 1, "{}: the fixtures fit the first head", case.name);
        let tags = read_head(&case.bytes[..layout.tags_end as usize], &layout);
        assert_eq!(tags, read(&case.bytes), "{}", case.name);
    }
}

#[test]
fn layout_from_any_head_asks_for_more_or_knows_the_same() {
    for case in cases() {
        let (whole, _) = found(&case.bytes);
        let len = case.bytes.len();
        for given in 0..=len {
            let mut at = given;
            // From any head, following what it asks for ends at the same layout.
            loop {
                match layout(&case.bytes[..at], tail_of(&case.bytes), len as u64).unwrap() {
                    Layout::Known(found) => {
                        assert_eq!(found, whole, "{} from {given}", case.name);
                        break;
                    }
                    Layout::NeedHead(n) => {
                        assert!(
                            n as usize > at && n as usize <= len,
                            "{} from {given}: {n} at {at}",
                            case.name
                        );
                        at = n as usize;
                    }
                }
            }
        }
    }
}

#[test]
fn the_head_and_splice_path_gives_the_whole_files_bytes() {
    let edits = [
        Edit {
            title: Some("New title".into()),
            ..Edit::default()
        },
        Edit {
            cover: CoverEdit::Set(new_cover()),
            ..Edit::all(&Fields {
                title: "Título".into(),
                artist: "Artist B".into(),
                album: "Album B".into(),
                year: "2002".into(),
                genre: "Rock".into(),
                track: "2/3".into(),
                ..Fields::default()
            })
        },
        Edit {
            cover: CoverEdit::Remove,
            ..Edit::default()
        },
        Edit {
            artist: Some(String::new()),
            genre: Some(String::new()),
            ..Edit::default()
        },
        Edit::default(),
    ];
    for case in cases() {
        let (layout, _) = found(&case.bytes);
        let end = layout.tags_end as usize;
        for edit in &edits {
            // Only the tags are given: nothing after them is needed.
            let by_head = write_head(&case.bytes[..end], &layout, edit).map(|splice| {
                assert_eq!(splice.replace, 0..layout.tags_end, "{}", case.name);
                let mut out = splice.with;
                out.extend_from_slice(&case.bytes[end..]);
                out
            });
            assert_eq!(by_head, write(&case.bytes, edit), "{}: {edit:?}", case.name);
        }
    }
}
