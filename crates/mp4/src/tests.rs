use super::*;
use crate::track::audio_config;

/// A box: its 32-bit size, its type, its content.
fn boxed(kind: &[u8; 4], content: &[u8]) -> Vec<u8> {
    let mut out = ((8 + content.len()) as u32).to_be_bytes().to_vec();
    out.extend(kind);
    out.extend(content);
    out
}

/// A full box: version 0, no flags.
fn full(kind: &[u8; 4], content: &[u8]) -> Vec<u8> {
    let mut body = vec![0, 0, 0, 0];
    body.extend(content);
    boxed(kind, &body)
}

fn data(kind: u32, value: &[u8]) -> Vec<u8> {
    let mut body = kind.to_be_bytes().to_vec();
    body.extend([0, 0, 0, 0]);
    body.extend(value);
    boxed(b"data", &body)
}

fn handler(kind: &[u8; 4]) -> Vec<u8> {
    let mut body = vec![0, 0, 0, 0];
    body.extend(kind);
    body.extend([0; 13]);
    full(b"hdlr", &body)
}

#[test]
fn headers_of_every_size() {
    // 32-bit.
    assert_eq!(
        header(&boxed(b"free", &[0; 4]), 100, 0).unwrap(),
        Some(Header {
            kind: *b"free",
            header_len: 8,
            size: 12
        })
    );
    // 64-bit.
    let mut large = vec![0, 0, 0, 1];
    large.extend(b"mdat");
    large.extend(40u64.to_be_bytes());
    assert_eq!(
        header(&large, 40, 0).unwrap().map(|h| (h.header_len, h.size)),
        Some((16, 40))
    );
    // 0: to the end of what holds it.
    assert_eq!(header(b"\0\0\0\0mdat", 1000, 0).unwrap().map(|h| h.size), Some(1000));
    // Cut short: more bytes are needed, not an error.
    assert_eq!(header(b"\0\0\0\x10mo", 100, 0).unwrap(), None);
    assert_eq!(header(&large[..12], 40, 0).unwrap(), None);
    // Smaller than its header, or past its parent.
    assert!(matches!(header(b"\0\0\0\x04free", 100, 0), Err(Error::BadSize { .. })));
    assert!(matches!(
        header(b"\0\0\0\x40free", 32, 7),
        Err(Error::BadSize { at: 7, .. })
    ));
}

#[test]
fn the_top_level_from_a_head() {
    let mut file = boxed(b"ftyp", b"M4A \0\0\0\0");
    file.extend(boxed(b"moov", &[0; 20]));
    file.extend(boxed(b"mdat", &[1; 100]));
    let len = file.len() as u64;
    let (whole, next) = top_level(&file, len).unwrap();
    assert_eq!(
        whole
            .iter()
            .map(|placed| (placed.header.kind, placed.start))
            .collect::<Vec<_>>(),
        [(*b"ftyp", 0), (*b"moov", 16), (*b"mdat", 44)]
    );
    assert_eq!(next, None);
    assert_eq!(whole[2].content(), 52..len);
    // A head that ends inside mdat's content still knows mdat; one that ends inside moov's header
    // says where to read from.
    assert_eq!(top_level(&file[..60], len).unwrap().0.len(), 3);
    assert_eq!(top_level(&file[..20], len).unwrap(), (whole[..1].to_vec(), Some(16)));
    // A size past the file is an error.
    assert!(top_level(&file, len - 1).is_err());
}

#[test]
fn children_paths_and_both_forms_of_meta() {
    let ilst = boxed(b"ilst", &boxed(b"\xa9nam", &data(1, b"Title")));
    let mut iso = handler(b"mdir");
    iso.extend(&ilst);
    iso.extend(boxed(b"free", &[0; 8]));
    let moov_iso = boxed(b"udta", &full(b"meta", &iso));
    let mut quicktime = handler(b"mdir");
    quicktime.extend(&ilst);
    let moov_qt = boxed(b"udta", &boxed(b"meta", &quicktime));

    for (moov, qt) in [(&moov_iso, false), (&moov_qt, true)] {
        let found = path(moov, &[b"udta", b"meta", b"ilst"]).unwrap().unwrap();
        assert_eq!(found.kind, *b"ilst");
        let at = tags_at(moov).unwrap();
        assert_eq!(at.quicktime_meta, qt);
        let (start, end) = at.ilst.unwrap();
        assert_eq!(&moov[start..end], &ilst[..]);
        let items = tags(moov).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].data[0].text(), "Title");
    }
    assert_eq!(tags_at(&boxed(b"trak", &[])).unwrap(), TagsAt::default());
    assert!(children(&[0, 0, 0, 9, b'f', b'r', b'e', b'e']).is_err());
}

#[test]
fn items_with_their_values_and_freeform_names() {
    let mut list = boxed(b"\xa9ART", &[data(1, b"One"), data(1, b"Two")].concat());
    let mut freeform = full(b"mean", b"com.apple.iTunes");
    freeform.extend(full(b"name", b"MusicBrainz Track Id"));
    freeform.extend(data(1, b"0b6c2b4e"));
    list.extend(boxed(b"----", &freeform));
    list.extend(boxed(b"tmpo", &data(21, &120u16.to_be_bytes())));
    list.extend(boxed(b"bad!", &[0, 0, 0, 99]));
    let found = items(&list).unwrap();
    assert_eq!(found.len(), 4);
    assert_eq!(found[0].data.iter().map(Data::text).collect::<Vec<_>>(), ["One", "Two"]);
    assert_eq!(found[1].mean.as_deref(), Some("com.apple.iTunes"));
    assert_eq!(found[1].name.as_deref(), Some("MusicBrainz Track Id"));
    assert_eq!(found[2].data[0].integer(), Some(120));
    // An item whose atoms cannot be read is listed, with no values, where it lies.
    assert_eq!((found[3].kind, found[3].data.len()), (*b"bad!", 0));
    assert_eq!(found[3].range.1, list.len());
}

#[test]
fn data_as_text_and_integers() {
    let utf16 = Data {
        kind: data_type::UTF16,
        locale: 0,
        value: vec![0x00, 0x41, 0x6c, 0x34],
    };
    assert_eq!(utf16.text(), "A水");
    let bytes = |value: &[u8]| Data {
        kind: data_type::INTEGER,
        locale: 0,
        value: value.to_vec(),
    };
    assert_eq!(bytes(&[1]).integer(), Some(1));
    assert_eq!(bytes(&[1, 0, 0]).integer(), Some(65536));
    assert_eq!(bytes(&[]).integer(), None);
    assert_eq!(bytes(&[0; 9]).integer(), None);
}

/// A sound track with this sample entry, its time scale and length.
fn moov_with(entry: &[u8], timescale: u32, duration: u32) -> Vec<u8> {
    let mut mdhd = vec![0u8; 8];
    mdhd.extend(timescale.to_be_bytes());
    mdhd.extend(duration.to_be_bytes());
    mdhd.extend([0; 4]);
    let mut stsd = 1u32.to_be_bytes().to_vec();
    stsd.extend(entry);
    let stbl = boxed(b"stbl", &full(b"stsd", &stsd));
    let mdia = [full(b"mdhd", &mdhd), handler(b"soun"), boxed(b"minf", &stbl)].concat();
    // A video track first, which is passed over.
    let video = boxed(b"trak", &boxed(b"mdia", &handler(b"vide")));
    [video, boxed(b"trak", &boxed(b"mdia", &mdia))].concat()
}

/// An audio sample entry, version 0, then its boxes.
fn sample_entry(kind: &[u8; 4], channels: u16, rate: u32, inner: &[u8]) -> Vec<u8> {
    let mut body = vec![0u8; 16];
    body[7] = 1; // data reference index
    body.extend(channels.to_be_bytes());
    body.extend(16u16.to_be_bytes());
    body.extend([0; 4]);
    body.extend((rate << 16).to_be_bytes());
    body.extend(inner);
    boxed(kind, &body)
}

#[test]
fn an_aac_track() {
    // ES descriptor with a four-byte length, ES_ID 1, no flags; then the decoder configuration
    // (object type 0x40, audio stream), max 160,000 and average 128,000 bit/s.
    let mut config = vec![0x40, 0x15, 0, 0, 0];
    config.extend(160_000u32.to_be_bytes());
    config.extend(128_000u32.to_be_bytes());
    let mut es = vec![0, 1, 0, 4, config.len() as u8];
    es.extend(&config);
    let mut esds = vec![3, 0x80, 0x80, 0x80, es.len() as u8];
    esds.extend(&es);
    let moov = moov_with(
        &sample_entry(b"mp4a", 2, 44_100, &full(b"esds", &esds)),
        44_100,
        441_000,
    );
    assert_eq!(
        audio_track(&moov).unwrap(),
        Some(Track {
            codec: Codec::Aac,
            sample_rate: 44_100,
            channels: 2,
            bits: 0,
            duration: 441_000,
            timescale: 44_100,
            avg_bitrate: 128_000,
            max_bitrate: 160_000,
        })
    );
}

#[test]
fn an_alac_track_and_others() {
    let mut cookie = 4096u32.to_be_bytes().to_vec();
    cookie.extend([0, 24, 40, 10, 14, 2, 0, 255]);
    cookie.extend(0u32.to_be_bytes());
    cookie.extend(1_411_200u32.to_be_bytes());
    cookie.extend(96_000u32.to_be_bytes());
    let moov = moov_with(&sample_entry(b"alac", 2, 0, &full(b"alac", &cookie)), 96_000, 96_000);
    let track = audio_track(&moov).unwrap().unwrap();
    assert_eq!(
        (
            track.codec,
            track.sample_rate,
            track.channels,
            track.bits,
            track.avg_bitrate
        ),
        (Codec::Alac, 96_000, 2, 24, 1_411_200)
    );
    let other = moov_with(&sample_entry(b"ac-3", 6, 48_000, &[]), 48_000, 0);
    assert_eq!(audio_track(&other).unwrap().unwrap().codec, Codec::Other(*b"ac-3"));
    assert_eq!(audio_track(&boxed(b"udta", &[])).unwrap(), None);
}

#[test]
fn the_aac_decoders_own_configuration_wins_over_the_entrys() {
    // As afconvert writes it: the entry says 2 channels and 22,050 Hz; the configuration (13 88:
    // AAC LC, index 7, one channel) says one.
    let mut config = vec![0x40, 0x15, 0, 0x18, 0, 0, 0, 0x03, 0x60, 0, 0, 0x7d, 0];
    config.extend([5, 0x80, 0x80, 0x80, 2, 0x13, 0x88]);
    let mut es = vec![0, 0, 0, 4, 0x80, 0x80, 0x80, config.len() as u8];
    es.extend(&config);
    let mut esds = vec![3, 0x80, 0x80, 0x80, es.len() as u8];
    esds.extend(&es);
    let moov = moov_with(&sample_entry(b"mp4a", 2, 22_050, &full(b"esds", &esds)), 22_050, 11_025);
    let track = audio_track(&moov).unwrap().unwrap();
    assert_eq!(
        (track.codec, track.sample_rate, track.channels),
        (Codec::Aac, 22_050, 1)
    );
    // An explicit rate (index 15) and eight channels (configuration 7); 0 keeps the entry's.
    assert_eq!(audio_config(&[0x17, 0x80, 0x56, 0x22, 0x38]), Some((44_100, 8)));
    assert_eq!(audio_config(&[0x10, 0x00]), Some((96_000, 0)));
}
