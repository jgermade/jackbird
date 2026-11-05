use crate::*;

fn block(kind: u8, body: &[u8]) -> Block {
    Block {
        kind,
        body: body.to_vec(),
    }
}

fn streaminfo() -> Block {
    block(STREAMINFO, &[7; 34])
}

const AUDIO: [u8; 6] = [0xff, 0xf8, 0x69, 0x08, 1, 2];

fn file(prefix: &[u8], blocks: &[Block]) -> Vec<u8> {
    let mut out = prefix.to_vec();
    out.extend(write(blocks).unwrap());
    out.extend_from_slice(&AUDIO);
    out
}

#[test]
fn round_trips_blocks_byte_for_byte() {
    let blocks = vec![streaminfo(), block(2, b"appldata"), block(PADDING, &[0; 16])];
    let bytes = file(&[], &blocks);
    let metadata = read(&bytes).unwrap();
    assert_eq!(metadata.start, 0);
    assert_eq!(metadata.blocks, blocks);
    assert_eq!(&bytes[metadata.audio..], AUDIO);
    assert_eq!(metadata.len(), bytes.len() - AUDIO.len());
    assert!(!metadata.is_empty());
    // Only the last block is flagged.
    assert_eq!(bytes[4] & 0x80, 0);
    assert_eq!(bytes[4 + 4 + 34 + 4 + 8] & 0x80, 0x80);
}

#[test]
fn skips_an_id3v2_tag_in_front() {
    let id3 = b"ID3\x03\x00\x00\x00\x00\x00\x02\0\0";
    let bytes = file(id3, &[streaminfo()]);
    assert_eq!(marker_at(&bytes), Some(12));
    let metadata = read(&bytes).unwrap();
    assert_eq!(metadata.start, 12);
    assert_eq!(&bytes[metadata.audio..], AUDIO);
    // A v2.4 footer counts in the tag's length.
    let footed = b"ID3\x04\x00\x10\x00\x00\x00\x00ID3\x04\x00\x10\x00\x00\x00\x00";
    assert_eq!(marker_at(&file(&footed[..], &[streaminfo()])), Some(20));
}

#[test]
fn refuses_what_is_not_flac_or_is_broken() {
    assert_eq!(read(b"OggS...."), Err(Error::NotFlac));
    assert_eq!(read(b"fLa"), Err(Error::NotFlac));
    let mut never_last = write(&[streaminfo()]).unwrap();
    never_last[4] &= 0x7f;
    assert_eq!(read(&never_last), Err(Error::Truncated));
    let bytes = file(&[], &[streaminfo()]);
    assert_eq!(read(&bytes[..20]), Err(Error::Truncated));
    assert!(matches!(read(&file(&[], &[block(4, b"")])), Err(Error::Malformed(_))));
    assert!(matches!(
        read(&file(&[], &[streaminfo(), block(127, b"")])),
        Err(Error::Malformed(_))
    ));
    assert_eq!(write(&[block(PADDING, &vec![0; BLOCK_MAX + 1])]), Err(Error::TooLarge));
    for error in [Error::NotFlac, Error::Truncated, Error::Malformed("x"), Error::TooLarge] {
        assert!(!error.to_string().is_empty());
    }
}

#[test]
fn padding_keeps_the_audio_in_place_when_it_fits() {
    let blocks = vec![streaminfo(), block(2, b"abcd")];
    let used = 4 + 38 + 8;
    // Room to spare: padding fills it.
    let padded = with_padding(blocks.clone(), used + 100, 1024);
    assert_eq!(padded.last(), Some(&block(PADDING, &[0; 96])));
    assert_eq!(write(&padded).unwrap().len(), used + 100);
    // Exactly the room: no padding block.
    assert_eq!(with_padding(blocks.clone(), used, 1024), blocks);
    // Less than a header's room over, or too little room: the fallback.
    assert_eq!(
        with_padding(blocks.clone(), used + 3, 1024).last().unwrap().body.len(),
        1024
    );
    assert_eq!(
        with_padding(blocks.clone(), used - 1, 1024).last().unwrap().body.len(),
        1024
    );
}

#[test]
fn comments_keep_every_entry_as_it_was() {
    let mut body = Vec::new();
    body.extend(6u32.to_le_bytes());
    body.extend(b"vendor");
    let entries: [&[u8]; 5] = [
        b"TITLE=a",
        b"title=b",
        b"NOEQUALS",
        b"KEY=\xff\xfe",
        "K\u{e9}Y=v".as_bytes(),
    ];
    body.extend((entries.len() as u32).to_le_bytes());
    for entry in entries {
        body.extend((entry.len() as u32).to_le_bytes());
        body.extend(entry);
    }
    body.push(1); // a framing bit
    let comments = Comments::parse(&body).unwrap();
    assert_eq!(comments.vendor, b"vendor");
    assert_eq!(comments.entries.len(), 5);
    assert_eq!(comments.trailing, [1]);
    assert_eq!(comments.to_bytes(), body);
    assert_eq!(comments.get("Title").as_deref(), Some("a"));
    assert_eq!(comments.positions("TITLE"), [0, 1]);
    assert_eq!(comments.get("KEY").as_deref(), Some("\u{fffd}\u{fffd}"));
    assert_eq!(comments.get("NOEQUALS"), None);
    assert_eq!(comments.get("ARTIST"), None);
    assert_eq!(entry("ARTIST", "Ñ"), "ARTIST=Ñ".as_bytes());
    let fresh = Comments::new("jackbird");
    assert_eq!(Comments::parse(&fresh.to_bytes()).unwrap(), fresh);
}

#[test]
fn refuses_comments_that_run_past_their_block() {
    assert_eq!(Comments::parse(&[1, 0, 0]), Err(Error::Truncated));
    assert_eq!(Comments::parse(&[9, 0, 0, 0, b'v']), Err(Error::Truncated));
    assert_eq!(
        Comments::parse(&[0, 0, 0, 0, 1, 0, 0, 0, 9, 0, 0, 0]),
        Err(Error::Truncated)
    );
}

#[test]
fn pictures_round_trip() {
    let picture = Picture {
        kind: 3,
        mime: "image/png".into(),
        description: "Front".into(),
        width: 16,
        height: 9,
        depth: 24,
        colors: 0,
        data: vec![1, 2, 3],
    };
    let body = encode_picture(&picture);
    assert_eq!(decode_picture(&body).unwrap(), picture);
    assert_eq!(decode_picture(&body[..body.len() - 1]), Err(Error::Truncated));
    assert_eq!(decode_picture(&[0, 0]), Err(Error::Truncated));
}

#[test]
fn reads_the_size_of_pngs_and_jpegs() {
    let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    png.extend(16u32.to_be_bytes());
    png.extend(9u32.to_be_bytes());
    png.extend([8, 6]);
    assert_eq!(image_size(&png), Some((16, 9, 32)));
    png[25] = 3;
    assert_eq!(image_size(&png), Some((16, 9, 8)));
    png[25] = 9;
    assert_eq!(image_size(&png), None);

    // SOI, an APP0 of 4 bytes, a DHT to skip, then SOF0: 8 bits, 9 high, 16 wide, 3 components.
    let jpeg = [
        0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc4, 0, 2, 0xff, 0xff, 0xc0, 0, 11, 8, 0, 9, 0, 16, 3, 1, 1, 0,
    ];
    assert_eq!(image_size(&jpeg), Some((16, 9, 24)));
    assert_eq!(image_size(&[0xff, 0xd8, 0x00, 0x00, 0, 0]), None);
    assert_eq!(image_size(&[0xff, 0xd8]), None);
    assert_eq!(image_size(b"GIF89a"), None);
}
