//! Every case of `src/helpers/id3v2.test.ts`, and the ones the TypeScript
//! code never met: v2.2, a v2.4 frame's own flags, the codecs.

use crate::*;

fn latin1(text: &str) -> Vec<u8> {
    text.chars().map(|c| c as u8).collect()
}

/// A text frame: encoding 0 (ISO-8859-1), then the text.
fn text(id: &str, value: &str) -> Frame {
    let mut body = vec![0];
    body.extend(latin1(value));
    Frame::new(id, body)
}

fn flagged(mut frame: Frame, flags: [u8; 2]) -> Frame {
    frame.flags = flags;
    frame
}

/// A picture frame: encoding, MIME type, picture type, empty description, then the "image".
fn picture(kind: u8, data: &str) -> Frame {
    let mut body = vec![0];
    body.extend(latin1("image/jpeg"));
    body.extend([0, kind, 0]);
    body.extend(latin1(data));
    Frame::new("APIC", body)
}

const AUDIO: [u8; 8] = [0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4];

fn file(tag: &[u8]) -> Vec<u8> {
    let mut out = tag.to_vec();
    out.extend_from_slice(&AUDIO);
    out
}

fn frames() -> Vec<Frame> {
    vec![text("TIT2", "So What"), text("TPOS", "1/2"), picture(3, "front")]
}

fn ids(tag: &Tag) -> Vec<&str> {
    tag.frames.iter().map(|frame| frame.id.as_str()).collect()
}

fn set_size(tag: &mut [u8], size: usize) {
    tag[6..10].copy_from_slice(&[
        (size >> 21) as u8 & 0x7f,
        (size >> 14) as u8 & 0x7f,
        (size >> 7) as u8 & 0x7f,
        size as u8 & 0x7f,
    ]);
}

// ---------------------------------------------------------------- write and read

#[test]
fn round_trips_a_v23_and_a_v24_tag_frame_for_frame() {
    for version in [Version::V23, Version::V24] {
        let tag = write(version, 0, &frames(), 0).unwrap();
        let read = read(&file(&tag)).unwrap().unwrap();
        assert_eq!(read.version, version);
        assert_eq!(read.len, tag.len());
        assert_eq!(read.frames, frames());
        assert!(read.clean);
    }
}

#[test]
fn writes_v23_frame_sizes_plain_and_v24_ones_syncsafe() {
    let long = Frame::new("TXXX", vec![0; 200]);
    assert_eq!(
        write(Version::V23, 0, std::slice::from_ref(&long), 0).unwrap()[14..18],
        [0, 0, 0, 200]
    );
    assert_eq!(write(Version::V24, 0, &[long], 0).unwrap()[14..18], [0, 0, 1, 72]);
}

#[test]
fn stops_at_padding() {
    let tag = write(Version::V23, 0, &frames(), 64).unwrap();
    let read = read(&file(&tag)).unwrap().unwrap();
    assert_eq!(ids(&read), ["TIT2", "TPOS", "APIC"]);
    assert_eq!(read.len, tag.len());
    assert_eq!(read.padding, 64);
    assert!(read.clean);
}

#[test]
fn is_none_without_a_tag() {
    assert_eq!(read(&AUDIO).unwrap(), None);
    assert_eq!(read(b"ID3").unwrap(), None);
}

#[test]
fn a_v23_tag_labelled_v22_does_not_read_cleanly() {
    let mut v22 = write(Version::V23, 0, &frames(), 0).unwrap();
    v22[3] = 2;
    assert!(!read(&v22).unwrap().unwrap().clean);
}

#[test]
fn frames_that_do_not_end_cleanly_are_flagged() {
    let mut overlong = write(Version::V23, 0, &[text("TIT2", "x")], 0).unwrap();
    overlong[17] = 99;
    let read_overlong = read(&overlong).unwrap().unwrap();
    assert!(!read_overlong.clean);
    assert!(read_overlong.frames.is_empty());

    let mut garbage = write(Version::V23, 0, &[text("TIT2", "x"), text("TPOS", "1")], 0).unwrap();
    garbage[10 + 12..10 + 16].copy_from_slice(b"tp0s");
    let read_garbage = read(&garbage).unwrap().unwrap();
    assert!(!read_garbage.clean);
    assert_eq!(ids(&read_garbage), ["TIT2"]);
}

#[test]
fn skips_an_extended_header_in_v23_and_in_v24() {
    for version in [Version::V23, Version::V24] {
        let plain_tag = write(version, 0, &frames(), 0).unwrap();
        let extended: &[u8] = if version == Version::V23 {
            &[0, 0, 0, 6, 0, 0, 0, 0, 0, 0]
        } else {
            &[0, 0, 0, 6, 1, 0]
        };
        let mut tag = plain_tag[..10].to_vec();
        tag.extend_from_slice(extended);
        tag.extend_from_slice(&plain_tag[10..]);
        tag[5] = 0x40;
        let size = tag.len() - 10;
        set_size(&mut tag, size);
        assert_eq!(read(&file(&tag)).unwrap().unwrap().frames, frames());
    }
}

#[test]
fn refuses_an_extended_header_larger_than_the_tag() {
    let mut tag = write(Version::V23, 0, &frames(), 0).unwrap();
    tag[5] = 0x40;
    tag[10..14].copy_from_slice(&[0, 0, 0x7f, 0x7f]);
    assert_eq!(read(&tag), Err(Error::ExtendedHeader));
}

#[test]
fn counts_a_v24_footer_in_the_tags_length() {
    let mut tag = write(Version::V24, 0, &frames(), 0).unwrap();
    tag[5] = 0x10;
    let mut bytes = tag.clone();
    bytes.extend_from_slice(b"3DI\x04\x00\x10\x00\x00\x00\x00");
    bytes.extend_from_slice(&AUDIO);
    assert_eq!(read(&bytes).unwrap().unwrap().len, tag.len() + 10);
    assert_eq!(tag_len(&bytes), Some(tag.len() + 10));
}

#[test]
fn undoes_a_v23_tags_unsynchronisation() {
    let body = Frame::new("PRIV", vec![0xff, 0xe0, 7]);
    let tag = write(Version::V23, 0, std::slice::from_ref(&body), 0).unwrap();
    // Unsynchronised: a 0x00 after the 0xFF, and the sizes grown by one.
    let mut unsynced = tag[..20].to_vec();
    unsynced.extend_from_slice(&[0xff, 0x00, 0xe0, 7]);
    unsynced[5] = 0x80;
    unsynced[9] = tag[9] + 1;
    assert_eq!(read(&unsynced).unwrap().unwrap().frames, [body]);
}

#[test]
fn reads_a_v24_tag_written_with_plain_frame_sizes() {
    let long = Frame::new("TXXX", vec![7; 200]);
    let mut tag = write(Version::V24, 0, std::slice::from_ref(&long), 0).unwrap();
    tag[14..18].copy_from_slice(&[0, 0, 0, 200]);
    let read = read(&tag).unwrap().unwrap();
    assert_eq!(read.frames, [long]);
    assert!(read.plain_sizes);
    assert!(read.clean);
}

#[test]
fn refuses_versions_it_does_not_know_and_tags_longer_than_the_file() {
    let mut tag = write(Version::V23, 0, &frames(), 0).unwrap();
    tag[3] = 5;
    assert_eq!(read(&tag), Err(Error::UnsupportedVersion(5)));
    let tag = write(Version::V23, 0, &frames(), 0).unwrap();
    assert_eq!(read(&tag[..tag.len() - 1]), Err(Error::Truncated));
}

#[test]
fn reads_a_v22_tag() {
    let mut body = Vec::new();
    for (id, value) in [("TT2", &b"\0Old"[..]), ("TP1", b"\0Artist")] {
        body.extend_from_slice(id.as_bytes());
        body.extend_from_slice(&[0, 0, value.len() as u8]);
        body.extend_from_slice(value);
    }
    let mut tag = b"ID3\x02\x00\x00".to_vec();
    tag.extend_from_slice(&[0, 0, 0, body.len() as u8 + 4]);
    tag.extend_from_slice(&body);
    tag.extend_from_slice(&[0; 4]);
    let read = read(&file(&tag)).unwrap().unwrap();
    assert_eq!(read.version, Version::V22);
    assert_eq!(ids(&read), ["TT2", "TP1"]);
    assert_eq!(
        decode_text(&read.frames[0].content(Version::V22, false).unwrap()),
        ["Old"]
    );
    assert!(read.clean);
    assert_eq!(read.padding, 4);
}

#[test]
fn ignores_a_compressed_v22_tag_and_does_not_write_v22() {
    let mut tag = b"ID3\x02\x00\x40\x00\x00\x00\x00".to_vec();
    tag.extend_from_slice(&AUDIO);
    assert_eq!(read(&tag), Err(Error::CompressedTag));
    assert_eq!(write(Version::V22, 0, &[], 0), Err(Error::UnsupportedVersion(2)));
}

#[test]
fn writes_only_a_v24_tags_unsynchronisation_flag() {
    assert_eq!(write(Version::V24, 0xf0, &[], 0).unwrap()[5], 0x80);
    assert_eq!(write(Version::V23, 0xf0, &[], 0).unwrap()[5], 0);
}

#[test]
fn refuses_a_frame_id_that_is_not_four_characters() {
    assert!(write(Version::V23, 0, &[Frame::new("TT2", vec![0])], 0).is_err());
    assert!(write(Version::V23, 0, &[Frame::new("tit2", vec![0])], 0).is_err());
}

// ---------------------------------------------------------------- frames

#[test]
fn a_frame_knows_when_to_go_with_an_altered_tag() {
    assert!(flagged(text("TPOS", "1"), [0x80, 0]).discard_on_tag_change(Version::V23));
    assert!(!flagged(text("TPOS", "1"), [0x40, 0]).discard_on_tag_change(Version::V23));
    assert!(flagged(text("TPOS", "1"), [0x40, 0]).discard_on_tag_change(Version::V24));
    assert!(!text("TPOS", "1").discard_on_tag_change(Version::V22));
}

#[test]
fn a_v24_frames_content_without_its_unsynchronisation_group_and_length() {
    // Grouping (0x40), unsynchronisation (0x02) and a data length indicator (0x01).
    let mut body = vec![9, 0, 0, 0, 4];
    body.extend(unsynchronise(&[0, 0xff, 0xe0, b'x']));
    let frame = flagged(Frame::new("PRIV", body), [0, 0x43]);
    assert_eq!(&*frame.content(Version::V24, false).unwrap(), &[0, 0xff, 0xe0, b'x']);
    // The tag's header flag stands for every frame's.
    let frame = Frame::new("PRIV", unsynchronise(&[0xff, 0xe0]));
    assert_eq!(&*frame.content(Version::V24, true).unwrap(), &[0xff, 0xe0]);
    assert_eq!(frame.clone().unsynchronised().flags, [0, 0x02]);
}

#[test]
fn a_frames_content_skips_v23s_group_byte() {
    let frame = flagged(Frame::new("TIT2", vec![7, 0, b'A']), [0, 0x20]);
    assert_eq!(decode_text(&frame.content(Version::V23, false).unwrap()), ["A"]);
}

#[test]
fn compressed_and_encrypted_frames_cannot_be_read() {
    for (version, flags) in [
        (Version::V23, 0x80),
        (Version::V23, 0x40),
        (Version::V24, 0x08),
        (Version::V24, 0x04),
    ] {
        let frame = flagged(text("TIT2", "x"), [0, flags]);
        assert!(matches!(frame.content(version, false), Err(Error::Undecodable(_))));
    }
    let short = flagged(Frame::new("TIT2", vec![0, 0]), [0, 0x01]);
    assert!(matches!(short.content(Version::V24, false), Err(Error::Malformed(_))));
}

// ---------------------------------------------------------------- codecs

#[test]
fn resynchronise_drops_each_00_that_follows_ff_and_only_those() {
    assert_eq!(
        resynchronise(&[0x00, 0xff, 0x00, 0xe0, 0xff, 0x00, 0x00, 1]),
        [0x00, 0xff, 0xe0, 0xff, 0x00, 1]
    );
    let data = [0xff, 0xe0, 0xff, 0x00, 0xff, 0x12, 0xff];
    assert_eq!(unsynchronise(&data), [0xff, 0, 0xe0, 0xff, 0, 0, 0xff, 0x12, 0xff, 0]);
    assert_eq!(resynchronise(&unsynchronise(&data)), data);
}

#[test]
fn decodes_text_in_the_four_encodings() {
    assert_eq!(decode_text(b"\0Caf\xe9"), ["Café"]);
    assert_eq!(decode_text(b"\x03Caf\xc3\xa9\0"), ["Café"]);
    assert_eq!(decode_text(b"\x01\xff\xfeC\0a\0f\0\xe9\0\0\0"), ["Café"]);
    assert_eq!(decode_text(b"\x01\xfe\xff\0C\0a"), ["Ca"]);
    assert_eq!(decode_text(b"\x02\0C\0a"), ["Ca"]);
    assert!(decode_text(b"").is_empty());
    assert!(decode_text(b"\0").is_empty());
}

#[test]
fn decodes_several_values_and_byte_order_marks_per_value() {
    assert_eq!(decode_text(b"\x03One\0Two"), ["One", "Two"]);
    assert_eq!(decode_text(b"\x01\xff\xfeA\0\0\0\xfe\xff\0B"), ["A", "B"]);
    // A value without its own mark takes the previous one's.
    assert_eq!(decode_text(b"\x01\xfe\xff\0A\0\0\0B"), ["A", "B"]);
}

#[test]
fn decodes_broken_text_leniently() {
    // No byte order mark: guessed from where the zero bytes are.
    assert_eq!(decode_text(b"\x01A\0b\0"), ["Ab"]);
    assert_eq!(decode_text(b"\x01\0A\0b"), ["Ab"]);
    // Invalid UTF-8, an odd UTF-16 length, an encoding the standard does not define.
    assert_eq!(decode_text(b"\x03A\xffB"), ["A\u{fffd}B"]);
    assert_eq!(decode_text(b"\x01\xff\xfeA\0B"), ["A"]);
    assert_eq!(decode_text(b"\x07Ab"), ["Ab"]);
}

#[test]
fn encodes_text_in_latin1_when_it_fits() {
    assert_eq!(encode_text("Café", Version::V23), b"\0Caf\xe9");
    assert_eq!(encode_text("Café", Version::V24), b"\0Caf\xe9");
    assert_eq!(encode_text("東京", Version::V24), "\u{3}東京".as_bytes());
    assert_eq!(encode_text("Ő", Version::V23), [1, 0xff, 0xfe, 0x50, 0x01]);
    for value in ["Café", "東京 — Ñandú", ""] {
        for version in [Version::V23, Version::V24] {
            let decoded = decode_text(&encode_text(value, version));
            assert_eq!(decoded.first().map(String::as_str).unwrap_or(""), value);
        }
    }
}

#[test]
fn decodes_and_encodes_pictures() {
    let apic = picture(3, "front");
    let decoded = decode_picture(&apic.body, Version::V23).unwrap();
    assert_eq!(
        decoded,
        Picture {
            mime: "image/jpeg".into(),
            kind: 3,
            description: String::new(),
            data: latin1("front")
        }
    );
    assert_eq!(encode_picture(&decoded, Version::V23), apic.body);

    let utf16 = Picture {
        mime: "image/png".into(),
        kind: 4,
        description: "Ñ東".into(),
        data: vec![0, 0, 1],
    };
    for version in [Version::V23, Version::V24] {
        assert_eq!(
            decode_picture(&encode_picture(&utf16, version), version).unwrap(),
            utf16
        );
    }

    let pic = b"\0JPG\x03desc\0\xff\xd8";
    let decoded = decode_picture(pic, Version::V22).unwrap();
    assert_eq!(
        (decoded.mime.as_str(), decoded.kind, decoded.description.as_str()),
        ("image/jpeg", 3, "desc")
    );
    assert_eq!(decoded.data, [0xff, 0xd8]);
    assert_eq!(decode_picture(b"\0PNG\x00\0", Version::V22).unwrap().mime, "image/png");
    assert!(decode_picture(b"", Version::V23).is_err());
    assert!(decode_picture(b"\0image/jpeg\0", Version::V23).is_err());
    assert!(decode_picture(b"\0JP", Version::V22).is_err());
}

#[test]
fn a_utf16_description_ends_at_an_aligned_terminator() {
    // "A" then the terminator; the image starts with a zero byte.
    let content = b"\x01image/jpeg\0\x03\xff\xfeA\0\0\0\0\xd8";
    let decoded = decode_picture(content, Version::V23).unwrap();
    assert_eq!(decoded.description, "A");
    assert_eq!(decoded.data, [0, 0xd8]);
}

#[test]
fn errors_say_what_went_wrong() {
    for error in [
        Error::UnsupportedVersion(5),
        Error::Truncated,
        Error::ExtendedHeader,
        Error::CompressedTag,
        Error::Undecodable("compressed"),
        Error::Malformed("a picture"),
        Error::TooLarge,
    ] {
        assert!(!error.to_string().is_empty());
    }
}
