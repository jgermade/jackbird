//! Which format a file is, and the region of it its audio checksum hashes.

use std::ops::Range;

use crate::Format;

/// How far into a file without an ID3v2 tag an MPEG frame sync is looked for.
const SYNC_SEARCH: usize = 64 * 1024;

/// The format of a file's bytes: FLAC when `fLaC` starts it (after an
/// optional ID3v2 tag); MP3 when an ID3v2 tag does, or an MPEG frame sync is
/// found near the start; else `None`.
pub fn format_of(bytes: &[u8]) -> Option<Format> {
    if jackbird_flac::marker_at(bytes).is_some() {
        return Some(Format::Flac);
    }
    if bytes.starts_with(b"ID3") {
        return Some(Format::Mp3);
    }
    let head = &bytes[..bytes.len().min(SYNC_SEARCH)];
    head.windows(2)
        .any(|pair| pair[0] == 0xff && pair[1] & 0xe0 == 0xe0)
        .then_some(Format::Mp3)
}

/// The bytes the audio checksum hashes. FLAC: from the end of the metadata
/// blocks to the end of the file. Anything else: `getAudioFrameSlice`'s
/// definition (`src/lib/id3.ts`), exactly, so the checksums every `.meta/`
/// already holds stay valid: after an ID3v2 tag and its footer; before an
/// ID3v1 tag and then a 32-byte APEv2 footer; the whole file when that leaves
/// nothing.
pub fn audio_region(bytes: &[u8]) -> Range<usize> {
    if jackbird_flac::marker_at(bytes).is_some()
        && let Ok(metadata) = jackbird_flac::read(bytes)
    {
        return metadata.audio..bytes.len();
    }
    let length = bytes.len();
    let mut start = 0;
    let mut end = length;
    if length >= 10 && &bytes[..3] == b"ID3" {
        let size = ((bytes[6] as usize & 0x7f) << 21)
            | ((bytes[7] as usize & 0x7f) << 14)
            | ((bytes[8] as usize & 0x7f) << 7)
            | (bytes[9] as usize & 0x7f);
        start = 10 + size + if bytes[5] & 0x10 != 0 { 10 } else { 0 };
    }
    if end > start + 128 && &bytes[end - 128..end - 125] == b"TAG" {
        end -= 128;
    }
    if end > start + 32 && &bytes[end - 32..end - 24] == b"APETAGEX" {
        end -= 32;
    }
    if start >= end || start >= length {
        return 0..length;
    }
    start..end
}
