//! FLAC metadata: the blocks before the audio, kept byte for byte, the Vorbis
//! comments as their raw entries, and pictures.
//!
//! A file is read into its metadata blocks as they are stored (`kind`,
//! `body`) and where its audio starts; nothing in a block is parsed unless
//! asked. Vorbis comments are kept as the bytes of each entry, so an entry
//! with no `=`, invalid UTF-8 or an odd key goes back as it came.
//!
//! Written from the specifications (RFC 9639 for FLAC, Xiph's Vorbis comment
//! specification). No I/O, no dependencies. See
//! `RECORD/2026-08-11.musikmatch-rust-migration.WIP.md` (21:45 to 22:20).

mod comments;
mod picture;

use std::fmt;

pub use comments::{Comments, entry, key};
pub use picture::{Picture, decode_picture, encode_picture, image_size};

/// `STREAMINFO`, which must come first.
pub const STREAMINFO: u8 = 0;
/// `PADDING`.
pub const PADDING: u8 = 1;
/// `VORBIS_COMMENT`.
pub const VORBIS_COMMENT: u8 = 4;
/// `PICTURE`.
pub const PICTURE: u8 = 6;

/// The largest body a block's 24-bit length can say.
pub const BLOCK_MAX: usize = 0xff_ffff;

/// Why metadata could not be read or written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// No `fLaC` marker (after an optional ID3v2 tag).
    NotFlac,
    /// The blocks run past the end of the bytes, or the last one is never flagged.
    Truncated,
    /// The first block is not `STREAMINFO`, or a block's type is the invalid 127.
    Malformed(&'static str),
    /// A block would be larger than its 24-bit length can say.
    TooLarge,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotFlac => write!(f, "not a FLAC file"),
            Error::Truncated => write!(f, "the metadata blocks run past the end of the file"),
            Error::Malformed(what) => write!(f, "the metadata is malformed: {what}"),
            Error::TooLarge => write!(f, "a metadata block would be larger than FLAC allows"),
        }
    }
}

impl std::error::Error for Error {}

/// One metadata block: its type and its body, as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    /// The block type (0 `STREAMINFO`, 1 `PADDING`, 4 `VORBIS_COMMENT`, 6 `PICTURE`…).
    pub kind: u8,
    /// The block's bytes after its four-byte header.
    pub body: Vec<u8>,
}

/// A FLAC file's metadata.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Metadata {
    /// Where `fLaC` starts: after an ID3v2 tag some writers put first, else 0.
    pub start: usize,
    /// The blocks, in order.
    pub blocks: Vec<Block>,
    /// Where the audio starts: right after the last block.
    pub audio: usize,
}

impl Metadata {
    /// The bytes the marker and the blocks take.
    pub fn len(&self) -> usize {
        self.audio - self.start
    }

    /// Whether there are no blocks (never, for metadata `read` returns).
    pub fn is_empty(&self) -> bool {
        self.blocks.is_empty()
    }
}

/// How many bytes an ID3v2 tag at the start of `bytes` takes, from its header.
fn id3_len(bytes: &[u8]) -> usize {
    if bytes.len() < 10 || &bytes[..3] != b"ID3" {
        return 0;
    }
    let size = bytes[6..10]
        .iter()
        .fold(0usize, |size, &byte| size << 7 | (byte & 0x7f) as usize);
    10 + size + if bytes[3] == 4 && bytes[5] & 0x10 != 0 { 10 } else { 0 }
}

/// Where `fLaC` is in `bytes` (after an optional ID3v2 tag), if it is.
pub fn marker_at(bytes: &[u8]) -> Option<usize> {
    let start = id3_len(bytes);
    (bytes.get(start..start + 4)? == b"fLaC").then_some(start)
}

/// Reads a FLAC file's metadata blocks.
pub fn read(bytes: &[u8]) -> Result<Metadata, Error> {
    let start = marker_at(bytes).ok_or(Error::NotFlac)?;
    let mut at = start + 4;
    let mut blocks = Vec::new();
    loop {
        let header = bytes.get(at..at + 4).ok_or(Error::Truncated)?;
        let last = header[0] & 0x80 != 0;
        let kind = header[0] & 0x7f;
        let length = (header[1] as usize) << 16 | (header[2] as usize) << 8 | header[3] as usize;
        if kind == 127 {
            return Err(Error::Malformed("a block of the invalid type 127"));
        }
        if blocks.is_empty() && kind != STREAMINFO {
            return Err(Error::Malformed("the first block is not STREAMINFO"));
        }
        let body = bytes.get(at + 4..at + 4 + length).ok_or(Error::Truncated)?;
        blocks.push(Block {
            kind,
            body: body.to_vec(),
        });
        at += 4 + length;
        if last {
            return Ok(Metadata {
                start,
                blocks,
                audio: at,
            });
        }
    }
}

/// `fLaC` and `blocks`, the last one flagged as such.
pub fn write(blocks: &[Block]) -> Result<Vec<u8>, Error> {
    let mut out = Vec::with_capacity(4 + blocks.iter().map(|block| 4 + block.body.len()).sum::<usize>());
    out.extend_from_slice(b"fLaC");
    for (index, block) in blocks.iter().enumerate() {
        let length = block.body.len();
        if length > BLOCK_MAX {
            return Err(Error::TooLarge);
        }
        let last = if index + 1 == blocks.len() { 0x80 } else { 0 };
        out.push(last | (block.kind & 0x7f));
        out.extend_from_slice(&[(length >> 16) as u8, (length >> 8) as u8, length as u8]);
        out.extend_from_slice(&block.body);
    }
    Ok(out)
}

/// `blocks` (with no padding among them) and a `PADDING` block last, sized so
/// the marker and the blocks take exactly `room` bytes, so the audio stays
/// where it was. When they do not fit in `room`, or leave less than a block
/// header's four bytes over, the padding is `fallback` bytes instead and the
/// audio moves. Exactly `room` needs no padding block.
pub fn with_padding(mut blocks: Vec<Block>, room: usize, fallback: usize) -> Vec<Block> {
    let used = 4 + blocks.iter().map(|block| 4 + block.body.len()).sum::<usize>();
    let padding = if used == room {
        None
    } else if used + 4 <= room && room - used - 4 <= BLOCK_MAX {
        Some(room - used - 4)
    } else {
        Some(fallback)
    };
    if let Some(length) = padding {
        blocks.push(Block {
            kind: PADDING,
            body: vec![0; length],
        });
    }
    blocks
}

#[cfg(test)]
mod tests;
