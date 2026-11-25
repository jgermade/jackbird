//! A text of one's own, and a file's identifier: `TXXX` (v2.3, v2.4) or `TXX` (v2.2), an encoding
//! byte, a description ended by a terminator, and the value; `UFID` (`UFI` in v2.2), an owner's
//! identifier (ISO-8859-1, ended by `$00`) and up to 64 bytes. MusicBrainz' ids are kept in both
//! (`TXXX:MusicBrainz Album Id`, …, and the recording's in `UFID` owned by
//! `http://musicbrainz.org`), as Picard writes them.

use crate::text::{decode_one, latin1, split_terminated};
use crate::{Error, Version};

/// A `TXXX` frame's content: its description (the key) and its value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserText {
    /// The description, which tells one `TXXX` from another.
    pub description: String,
    /// The value: several, separated by `$00` in v2.4, are joined by `/`.
    pub value: String,
}

/// The text in a `TXXX` frame's content.
pub fn decode_user_text(content: &[u8]) -> Result<UserText, Error> {
    let (&encoding, rest) = content.split_first().ok_or(Error::Malformed("a user text"))?;
    let (description, mut value) = split_terminated(rest, encoding);
    let mut values = Vec::new();
    loop {
        let (one, after) = split_terminated(value, encoding);
        values.push(decode_one(one, encoding));
        if after.is_empty() {
            break;
        }
        value = after;
    }
    Ok(UserText {
        description: decode_one(description, encoding),
        value: values.join("/"),
    })
}

/// A `TXXX` frame's content holding `text`: ISO-8859-1 when it all fits in it, else UTF-8 (v2.4) or
/// UTF-16 with its byte order mark (v2.3).
pub fn encode_user_text(text: &UserText, version: Version) -> Vec<u8> {
    let latin = text
        .description
        .chars()
        .chain(text.value.chars())
        .all(|c| u32::from(c) <= 0xff);
    let encoding: u8 = if latin {
        0
    } else if version == Version::V24 {
        3
    } else {
        1
    };
    let mut out = Vec::with_capacity(text.description.len() * 2 + text.value.len() * 2 + 6);
    out.push(encoding);
    for (value, terminated) in [(&text.description, true), (&text.value, false)] {
        match encoding {
            0 => {
                out.extend(value.chars().map(|c| c as u8));
                if terminated {
                    out.push(0);
                }
            }
            3 => {
                out.extend_from_slice(value.as_bytes());
                if terminated {
                    out.push(0);
                }
            }
            _ => {
                out.extend_from_slice(&[0xff, 0xfe]);
                out.extend(value.encode_utf16().flat_map(u16::to_le_bytes));
                if terminated {
                    out.extend_from_slice(&[0, 0]);
                }
            }
        }
    }
    out
}

/// A `UFID` frame's content: its owner and its identifier.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileId {
    /// Who the identifier is of: a URL or an email (`http://musicbrainz.org`).
    pub owner: String,
    /// The identifier, up to 64 bytes (MusicBrainz': the recording's id as ASCII).
    pub identifier: Vec<u8>,
}

/// The identifier in a `UFID` frame's content.
pub fn decode_file_id(content: &[u8]) -> Result<FileId, Error> {
    let at = content
        .iter()
        .position(|&byte| byte == 0)
        .ok_or(Error::Malformed("a file identifier"))?;
    Ok(FileId {
        owner: latin1(&content[..at]),
        identifier: content[at + 1..].to_vec(),
    })
}

/// A `UFID` frame's content holding `id` (its owner in ISO-8859-1: other characters become `?`;
/// its identifier cut at 64 bytes).
pub fn encode_file_id(id: &FileId) -> Vec<u8> {
    let mut out: Vec<u8> = id
        .owner
        .chars()
        .map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?'))
        .collect();
    out.push(0);
    out.extend_from_slice(&id.identifier[..id.identifier.len().min(64)]);
    out
}
