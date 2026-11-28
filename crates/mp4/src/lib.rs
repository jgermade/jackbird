//! MPEG-4 audio (`.m4a`): its boxes (atoms), its iTunes-style tags item by item, and its audio
//! track.
//!
//! A file is a tree of boxes: `ftyp`, `moov` (the description: the tracks, their sample tables,
//! and the tags under `moov/udta/meta/ilst`), `mdat` (the audio), `free` (room). This crate reads
//! box headers from any bytes it is given ([`header`], [`top_level`]), a box's children
//! ([`children`]), the tags as their items ([`items`]: each item's `data` atoms, and for a
//! freeform `----` its `mean` and `name`, with where each item lies so a writer can keep it byte
//! for byte), and the audio track's codec, rates and length ([`audio_track`]). Nothing in an item
//! is interpreted: which item is which field is the tag engine's (`crates/tags`).
//!
//! Written from the specifications (ISO/IEC 14496-12 for the boxes, 14496-14 and 14496-1 for the
//! sample entry and its descriptors, Apple's QuickTime File Format for `meta`/`ilst` and the
//! data types, Apple's ALAC for its magic cookie). No I/O, no dependencies. See
//! `RECORD/2026-11-28.aac-m4a.WIP.md`.

mod track;

use std::fmt;
use std::ops::Range;

pub use track::{Codec, Track, audio_track};

/// A box's four-letter type (`©` is the byte 0xA9).
pub type Kind = [u8; 4];

/// Why bytes could not be read as boxes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// A box's size is smaller than its header, or runs past what holds it.
    BadSize {
        /// The box's type.
        kind: Kind,
        /// Where it starts, in what was given.
        at: u64,
    },
    /// The bytes end inside a box's header, or a box that must be read whole.
    Truncated(&'static str),
    /// A box that must be there is not (`moov`'s `trak`, `stsd`'s entry…).
    Missing(&'static str),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::BadSize { kind, at } => write!(f, "the box {} at {at} has a size that does not fit", name(kind)),
            Error::Truncated(what) => write!(f, "{what} is cut short"),
            Error::Missing(what) => write!(f, "no {what}"),
        }
    }
}

impl std::error::Error for Error {}

/// A type as text, for messages: `©nam`, `moov`.
pub fn name(kind: &Kind) -> String {
    kind.iter().map(|&byte| char::from(byte)).collect()
}

/// A box's header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    /// Its type.
    pub kind: Kind,
    /// Its header's length: 8, or 16 with a 64-bit size.
    pub header_len: u64,
    /// Its whole size, header included (a size of 0, "to the end", resolved).
    pub size: u64,
}

impl Header {
    /// Its content's range, from `start` (where the box starts).
    pub fn content(&self, start: u64) -> Range<u64> {
        start + self.header_len..start + self.size
    }
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn u64_at(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(bytes.get(at..at + 8)?.try_into().ok()?))
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

/// The header of the box `bytes` starts with, where `remaining` bytes are left before what holds
/// it ends (the file, or the parent box). `Ok(None)` when `bytes` ends inside the header: give
/// 16 bytes from the box's start to be sure.
pub fn header(bytes: &[u8], remaining: u64, at: u64) -> Result<Option<Header>, Error> {
    let (Some(size), Some(kind)) = (u32_at(bytes, 0), bytes.get(4..8)) else {
        return Ok(None);
    };
    let kind: Kind = kind.try_into().unwrap_or_default();
    let (size, header_len) = match size {
        0 => (remaining, 8),
        1 => match u64_at(bytes, 8) {
            Some(large) => (large, 16),
            None => return Ok(None),
        },
        size => (u64::from(size), 8),
    };
    if size < header_len || size > remaining {
        return Err(Error::BadSize { kind, at });
    }
    Ok(Some(Header { kind, header_len, size }))
}

/// A box placed in a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placed {
    /// Where it starts.
    pub start: u64,
    /// Its header.
    pub header: Header,
}

impl Placed {
    /// Where its content is.
    pub fn content(&self) -> Range<u64> {
        self.header.content(self.start)
    }

    /// Where it ends.
    pub fn end(&self) -> u64 {
        self.start + self.header.size
    }
}

/// The top-level boxes of a file `len` bytes long whose headers are in `head` (its first bytes):
/// each in order, and where the first header not in `head` starts (`None` once the boxes reach the
/// file's end). A box's content need not be in `head`.
pub fn top_level(head: &[u8], len: u64) -> Result<(Vec<Placed>, Option<u64>), Error> {
    let mut found = Vec::new();
    let mut at = 0u64;
    while at < len {
        let Some(from) = usize::try_from(at).ok().and_then(|at| head.get(at..)) else {
            return Ok((found, Some(at)));
        };
        let Some(header) = header(from, len - at, at)? else {
            return Ok((found, Some(at)));
        };
        found.push(Placed { start: at, header });
        at += header.size;
    }
    Ok((found, None))
}

/// A box within bytes held whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Child<'a> {
    /// Its type.
    pub kind: Kind,
    /// Where it starts and ends in the bytes given.
    pub range: (usize, usize),
    /// Its content.
    pub body: &'a [u8],
}

/// The boxes `bytes` is made of, every byte of it: the content of a box whose children are boxes.
pub fn children(bytes: &[u8]) -> Result<Vec<Child<'_>>, Error> {
    let mut found = Vec::new();
    let mut at = 0usize;
    while at < bytes.len() {
        let remaining = (bytes.len() - at) as u64;
        let header = header(&bytes[at..], remaining, at as u64)?.ok_or(Error::Truncated("a box's header"))?;
        let end = at + header.size as usize;
        found.push(Child {
            kind: header.kind,
            range: (at, end),
            body: &bytes[at + header.header_len as usize..end],
        });
        at = end;
    }
    Ok(found)
}

/// The first child of type `kind` among `bytes`' boxes.
pub fn child<'a>(bytes: &'a [u8], kind: &Kind) -> Result<Option<Child<'a>>, Error> {
    Ok(children(bytes)?.into_iter().find(|child| child.kind == *kind))
}

/// The box at the end of a path of types from `bytes` (`[b"udta", b"meta"]`), with each box's
/// content as the next one's bytes; `meta` is entered past its version and flags when it has them.
pub fn path<'a>(bytes: &'a [u8], kinds: &[&Kind]) -> Result<Option<Child<'a>>, Error> {
    let mut within = bytes;
    let mut last = None;
    for kind in kinds {
        let Some(found) = child(within, kind)? else {
            return Ok(None);
        };
        within = if found.kind == *b"meta" {
            meta_children(found.body)
        } else {
            found.body
        };
        last = Some(found);
    }
    Ok(last)
}

/// `meta`'s children: past its version and flags (ISO's full box, as iTunes writes it), or from its
/// start (QuickTime's plain box), told by whether a `hdlr` box follows at once.
pub fn meta_children(body: &[u8]) -> &[u8] {
    if body.get(4..8) == Some(b"hdlr") {
        body
    } else {
        body.get(4..).unwrap_or_default()
    }
}

/// Whether `meta`'s content is QuickTime's form (no version and flags).
pub fn meta_is_quicktime(body: &[u8]) -> bool {
    body.get(4..8) == Some(b"hdlr")
}

/// The type of a `data` atom's value (Apple's well-known types).
pub mod data_type {
    /// No type: the value's meaning is the item's (`trkn`, `disk`, `gnre`).
    pub const IMPLICIT: u32 = 0;
    /// UTF-8 text.
    pub const UTF8: u32 = 1;
    /// UTF-16 text, big-endian.
    pub const UTF16: u32 = 2;
    /// A JPEG image.
    pub const JPEG: u32 = 13;
    /// A PNG image.
    pub const PNG: u32 = 14;
    /// A signed big-endian integer, 1 to 8 bytes.
    pub const INTEGER: u32 = 21;
    /// An unsigned big-endian integer, 1 to 8 bytes.
    pub const UNSIGNED: u32 = 22;
    /// A BMP image.
    pub const BMP: u32 = 27;
}

/// A `data` atom: its value's type, its locale, its value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Data {
    /// The type ([`data_type`]): the low 24 bits of its first word.
    pub kind: u32,
    /// Its locale (0: none).
    pub locale: u32,
    /// The value's bytes.
    pub value: Vec<u8>,
}

impl Data {
    /// The value as text: UTF-8 (invalid bytes replaced), UTF-16 for that type.
    pub fn text(&self) -> String {
        if self.kind == data_type::UTF16 {
            let units: Vec<u16> = self
                .value
                .chunks_exact(2)
                .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                .collect();
            return String::from_utf16_lossy(&units);
        }
        String::from_utf8_lossy(&self.value).into_owned()
    }

    /// The value as a big-endian integer of up to 8 bytes; `None` for an empty or longer one.
    pub fn integer(&self) -> Option<u64> {
        if self.value.is_empty() || self.value.len() > 8 {
            return None;
        }
        Some(
            self.value
                .iter()
                .fold(0u64, |number, &byte| number << 8 | u64::from(byte)),
        )
    }
}

/// One item of `ilst`: its type, for a freeform `----` its `mean` and `name`, its `data` atoms, and
/// where it lies in `ilst`'s content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    /// Its type (`©nam`, `trkn`, `----`).
    pub kind: Kind,
    /// A freeform item's namespace (`com.apple.iTunes`).
    pub mean: Option<String>,
    /// A freeform item's name (`iTunSMPB`).
    pub name: Option<String>,
    /// Its values, in order.
    pub data: Vec<Data>,
    /// Where it starts and ends in `ilst`'s content.
    pub range: (usize, usize),
}

/// A `mean` or `name` atom's text: past its version and flags.
fn label(body: &[u8]) -> String {
    String::from_utf8_lossy(body.get(4..).unwrap_or_default()).into_owned()
}

/// `ilst`'s items, from its content. An item whose own atoms cannot be read is still listed (its
/// type and place), with no values.
pub fn items(ilst: &[u8]) -> Result<Vec<Item>, Error> {
    Ok(children(ilst)?
        .into_iter()
        .map(|item| {
            let mut found = Item {
                kind: item.kind,
                mean: None,
                name: None,
                data: Vec::new(),
                range: item.range,
            };
            for atom in children(item.body).unwrap_or_default() {
                match &atom.kind {
                    b"data" if atom.body.len() >= 8 => found.data.push(Data {
                        kind: u32_at(atom.body, 0).unwrap_or_default() & 0x00ff_ffff,
                        locale: u32_at(atom.body, 4).unwrap_or_default(),
                        value: atom.body[8..].to_vec(),
                    }),
                    b"mean" => found.mean = Some(label(atom.body)),
                    b"name" => found.name = Some(label(atom.body)),
                    _ => {}
                }
            }
            found
        })
        .collect())
}

/// Where a file's tags are in `moov`'s content: `udta`, `meta` and `ilst`, each as a range of
/// `moov`'s content, when the file has them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TagsAt {
    /// `moov/udta`.
    pub udta: Option<(usize, usize)>,
    /// `moov/udta/meta`.
    pub meta: Option<(usize, usize)>,
    /// `moov/udta/meta/ilst`.
    pub ilst: Option<(usize, usize)>,
    /// Whether `meta` is QuickTime's form, with no version and flags.
    pub quicktime_meta: bool,
}

/// Where `moov`'s tags are, from its content.
pub fn tags_at(moov: &[u8]) -> Result<TagsAt, Error> {
    let mut found = TagsAt::default();
    let Some(udta) = child(moov, b"udta")? else {
        return Ok(found);
    };
    found.udta = Some(udta.range);
    let udta_content = udta.range.0 + (udta.range.1 - udta.range.0 - udta.body.len());
    let Some(meta) = child(udta.body, b"meta")? else {
        return Ok(found);
    };
    let meta_start = udta_content + meta.range.0;
    found.meta = Some((meta_start, udta_content + meta.range.1));
    found.quicktime_meta = meta_is_quicktime(meta.body);
    let meta_content = meta_start + (meta.range.1 - meta.range.0 - meta.body.len());
    let skip = if found.quicktime_meta { 0 } else { 4 };
    let Some(ilst) = child(meta_children(meta.body), b"ilst")? else {
        return Ok(found);
    };
    found.ilst = Some((meta_content + skip + ilst.range.0, meta_content + skip + ilst.range.1));
    Ok(found)
}

/// `moov`'s tags as items: none when it has no `ilst`.
pub fn tags(moov: &[u8]) -> Result<Vec<Item>, Error> {
    match tags_at(moov)?.ilst {
        Some((start, end)) => {
            let header =
                header(&moov[start..end], (end - start) as u64, start as u64)?.ok_or(Error::Truncated("ilst"))?;
            items(&moov[start + header.header_len as usize..end])
        }
        None => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests;
