//! Decoding gives the file's own samples: for FLAC, exactly the PCM whose MD5 is in its STREAMINFO
//! and that `ffmpeg` decodes; for MP3, its length without the encoder's delay and padding.

mod common;

use common::{case, decode_all, md5_hex, pcm_bytes};

#[test]
fn flac_gives_the_pcm_of_its_streaminfo_and_of_ffmpeg() {
    for name in ["flac-24-96.flac", "flac-24-96-b.flac", "flac-16-44.flac"] {
        let expected = case(name);
        let (source, samples) = decode_all(name);
        let format = source.format();
        assert_eq!(u64::from(format.rate), expected["rate"].as_u64().unwrap(), "{name}");
        assert_eq!(
            u64::from(format.channels),
            expected["channels"].as_u64().unwrap(),
            "{name}"
        );
        assert_eq!(u64::from(format.bits), expected["bits"].as_u64().unwrap(), "{name}");
        assert_eq!(source.codec(), "FLAC");
        let frames = expected["frames"].as_u64().unwrap();
        assert_eq!(samples.len() as u64, frames * 2, "{name}: every frame");
        assert_eq!(source.frames(), Some(frames), "{name}");
        let pcm = pcm_bytes(&samples, format.bits);
        let md5 = md5_hex(&pcm);
        assert_eq!(md5, expected["md5"].as_str().unwrap(), "{name}: ffmpeg's PCM");
        let streaminfo = source.md5().expect("the encoder wrote the MD5");
        assert_eq!(md5, md5_hex_of(streaminfo), "{name}: STREAMINFO's MD5");
    }
}

fn md5_hex_of(md5: [u8; 16]) -> String {
    md5.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn the_24_bit_samples_use_their_24_bits() {
    let (_, samples) = decode_all("flac-24-96.flac");
    let top = samples.iter().map(|sample| sample.unsigned_abs()).max().unwrap();
    // A tone at half scale: about 2^22, never past 2^23.
    assert!(top > 1 << 21 && top < 1 << 23, "{top}");
    assert!(
        samples.iter().any(|sample| sample & 0xff != 0),
        "the low bits are there"
    );
}

#[test]
fn mp3_decodes_at_24_bits_without_delay_or_padding() {
    let expected = case("mp3-44.mp3");
    let (source, samples) = decode_all("mp3-44.mp3");
    let format = source.format();
    assert_eq!(format.rate, 44100);
    assert_eq!(format.channels, 2);
    assert_eq!(format.bits, 24);
    assert_eq!(source.codec(), "MP3");
    assert_eq!(samples.len() as u64, expected["frames"].as_u64().unwrap() * 2);
}

#[test]
fn a_seek_lands_on_the_frame() {
    let (_, whole) = decode_all("flac-24-96.flac");
    let mut source = jackbird_audio::Source::open(&common::fixture("flac-24-96.flac")).unwrap();
    let frame = source.seek(0.1).unwrap();
    assert_eq!(frame, 9600);
    let mut rest = Vec::new();
    while let Some(block) = source.next_block().unwrap() {
        rest.extend_from_slice(block);
    }
    assert_eq!(rest, whole[9600 * 2..], "from the frame on, the same samples");
}

#[test]
fn a_file_that_is_not_audio_is_refused() {
    let path = std::env::temp_dir().join("jackbird-audio-not-audio.flac");
    std::fs::write(&path, b"not audio at all").unwrap();
    assert!(jackbird_audio::Source::open(&path).is_err());
    let _ = std::fs::remove_file(path);
}
