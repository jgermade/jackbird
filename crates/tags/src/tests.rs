//! The cases of `keepUneditedFrames` (`src/helpers/id3v2.test.ts`), each
//! safeguard refusing a tampered result, the year, the audio region, errors.

use jackbird_id3::{self as id3, Frame, Version};

use crate::*;

const AUDIO: [u8; 8] = [0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4];

fn text(id: &str, value: &str) -> Frame {
    let mut body = vec![0];
    body.extend(value.bytes());
    Frame::new(id, body)
}

fn flagged(mut frame: Frame, flags: [u8; 2]) -> Frame {
    frame.flags = flags;
    frame
}

fn picture(kind: u8, data: &str) -> Frame {
    let mut body = vec![0];
    body.extend(b"image/jpeg\0");
    body.extend([kind, 0]);
    body.extend(data.bytes());
    Frame::new("APIC", body)
}

fn file(version: Version, frames: &[Frame]) -> Vec<u8> {
    let mut out = id3::write(version, 0, frames, 64).unwrap();
    out.extend_from_slice(&AUDIO);
    out
}

fn frames_of(bytes: &[u8]) -> Vec<Frame> {
    id3::read(bytes).unwrap().unwrap().frames
}

fn ids(bytes: &[u8]) -> Vec<String> {
    frames_of(bytes).into_iter().map(|frame| frame.id).collect()
}

fn cover(data: &str) -> Cover {
    Cover {
        data: data.as_bytes().to_vec(),
        mime: "image/jpeg".into(),
    }
}

// ---------------------------------------------------------------- keepUneditedFrames' cases

#[test]
fn keeps_every_frame_the_editor_does_not_manage_untouched_and_in_order() {
    let comm = Frame::new("COMM", vec![0, b'e', b'n', b'g', 0, 1, 2]);
    let source = file(
        Version::V23,
        &[
            text("TIT2", "Before"),
            text("TPOS", "2/2"),
            text("TCON", "Jazz"),
            text("TPE2", "Album Artist"),
            comm.clone(),
        ],
    );
    let edit = Edit {
        title: Some("After".into()),
        artist: Some("Artist".into()),
        year: Some("2020".into()),
        cover: CoverEdit::Set(cover("new")),
        ..Edit::default()
    };
    let out = write(&source, &edit).unwrap();
    // Edited frames in place, new ones after the rest: unlike browser-id3-writer, nothing moves.
    assert_eq!(
        ids(&out),
        ["TIT2", "TPOS", "TCON", "TPE2", "COMM", "TPE1", "TYER", "APIC"]
    );
    let frames = frames_of(&out);
    assert_eq!(frames[1], text("TPOS", "2/2"));
    assert_eq!(frames[3], text("TPE2", "Album Artist"));
    assert_eq!(frames[4], comm);
    assert_eq!(read(&out).unwrap().fields.title, "After");
}

#[test]
fn keeps_the_audio_after_the_tag() {
    let out = write(
        &file(Version::V23, &[text("TPOS", "1/1")]),
        &Edit {
            title: Some("After".into()),
            ..Edit::default()
        },
    )
    .unwrap();
    assert_eq!(&out[audio_region(&out)], AUDIO);
}

#[test]
fn replaces_the_picture_shown_and_keeps_the_others() {
    let source = file(Version::V23, &[picture(0, "other"), picture(4, "back")]);
    assert_eq!(read(&source).unwrap().cover, Some(cover("other")));
    let out = write(
        &source,
        &Edit {
            cover: CoverEdit::Set(cover("new")),
            ..Edit::default()
        },
    )
    .unwrap();
    let pictures: Vec<Frame> = frames_of(&out).into_iter().filter(|frame| frame.id == "APIC").collect();
    assert_eq!(pictures, [picture(3, "new"), picture(4, "back")]);
    // A front cover is the one shown, wherever it is.
    let source = file(Version::V23, &[picture(4, "back"), picture(3, "front")]);
    let out = write(
        &source,
        &Edit {
            cover: CoverEdit::Set(cover("new")),
            ..Edit::default()
        },
    )
    .unwrap();
    let pictures: Vec<Frame> = frames_of(&out).into_iter().filter(|frame| frame.id == "APIC").collect();
    assert_eq!(pictures, [picture(4, "back"), picture(3, "new")]);
}

#[test]
fn removes_the_picture_shown_and_keeps_the_others() {
    let source = file(
        Version::V23,
        &[
            text("TIT2", "Title"),
            picture(4, "back"),
            picture(3, "front"),
            picture(0, "other"),
        ],
    );
    let remove = Edit {
        cover: CoverEdit::Remove,
        ..Edit::default()
    };
    let out = write(&source, &remove).unwrap();
    let pictures: Vec<Frame> = frames_of(&out).into_iter().filter(|frame| frame.id == "APIC").collect();
    assert_eq!(pictures, [picture(4, "back"), picture(0, "other")]);
    let back = read(&out).unwrap();
    assert_eq!(back.cover, Some(cover("back")));
    assert_eq!(back.fields.title, "Title");
    // The only picture: no cover is shown after.
    let source = file(Version::V24, &[text("TIT2", "Title"), picture(3, "front")]);
    let out = write(&source, &remove).unwrap();
    assert_eq!(ids(&out), ["TIT2"]);
    assert_eq!(read(&out).unwrap().cover, None);
    // No picture: the same bytes.
    let source = file(Version::V23, &[text("TIT2", "Title")]);
    assert_eq!(write(&source, &remove).unwrap(), source);
}

#[test]
fn safeguard_3_refuses_a_removal_that_took_another_picture() {
    let source = file(Version::V23, &[picture(3, "front"), picture(4, "back")]);
    let wrong = file(Version::V23, &[picture(3, "front")]);
    let change = Change {
        changes: &[],
        cover: Some(CoverChange::Remove),
        fields: &Fields::default(),
        shown_cover: None,
    };
    assert_eq!(
        verify(Format::Mp3, &source, &wrong, &change).unwrap_err(),
        Error::Refused(Refusal::Kept("a picture".into()))
    );
    let right = file(Version::V23, &[picture(4, "back")]);
    assert!(verify(Format::Mp3, &source, &right, &change).is_ok());
}

#[test]
fn writes_in_a_v24_originals_version_the_year_as_tdrc_in_place() {
    let source = file(Version::V24, &[text("TDRC", "1959"), text("TSOP", "Davis, Miles")]);
    let out = write(
        &source,
        &Edit {
            year: Some("2020".into()),
            title: Some("After".into()),
            ..Edit::default()
        },
    )
    .unwrap();
    assert_eq!(id3::read(&out).unwrap().unwrap().version, Version::V24);
    assert_eq!(ids(&out), ["TDRC", "TSOP", "TIT2"]);
    assert_eq!(read(&out).unwrap().fields.year, "2020");
}

#[test]
fn drops_a_frame_flagged_to_be_discarded_when_the_tag_is_altered() {
    let v3 = file(
        Version::V23,
        &[flagged(text("TCOM", "1/2"), [0x80, 0]), text("TPE2", "Kept")],
    );
    let out = write(
        &v3,
        &Edit {
            title: Some("x".into()),
            ..Edit::default()
        },
    )
    .unwrap();
    assert_eq!(ids(&out), ["TPE2", "TIT2"]);
    let v4 = file(
        Version::V24,
        &[flagged(text("TCOM", "1/2"), [0x40, 0]), text("TPE2", "Kept")],
    );
    let out = write(
        &v4,
        &Edit {
            title: Some("x".into()),
            ..Edit::default()
        },
    )
    .unwrap();
    assert_eq!(ids(&out), ["TPE2", "TIT2"]);
    // Nothing changed, nothing altered: it stays.
    assert_eq!(write(&v4, &Edit::default()).unwrap(), v4);
}

#[test]
fn a_file_without_a_tag_gets_a_v23_one() {
    let out = write(
        &AUDIO,
        &Edit {
            title: Some("Fresh".into()),
            ..Edit::default()
        },
    )
    .unwrap();
    let tag = id3::read(&out).unwrap().unwrap();
    assert_eq!((tag.version, tag.padding), (Version::V23, 1024));
    assert_eq!(&out[tag.len..], AUDIO);
}

// ---------------------------------------------------------------- more of the writer

#[test]
fn a_v24_tag_unsynchronised_as_a_whole_gets_unsynchronised_frames() {
    let mut source = file(
        Version::V24,
        &[
            text("TIT2", "Old"),
            Frame::new("PRIV", id3::unsynchronise(&[0xff, 0xe0])),
        ],
    );
    source[5] = 0x80;
    let out = write(
        &source,
        &Edit {
            title: Some("Ÿà".into()),
            ..Edit::default()
        },
    )
    .unwrap();
    assert_eq!(out[5], 0x80);
    assert_eq!(read(&out).unwrap().fields.title, "Ÿà");
    assert_eq!(frames_of(&out)[0].flags, [0, 0x02]);
}

#[test]
fn text_that_latin1_cannot_hold_is_utf16_in_v23_and_utf8_in_v24() {
    for (version, encoding) in [(Version::V23, 1), (Version::V24, 3)] {
        let out = write(
            &file(version, &[]),
            &Edit {
                title: Some("東京".into()),
                ..Edit::default()
            },
        )
        .unwrap();
        assert_eq!(frames_of(&out)[0].body[0], encoding);
        assert_eq!(read(&out).unwrap().fields.title, "東京");
    }
    let out = write(
        &file(Version::V23, &[]),
        &Edit {
            title: Some("Café".into()),
            ..Edit::default()
        },
    )
    .unwrap();
    assert_eq!(frames_of(&out)[0].body, b"\0Caf\xe9");
}

#[test]
fn a_v23_date_goes_to_tyer_and_tdat_and_an_old_time_goes() {
    let source = file(
        Version::V23,
        &[
            text("TYER", "1959"),
            text("TDAT", "0203"),
            text("TIME", "1200"),
            text("TIT2", "x"),
        ],
    );
    assert_eq!(read(&source).unwrap().fields.year, "1959-03-02");
    let out = write(
        &source,
        &Edit {
            year: Some("2001-05-06".into()),
            ..Edit::default()
        },
    )
    .unwrap();
    assert_eq!(ids(&out), ["TYER", "TDAT", "TIT2"]);
    assert_eq!(frames_of(&out)[1], text("TDAT", "0605"));
    let out = write(
        &source,
        &Edit {
            year: Some("2001".into()),
            ..Edit::default()
        },
    )
    .unwrap();
    assert_eq!(ids(&out), ["TYER", "TIT2"]);
    // A TDAT that is not a date is not read as one.
    assert_eq!(
        read(&file(Version::V23, &[text("TYER", "1959"), text("TDAT", "9999")]))
            .unwrap()
            .fields
            .year,
        "1959"
    );
}

#[test]
fn a_tag_that_does_not_read_cleanly_is_refused() {
    let mut broken = file(Version::V23, &[text("TIT2", "x")]);
    broken[10 + 11 + 3] = 7; // junk in the padding
    assert_eq!(read(&broken).unwrap().fields.title, "x");
    assert_eq!(
        write(
            &broken,
            &Edit {
                title: Some("y".into()),
                ..Edit::default()
            }
        )
        .unwrap_err()
        .code(),
        "unreadable"
    );
    let truncated = b"ID3\x03\x00\x00\x00\x00\x7f\x7f\xff\xfb";
    assert_eq!(read(truncated).unwrap().fields, Fields::default());
    assert_eq!(
        write(
            truncated,
            &Edit {
                title: Some("y".into()),
                ..Edit::default()
            }
        )
        .unwrap_err()
        .code(),
        "unreadable"
    );
}

#[test]
fn a_flac_with_comments_it_cannot_read_is_refused() {
    let streaminfo = jackbird_flac::Block {
        kind: 0,
        body: vec![0; 34],
    };
    let broken = jackbird_flac::Block {
        kind: 4,
        body: vec![200, 0, 0, 0, 1],
    };
    let mut bytes = jackbird_flac::write(&[streaminfo.clone(), broken]).unwrap();
    bytes.extend_from_slice(&[0xff, 0xf8, 1, 2]);
    assert_eq!(read(&bytes).unwrap().fields, Fields::default());
    assert_eq!(
        write(
            &bytes,
            &Edit {
                title: Some("y".into()),
                ..Edit::default()
            }
        )
        .unwrap_err()
        .code(),
        "unreadable"
    );
    // A picture larger than a block can hold.
    let mut fine = jackbird_flac::write(&[streaminfo]).unwrap();
    fine.extend_from_slice(&[0xff, 0xf8, 1, 2]);
    let huge = Cover {
        data: vec![0; jackbird_flac::BLOCK_MAX],
        mime: "image/jpeg".into(),
    };
    assert_eq!(
        write(
            &fine,
            &Edit {
                cover: CoverEdit::Set(huge),
                ..Edit::default()
            }
        )
        .unwrap_err()
        .code(),
        "too-large"
    );
    // And a broken FLAC reads as unreadable.
    assert_eq!(read(b"fLaC\x00\x00").unwrap_err().code(), "unreadable");
}

#[test]
fn an_id3v22_tag_is_read_but_not_written() {
    let mut tag = b"ID3\x02\x00\x00\x00\x00\x00\x0a".to_vec();
    tag.extend(b"TT2\x00\x00\x04\x00Old");
    tag.extend_from_slice(&AUDIO);
    assert_eq!(read(&tag).unwrap().fields.title, "Old");
    assert_eq!(
        write(
            &tag,
            &Edit {
                title: Some("New".into()),
                ..Edit::default()
            }
        )
        .unwrap_err(),
        Error::Id3v22
    );
}

// ---------------------------------------------------------------- the safeguards refuse

fn change<'a>(changes: &'a [(Field, String)], fields: &'a Fields, shown: Option<&'a Cover>) -> Change<'a> {
    Change {
        changes,
        cover: None,
        fields,
        shown_cover: shown,
    }
}

#[test]
fn safeguard_1_refuses_a_result_that_reads_otherwise() {
    let source = file(Version::V23, &[text("TIT2", "Before")]);
    let changes = [(Field::Title, "After".to_owned())];
    let fields = Fields {
        title: "After".into(),
        ..Fields::default()
    };
    // The unchanged source as the "result": it reads "Before".
    let error = verify(Format::Mp3, &source, &source, &change(&changes, &fields, None)).unwrap_err();
    assert_eq!(error.code(), "refused-fields");
    let out = write(
        &source,
        &Edit {
            title: Some("After".into()),
            ..Edit::default()
        },
    )
    .unwrap();
    let error = verify(
        Format::Mp3,
        &source,
        &out,
        &change(&changes, &fields, Some(&cover("x"))),
    )
    .unwrap_err();
    assert_eq!(error.code(), "refused-fields");
    assert!(verify(Format::Mp3, &source, &out, &change(&changes, &fields, None)).is_ok());
}

#[test]
fn safeguard_2_refuses_a_result_whose_audio_changed() {
    let source = file(Version::V23, &[text("TIT2", "Before")]);
    let out = write(
        &source,
        &Edit {
            title: Some("After".into()),
            ..Edit::default()
        },
    )
    .unwrap();
    let changes = [(Field::Title, "After".to_owned())];
    let fields = Fields {
        title: "After".into(),
        ..Fields::default()
    };
    let mut tampered = out.clone();
    *tampered.last_mut().unwrap() ^= 1;
    assert_eq!(
        verify(Format::Mp3, &source, &tampered, &change(&changes, &fields, None)).unwrap_err(),
        Error::Refused(Refusal::Audio)
    );
    let mut longer = out.clone();
    longer.push(0);
    assert_eq!(
        verify(Format::Mp3, &source, &longer, &change(&changes, &fields, None))
            .unwrap_err()
            .code(),
        "refused-audio"
    );
}

#[test]
fn safeguard_3_refuses_a_result_that_lost_or_changed_a_frame() {
    let source = file(
        Version::V23,
        &[
            text("TIT2", "Before"),
            text("TCOM", "1/2"),
            picture(3, "front"),
            picture(4, "back"),
        ],
    );
    let changes = [(Field::Title, "After".to_owned())];
    let fields = Fields {
        title: "After".into(),
        ..Fields::default()
    };
    let shown = cover("front");
    let lost = file(
        Version::V23,
        &[text("TIT2", "After"), picture(3, "front"), picture(4, "back")],
    );
    let error = verify(Format::Mp3, &source, &lost, &change(&changes, &fields, Some(&shown))).unwrap_err();
    assert_eq!(error, Error::Refused(Refusal::Kept("the TCOM frame".into())));
    let changed = file(
        Version::V23,
        &[
            text("TIT2", "After"),
            text("TCOM", "1/3"),
            picture(3, "front"),
            picture(4, "back"),
        ],
    );
    assert_eq!(
        verify(Format::Mp3, &source, &changed, &change(&changes, &fields, Some(&shown)))
            .unwrap_err()
            .code(),
        "refused-kept"
    );
    let no_back = file(
        Version::V23,
        &[text("TIT2", "After"), text("TCOM", "1/2"), picture(3, "front")],
    );
    let error = verify(Format::Mp3, &source, &no_back, &change(&changes, &fields, Some(&shown))).unwrap_err();
    assert_eq!(error, Error::Refused(Refusal::Kept("a picture".into())));
    let kept = file(
        Version::V23,
        &[
            text("TIT2", "After"),
            text("TCOM", "1/2"),
            picture(3, "front"),
            picture(4, "back"),
        ],
    );
    assert!(verify(Format::Mp3, &source, &kept, &change(&changes, &fields, Some(&shown))).is_ok());
}

#[test]
fn safeguard_3_refuses_a_flac_result_that_lost_a_block_or_a_comment() {
    use jackbird_flac::{Block, Comments, entry};
    let comments = |entries: &[(&str, &str)]| {
        let mut block = Comments::new("v");
        block.entries = entries.iter().map(|(key, value)| entry(key, value)).collect();
        Block {
            kind: 4,
            body: block.to_bytes(),
        }
    };
    let flac = |blocks: &[Block]| {
        let mut bytes = jackbird_flac::write(blocks).unwrap();
        bytes.extend_from_slice(&[0xff, 0xf8, 1, 2]);
        bytes
    };
    let streaminfo = Block {
        kind: 0,
        body: vec![0; 34],
    };
    let application = Block {
        kind: 2,
        body: b"appl".to_vec(),
    };
    let source = flac(&[
        streaminfo.clone(),
        application.clone(),
        comments(&[("TITLE", "Before"), ("LYRICS", "la")]),
    ]);
    let changes = [(Field::Title, "After".to_owned())];
    let fields = Fields {
        title: "After".into(),
        ..Fields::default()
    };
    let no_application = flac(&[streaminfo.clone(), comments(&[("TITLE", "After"), ("LYRICS", "la")])]);
    let error = verify(Format::Flac, &source, &no_application, &change(&changes, &fields, None)).unwrap_err();
    assert_eq!(error, Error::Refused(Refusal::Kept("a metadata block".into())));
    let no_lyrics = flac(&[streaminfo.clone(), application.clone(), comments(&[("TITLE", "After")])]);
    let error = verify(Format::Flac, &source, &no_lyrics, &change(&changes, &fields, None)).unwrap_err();
    assert_eq!(error, Error::Refused(Refusal::Kept("a comment".into())));
    let kept = flac(&[
        streaminfo,
        application,
        comments(&[("TITLE", "After"), ("LYRICS", "la")]),
    ]);
    assert!(verify(Format::Flac, &source, &kept, &change(&changes, &fields, None)).is_ok());
}

// ---------------------------------------------------------------- the year, the region, errors

#[test]
fn years_parse_as_id3v24_timestamps() {
    let ok = |value: &str| year::parse(value).is_some();
    for value in [
        "1959",
        "0000",
        "1959-03",
        "1959-03-02",
        "1959-03-02T10",
        "1959-03-02T10:20",
        "1959-03-02T10:20:30",
    ] {
        assert!(ok(value), "{value}");
    }
    for value in [
        "",
        "59",
        "c. 1959",
        "1959-1960",
        "1959-13",
        "1959-00",
        "1959-03-32",
        "1959-3-2",
        "1959-03T10",
        "1959-03-02T24",
        "1959-03-02T10:60",
        "1959-03-02T10:20:30:40",
        "1959-03-02-01",
        " 1959",
    ] {
        assert!(!ok(value), "{value}");
    }
    let parsed = year::parse("2001-05-06T07").unwrap();
    assert_eq!(
        (parsed.year, parsed.month, parsed.day, parsed.has_time),
        (2001, Some(5), Some(6), true)
    );
}

#[test]
fn the_audio_region_is_get_audio_frame_slices() {
    // Only an APEv2 tag's 32-byte footer is left out, as getAudioFrameSlice does.
    let mut ape = AUDIO.to_vec();
    ape.extend(b"APETAGEX");
    ape.extend([0; 24]);
    assert_eq!(audio_region(&ape), 0..AUDIO.len());
    // A footer flag counts whatever the version, as getAudioFrameSlice has it.
    let mut v23 = id3::write(Version::V23, 0, &[], 4).unwrap();
    v23[5] = 0x10;
    v23.extend([0; 10]);
    v23.extend_from_slice(&AUDIO);
    assert_eq!(audio_region(&v23), 24..24 + AUDIO.len());
    // A tag longer than the file, or nothing left after it: the whole file.
    let long = b"ID3\x03\x00\x00\x00\x00\x7f\x7f\xff\xfb";
    assert_eq!(audio_region(long), 0..long.len());
    // An ID3v1 tag is only taken off when more than 128 bytes follow the ID3v2 tag.
    let mut short = b"TAG".to_vec();
    short.extend([0; 125]);
    assert_eq!(audio_region(&short), 0..128);
    // A FLAC that does not parse falls back to the MP3 definition.
    assert_eq!(audio_region(b"fLaC\x00\x00"), 0..6);
}

#[test]
fn formats_are_told_from_the_first_bytes() {
    assert_eq!(format_of(&AUDIO), Some(Format::Mp3));
    let mut late = vec![0; 300];
    late.extend_from_slice(&AUDIO);
    assert_eq!(format_of(&late), Some(Format::Mp3));
    assert_eq!(format_of(b"ID3\x03\x00\x00\x00\x00\x00\x00"), Some(Format::Mp3));
    assert_eq!(format_of(b"fLaC\x00"), Some(Format::Flac));
    assert_eq!(format_of(b"RIFF....WAVE"), None);
}

#[test]
fn errors_have_codes_and_messages() {
    let errors = [
        Error::NotSupported,
        Error::Unreadable("x".into()),
        Error::InvalidYear("c. 1959".into()),
        Error::Id3v22,
        Error::TooLarge,
        Error::Refused(Refusal::Fields("x".into())),
        Error::Refused(Refusal::Audio),
        Error::Refused(Refusal::Kept("x".into())),
    ];
    let codes: Vec<&str> = errors.iter().map(Error::code).collect();
    assert_eq!(
        codes,
        [
            "not-supported",
            "unreadable",
            "invalid-year",
            "id3v22",
            "too-large",
            "refused-fields",
            "refused-audio",
            "refused-kept"
        ]
    );
    assert!(errors.iter().all(|error| !error.to_string().is_empty()));
}

#[test]
fn fields_and_edits_by_field() {
    let fields = Fields {
        title: "t".into(),
        artist: "a".into(),
        album: "l".into(),
        year: "y".into(),
        genre: "g".into(),
        track: "n".into(),
        disc: "d".into(),
        album_artist: "aa".into(),
        compilation: "1".into(),
    };
    let edit = Edit::all(&fields);
    for field in Field::ALL {
        assert_eq!(edit.get(field), Some(fields.get(field)));
    }
    assert_eq!(Edit::default().get(Field::Title), None);
}

// ---------------------------------------------------------------- by head and splice

fn layout_whole(bytes: &[u8]) -> FileLayout {
    let tail = &bytes[bytes.len().saturating_sub(TAIL_LEN)..];
    match layout(bytes, tail, bytes.len() as u64).unwrap() {
        Layout::Known(found) => found,
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_structural_safeguard_refuses_tags_that_do_not_end_where_they_say() {
    let source = file(Version::V23, &[text("TIT2", "Before")]);
    let layout = layout_whole(&source);
    let source_tags = &source[..layout.tags_end as usize];
    let splice = write_head(
        &source,
        &layout,
        &Edit {
            title: Some("After".into()),
            ..Edit::default()
        },
    )
    .unwrap();
    assert_eq!(splice.replace, 0..layout.tags_end);
    let changes = [(Field::Title, "After".to_owned())];
    let fields = Fields {
        title: "After".into(),
        ..Fields::default()
    };
    assert!(verify_head(Format::Mp3, source_tags, &splice.with, &change(&changes, &fields, None)).is_ok());
    // A byte too many after the tag: the audio would start a byte late.
    let mut late = splice.with.clone();
    late.push(0);
    assert_eq!(
        verify_head(Format::Mp3, source_tags, &late, &change(&changes, &fields, None)).unwrap_err(),
        Error::Refused(Refusal::Audio)
    );
    // A tag one byte short of its size cannot be read back: refused too.
    let early = &splice.with[..splice.with.len() - 1];
    assert!(verify_head(Format::Mp3, source_tags, early, &change(&changes, &fields, None)).is_err());
}

#[test]
fn layout_asks_for_the_tag_then_knows() {
    let mut source = file(Version::V24, &[text("TIT2", "Title"), picture(3, &"x".repeat(100))]);
    source.extend(b"TAG");
    source.extend([0; 125]);
    let len = source.len() as u64;
    let tail = &source[source.len() - TAIL_LEN..];
    assert_eq!(layout(&source[..4], tail, len).unwrap(), Layout::NeedHead(10));
    let tag_len = 10 + 64 + 10 + 6 + 10 + 114;
    assert_eq!(
        layout(&source[..10], tail, len).unwrap(),
        Layout::NeedHead(tag_len as u64 + 4)
    );
    let known = layout_whole(&source);
    assert_eq!(
        layout(&source[..tag_len + 4], tail, len).unwrap(),
        Layout::Known(known.clone())
    );
    assert_eq!(known.tags_end, tag_len as u64);
    assert_eq!(known.audio, tag_len as u64..len - 128);
    assert_eq!(read_head(&source[..tag_len], &known).unwrap(), read(&source).unwrap());
    // A head shorter than the tags, or a tail that is not the file's, is refused.
    assert_eq!(read_head(&source[..20], &known).unwrap_err().code(), "unreadable");
    assert_eq!(layout(&source[..10], &tail[1..], len).unwrap_err().code(), "unreadable");
    // Not a format the engine reads: the region all the same, by the MP3 rule.
    let other = [0u8; 300];
    let found = layout_whole(&other);
    assert_eq!((found.format, found.tags_end, found.audio.clone()), (None, 0, 0..300));
    assert_eq!(read_head(&other, &found).unwrap_err(), Error::NotSupported);
}
