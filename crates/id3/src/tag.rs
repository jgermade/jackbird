//! The tag's structure: header, extended header, frames, padding, footer.

use std::borrow::Cow;

use crate::Error;
use crate::sync::{SYNCSAFE_MAX, plain, put_syncsafe, resynchronise, syncsafe, unsynchronise};

/// An ID3v2 major version.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Version {
    /// ID3v2.2: three-letter frame ids, no frame flags.
    V22,
    /// ID3v2.3.
    V23,
    /// ID3v2.4.
    V24,
}

impl Version {
    /// The major version, as the header's fourth byte holds it.
    pub fn major(self) -> u8 {
        match self {
            Version::V22 => 2,
            Version::V23 => 3,
            Version::V24 => 4,
        }
    }
}

/// One frame as it sits in a tag: its id, its two flag bytes (`[0, 0]` in
/// v2.2) and its body, untouched (after undoing a v2.2 or v2.3 tag's
/// unsynchronisation, which covers the whole tag).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    /// Four characters (three in v2.2).
    pub id: String,
    /// The frame's status and format flags, as stored.
    pub flags: [u8; 2],
    /// The frame's bytes after its header, as stored.
    pub body: Vec<u8>,
}

impl Frame {
    /// A frame with no flags.
    pub fn new(id: &str, body: Vec<u8>) -> Self {
        Frame {
            id: id.to_owned(),
            flags: [0, 0],
            body,
        }
    }

    /// Whether the frame asks to be discarded when the tag is altered
    /// (v2.3's and v2.4's "tag alter preservation" flag).
    pub fn discard_on_tag_change(&self, version: Version) -> bool {
        match version {
            Version::V22 => false,
            Version::V23 => self.flags[0] & 0x80 != 0,
            Version::V24 => self.flags[0] & 0x40 != 0,
        }
    }

    /// The frame's content: its body with a v2.4 frame's unsynchronisation
    /// undone (its own flag, or `tag_unsynchronised` for a v2.4 tag whose
    /// header flags it), and the extra bytes its format flags add (a group,
    /// an encryption method, a data length indicator) left out. A compressed
    /// or encrypted frame cannot be read here.
    pub fn content(&self, version: Version, tag_unsynchronised: bool) -> Result<Cow<'_, [u8]>, Error> {
        let format = self.flags[1];
        match version {
            Version::V22 => Ok(Cow::Borrowed(&self.body)),
            Version::V23 => {
                if format & 0x80 != 0 {
                    return Err(Error::Undecodable("compressed"));
                }
                if format & 0x40 != 0 {
                    return Err(Error::Undecodable("encrypted"));
                }
                let skip = usize::from(format & 0x20 != 0);
                self.body
                    .get(skip..)
                    .map(Cow::Borrowed)
                    .ok_or(Error::Malformed("its group byte"))
            }
            Version::V24 => {
                if format & 0x08 != 0 {
                    return Err(Error::Undecodable("compressed"));
                }
                if format & 0x04 != 0 {
                    return Err(Error::Undecodable("encrypted"));
                }
                let body: Cow<'_, [u8]> = if format & 0x02 != 0 || tag_unsynchronised {
                    Cow::Owned(resynchronise(&self.body))
                } else {
                    Cow::Borrowed(&self.body)
                };
                let skip = usize::from(format & 0x40 != 0) + if format & 0x01 != 0 { 4 } else { 0 };
                if body.len() < skip {
                    return Err(Error::Malformed("its group and length bytes"));
                }
                Ok(match body {
                    Cow::Borrowed(bytes) => Cow::Borrowed(&bytes[skip..]),
                    Cow::Owned(mut bytes) => {
                        bytes.drain(..skip);
                        Cow::Owned(bytes)
                    }
                })
            }
        }
    }

    /// This frame with its body unsynchronised and flagged so: what a frame
    /// written into a v2.4 tag whose header says it is unsynchronised needs.
    pub fn unsynchronised(mut self) -> Self {
        self.body = unsynchronise(&self.body);
        self.flags[1] |= 0x02;
        self
    }
}

/// A tag read from the start of a file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tag {
    /// Its major version.
    pub version: Version,
    /// Its revision (the header's fifth byte).
    pub revision: u8,
    /// The header's flags, as read.
    pub flags: u8,
    /// Its frames, in order.
    pub frames: Vec<Frame>,
    /// How many bytes the tag takes at the start of the file: header, body
    /// and a v2.4 footer. The audio (or whatever follows) starts there.
    pub len: usize,
    /// The zero bytes after the last frame.
    pub padding: usize,
    /// Whether the frames ended cleanly: at the body's end, or in zeros. A
    /// tag that does not (a frame running past the end, or something that is
    /// neither a frame nor padding) gives the frames before the trouble.
    pub clean: bool,
    /// Whether a v2.4 tag's frame sizes were read as plain integers, as some
    /// old writers (iTunes) wrote them, because syncsafe ones did not end
    /// cleanly. Writing the tag again writes them syncsafe.
    pub plain_sizes: bool,
}

impl Tag {
    /// Whether a v2.4 tag's header says every frame is unsynchronised.
    pub fn unsynchronised_v24(&self) -> bool {
        self.version == Version::V24 && self.flags & 0x80 != 0
    }
}

/// How many bytes the ID3v2 tag at the start of `bytes` takes (header, body,
/// a v2.4 footer), from its header alone; `None` without one.
pub fn tag_len(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 10 || &bytes[..3] != b"ID3" {
        return None;
    }
    let footer = if bytes[3] == 4 && bytes[5] & 0x10 != 0 { 10 } else { 0 };
    Some(10 + syncsafe(&bytes[6..10]) + footer)
}

/// Reads the ID3v2 tag at the start of `bytes`: `None` without one.
///
/// A v2.2 or v2.3 tag's unsynchronisation is undone; an extended header is
/// skipped; a v2.4 tag whose frame sizes do not end cleanly as syncsafe
/// integers is read again with plain ones. Frames are not parsed: each keeps
/// its bytes.
pub fn read(bytes: &[u8]) -> Result<Option<Tag>, Error> {
    if bytes.len() < 10 || &bytes[..3] != b"ID3" {
        return Ok(None);
    }
    let version = match bytes[3] {
        2 => Version::V22,
        3 => Version::V23,
        4 => Version::V24,
        other => return Err(Error::UnsupportedVersion(other)),
    };
    let revision = bytes[4];
    let flags = bytes[5];
    let size = syncsafe(&bytes[6..10]);
    let end = 10 + size;
    let len = end
        + if version == Version::V24 && flags & 0x10 != 0 {
            10
        } else {
            0
        };
    if len > bytes.len() {
        return Err(Error::Truncated);
    }
    if version == Version::V22 && flags & 0x40 != 0 {
        return Err(Error::CompressedTag);
    }
    let body: Cow<'_, [u8]> = if version != Version::V24 && flags & 0x80 != 0 {
        Cow::Owned(resynchronise(&bytes[10..end]))
    } else {
        Cow::Borrowed(&bytes[10..end])
    };
    let start = if version != Version::V22 && flags & 0x40 != 0 {
        if body.len() < 4 {
            return Err(Error::ExtendedHeader);
        }
        let extended = if version == Version::V23 {
            plain(&body) + 4
        } else {
            syncsafe(&body)
        };
        if extended > body.len() {
            return Err(Error::ExtendedHeader);
        }
        extended
    } else {
        0
    };

    let (walk, plain_sizes) = match version {
        Version::V22 => (walk(&body, start, Sizes::V22), false),
        Version::V23 => (walk(&body, start, Sizes::Plain), false),
        Version::V24 => {
            let synced = walk(&body, start, Sizes::Syncsafe);
            if synced.clean {
                (synced, false)
            } else {
                let plain = walk(&body, start, Sizes::Plain);
                if plain.clean { (plain, true) } else { (synced, false) }
            }
        }
    };
    Ok(Some(Tag {
        version,
        revision,
        flags,
        padding: if walk.clean { body.len() - walk.end } else { 0 },
        frames: walk.frames,
        len,
        clean: walk.clean,
        plain_sizes,
    }))
}

#[derive(Clone, Copy)]
enum Sizes {
    V22,
    Plain,
    Syncsafe,
}

struct Walk {
    frames: Vec<Frame>,
    end: usize,
    clean: bool,
}

fn is_id(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

/// The frames of a tag's body from `start`, until something is not a frame.
fn walk(body: &[u8], start: usize, sizes: Sizes) -> Walk {
    let (id_len, header) = match sizes {
        Sizes::V22 => (3, 6),
        _ => (4, 10),
    };
    let mut frames = Vec::new();
    let mut at = start;
    while at + header <= body.len() && is_id(&body[at..at + id_len]) {
        let size = match sizes {
            Sizes::V22 => (body[at + 3] as usize) << 16 | (body[at + 4] as usize) << 8 | body[at + 5] as usize,
            Sizes::Plain => plain(&body[at + 4..]),
            Sizes::Syncsafe => syncsafe(&body[at + 4..]),
        };
        let from = at + header;
        if from + size > body.len() {
            return Walk {
                frames,
                end: at,
                clean: false,
            };
        }
        let id = String::from_utf8_lossy(&body[at..at + id_len]).into_owned();
        let flags = if id_len == 4 {
            [body[at + 8], body[at + 9]]
        } else {
            [0, 0]
        };
        frames.push(Frame {
            id,
            flags,
            body: body[from..from + size].to_vec(),
        });
        at = from + size;
    }
    let clean = body[at..].iter().all(|&byte| byte == 0);
    Walk { frames, end: at, clean }
}

/// A tag holding `frames` and `padding` zero bytes, in v2.3 or v2.4, with no
/// extended header and no footer. Of `flags`, only a v2.4 tag's
/// unsynchronisation flag (`0x80`) is kept: the frames must then be
/// unsynchronised already (see [`Frame::unsynchronised`]).
pub fn write(version: Version, flags: u8, frames: &[Frame], padding: usize) -> Result<Vec<u8>, Error> {
    let flags = match version {
        Version::V22 => return Err(Error::UnsupportedVersion(2)),
        Version::V23 => 0,
        Version::V24 => flags & 0x80,
    };
    let size = frames.iter().map(|frame| 10 + frame.body.len()).sum::<usize>() + padding;
    if size > SYNCSAFE_MAX {
        return Err(Error::TooLarge);
    }
    let mut out = Vec::with_capacity(10 + size);
    out.extend_from_slice(b"ID3");
    out.extend_from_slice(&[version.major(), 0, flags]);
    out.extend_from_slice(&put_syncsafe(size));
    for frame in frames {
        let id = frame.id.as_bytes();
        if id.len() != 4 || !is_id(id) {
            return Err(Error::Malformed("a four-character id"));
        }
        out.extend_from_slice(id);
        let length = frame.body.len();
        if version == Version::V24 {
            out.extend_from_slice(&put_syncsafe(length));
        } else {
            out.extend_from_slice(&(length as u32).to_be_bytes());
        }
        out.extend_from_slice(&frame.flags);
        out.extend_from_slice(&frame.body);
    }
    out.resize(10 + size, 0);
    Ok(out)
}
