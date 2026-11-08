//! Which format a file is, where its tags end, and the region of it its audio
//! checksum hashes: from the whole file ([`format_of`], [`audio_region`]), or
//! from its first bytes, its last ones and its length ([`layout`]), so the
//! audio need not be read to know where it is.

use std::ops::Range;

use crate::{Error, Format};

/// How far into a file without an ID3v2 tag an MPEG frame sync is looked for.
const SYNC_SEARCH: usize = 64 * 1024;

/// How many of a file's last bytes [`layout`] needs: an ID3v1 tag (128) and
/// an APEv2 footer (32) before it, which the audio region leaves out.
pub const TAIL_LEN: usize = 160;

/// How many first bytes to give [`layout`] the first time: the MPEG sync
/// search needs as many, and most tags without a large cover fit.
pub const FIRST_HEAD: usize = SYNC_SEARCH;

/// Where a file's tags end and its audio is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileLayout {
    /// The file's format, or `None` for a file the engine does not read (its
    /// region is still given, by the MP3 rule, as [`audio_region`] gives it).
    pub format: Option<Format>,
    /// The first byte after the tags (an ID3v2 tag; FLAC's marker and blocks,
    /// after an optional ID3v2 tag): a save replaces the bytes before it, and
    /// keeps the rest. 0 for an MP3 without an ID3v2 tag.
    pub tags_end: u64,
    /// The bytes the audio checksum hashes.
    pub audio: Range<u64>,
}

/// What [`layout`] found: the layout, or how many first bytes it needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Layout {
    /// The file's layout.
    Known(FileLayout),
    /// Give at least this many first bytes (never more than the file has).
    NeedHead(u64),
}

/// An ID3v2 tag's length by its header, as `jackbird-id3` and
/// `jackbird-flac` read it: a footer only in v2.4.
fn id3_tag_len(bytes: &[u8]) -> usize {
    if bytes.len() < 10 || &bytes[..3] != b"ID3" {
        return 0;
    }
    let size = bytes[6..10]
        .iter()
        .fold(0usize, |size, &byte| size << 7 | (byte & 0x7f) as usize);
    10 + size + if bytes[3] == 4 && bytes[5] & 0x10 != 0 { 10 } else { 0 }
}

/// What walking FLAC's blocks gives.
enum Walk {
    /// The first byte after the last block.
    End(usize),
    /// Needs this many first bytes to go on.
    Need(usize),
}

/// Walks FLAC's block headers from the marker at `marker` to the last block.
fn flac_end(bytes: &[u8], marker: usize, len: usize) -> Walk {
    let mut at = marker + 4;
    loop {
        if at + 4 > len {
            // Truncated: what the file has is all there is.
            return Walk::End(len);
        }
        let Some(header) = bytes.get(at..at + 4) else {
            return Walk::Need(at + 4);
        };
        let length = (header[1] as usize) << 16 | (header[2] as usize) << 8 | header[3] as usize;
        let end = at + 4 + length;
        if header[0] & 0x80 != 0 {
            return if end > len {
                Walk::End(len)
            } else if end > bytes.len() {
                Walk::Need(end)
            } else {
                Walk::End(end)
            };
        }
        at = end;
    }
}

/// Where new tags end by their own header (MP3: the ID3v2 tag's size) or
/// last block (FLAC), whatever bytes follow; `None` when that cannot be
/// told from `bytes`. A save's tags must end exactly where this says.
pub(crate) fn declared_end(bytes: &[u8], format: Format) -> Option<usize> {
    match format {
        Format::Mp3 => (bytes.len() >= 10 && bytes.starts_with(b"ID3")).then(|| id3_tag_len(bytes)),
        Format::Flac => {
            let marker = id3_tag_len(bytes);
            if bytes.get(marker..marker + 4)? != b"fLaC" {
                return None;
            }
            let mut at = marker + 4;
            loop {
                let header = bytes.get(at..at + 4)?;
                let length = (header[1] as usize) << 16 | (header[2] as usize) << 8 | header[3] as usize;
                at += 4 + length;
                if header[0] & 0x80 != 0 {
                    return Some(at);
                }
            }
        }
    }
}

/// The audio region's rule, over the first bytes (`head`), the last ones
/// (`tail`, up to [`TAIL_LEN`]) and the length. FLAC: from the end of the
/// metadata blocks (`flac_audio`, when they read cleanly) to the end of the
/// file. Anything else: `getAudioFrameSlice`'s definition (the web app's
/// before E2), exactly, so the checksums every `.meta/` already holds stay
/// valid: after an ID3v2 tag and its footer; before an ID3v1 tag and then a
/// 32-byte APEv2 footer; the whole file when that leaves nothing.
fn region(head: &[u8], tail: &[u8], length: usize, flac_audio: Option<usize>) -> Range<usize> {
    if let Some(audio) = flac_audio {
        return audio..length;
    }
    // A byte of the file's end, by its position in the file.
    let from_tail = |range: Range<usize>| {
        let offset = length - tail.len();
        tail.get(range.start.checked_sub(offset)?..range.end.checked_sub(offset)?)
    };
    let mut start = 0;
    let mut end = length;
    if length >= 10 && head.len() >= 10 && &head[..3] == b"ID3" {
        let size = ((head[6] as usize & 0x7f) << 21)
            | ((head[7] as usize & 0x7f) << 14)
            | ((head[8] as usize & 0x7f) << 7)
            | (head[9] as usize & 0x7f);
        start = 10 + size + if head[5] & 0x10 != 0 { 10 } else { 0 };
    }
    if end > start + 128 && from_tail(end - 128..end - 125) == Some(b"TAG") {
        end -= 128;
    }
    if end > start + 32 && from_tail(end - 32..end - 24) == Some(b"APETAGEX") {
        end -= 32;
    }
    if start >= end || start >= length {
        return 0..length;
    }
    start..end
}

/// The end of FLAC's metadata, when the whole file is at hand and its blocks
/// read cleanly.
fn flac_audio(bytes: &[u8]) -> Option<usize> {
    jackbird_flac::marker_at(bytes)?;
    jackbird_flac::read(bytes).ok().map(|metadata| metadata.audio)
}

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
    has_sync(&bytes[..bytes.len().min(SYNC_SEARCH)]).then_some(Format::Mp3)
}

fn has_sync(bytes: &[u8]) -> bool {
    bytes.windows(2).any(|pair| pair[0] == 0xff && pair[1] & 0xe0 == 0xe0)
}

/// The bytes the audio checksum hashes, from the whole file (see [`layout`]'s
/// `audio`, which gives the same from its parts).
pub fn audio_region(bytes: &[u8]) -> Range<usize> {
    let tail = &bytes[bytes.len().saturating_sub(TAIL_LEN)..];
    region(bytes, tail, bytes.len(), flac_audio(bytes))
}

/// Where a file's tags end and its audio is, from its first bytes (`head`:
/// [`FIRST_HEAD`] of them to begin with, or the whole file when it is
/// shorter), its last [`TAIL_LEN`] (`tail`, or the whole file when it is
/// shorter) and its length. When `head` is not enough, says how many first
/// bytes it needs: give that many and ask again. The format and the region are
/// those [`format_of`] and [`audio_region`] give on the whole file.
pub fn layout(head: &[u8], tail: &[u8], len: u64) -> Result<Layout, Error> {
    let length = usize::try_from(len).map_err(|_| Error::TooLarge)?;
    if head.len() > length || tail.len() != length.min(TAIL_LEN) {
        return Err(Error::Unreadable(
            "the head or the tail does not fit the file's length".into(),
        ));
    }
    // Asks for `n` first bytes, or the whole file when it is shorter.
    let need = |n: usize| (head.len() < n.min(length)).then(|| Layout::NeedHead(n.min(length) as u64));
    let known = |format: Option<Format>, tags_end: usize, flac: Option<usize>| {
        let audio = region(head, tail, length, flac);
        Ok(Layout::Known(FileLayout {
            format,
            tags_end: tags_end.min(length) as u64,
            audio: audio.start as u64..audio.end as u64,
        }))
    };

    if let Some(more) = need(10) {
        return Ok(more);
    }
    let id3 = id3_tag_len(head);
    // Is `fLaC` after the ID3v2 tag (or at the start)?
    if let Some(more) = need(id3 + 4) {
        return Ok(more);
    }
    if head.get(id3..id3 + 4) == Some(b"fLaC") {
        let end = match flac_end(head, id3, length) {
            Walk::Need(n) => return Ok(need(n).unwrap_or(Layout::NeedHead(n as u64))),
            Walk::End(end) => end,
        };
        let clean = jackbird_flac::read(&head[..end]).ok().map(|metadata| metadata.audio);
        return known(Some(Format::Flac), end, clean);
    }
    if head.starts_with(b"ID3") {
        return known(Some(Format::Mp3), id3, None);
    }
    if let Some(more) = need(SYNC_SEARCH) {
        return Ok(more);
    }
    let format = has_sync(&head[..head.len().min(SYNC_SEARCH)]).then_some(Format::Mp3);
    known(format, 0, None)
}
