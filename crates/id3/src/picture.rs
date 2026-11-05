//! Attached pictures: `APIC` (v2.3, v2.4) and `PIC` (v2.2).

use crate::text::{decode_one, latin1, split_terminated};
use crate::{Error, Version};

/// A picture frame's content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Picture {
    /// Its MIME type (`image/jpeg`); v2.2's three-letter format becomes one.
    pub mime: String,
    /// The picture type: 3 is the front cover, 4 the back cover, 0 "other".
    pub kind: u8,
    /// Its description.
    pub description: String,
    /// The image's bytes.
    pub data: Vec<u8>,
}

/// The picture in an `APIC` frame's content (v2.3, v2.4) or a `PIC` one's
/// (v2.2).
pub fn decode_picture(content: &[u8], version: Version) -> Result<Picture, Error> {
    let (&encoding, rest) = content.split_first().ok_or(Error::Malformed("a picture"))?;
    let (mime, rest) = if version == Version::V22 {
        if rest.len() < 3 {
            return Err(Error::Malformed("a picture"));
        }
        let format = latin1(&rest[..3]).to_ascii_lowercase();
        let mime = match format.as_str() {
            "jpg" => "image/jpeg".to_owned(),
            "-->" => "-->".to_owned(),
            other => format!("image/{other}"),
        };
        (mime, &rest[3..])
    } else {
        let (mime, rest) = split_terminated(rest, 0);
        (latin1(mime), rest)
    };
    let (&kind, rest) = rest.split_first().ok_or(Error::Malformed("a picture"))?;
    let (description, data) = split_terminated(rest, encoding);
    Ok(Picture {
        mime,
        kind,
        description: decode_one(description, encoding),
        data: data.to_vec(),
    })
}

/// An `APIC` frame's content holding `picture`, for v2.3 or v2.4: the
/// description in ISO-8859-1 when it fits, else UTF-8 (v2.4) or UTF-16
/// (v2.3).
pub fn encode_picture(picture: &Picture, version: Version) -> Vec<u8> {
    let latin = picture.description.chars().all(|c| u32::from(c) <= 0xff);
    let encoding: u8 = if latin {
        0
    } else if version == Version::V24 {
        3
    } else {
        1
    };
    let mut out = Vec::with_capacity(picture.data.len() + picture.mime.len() + picture.description.len() * 2 + 8);
    out.push(encoding);
    out.extend(
        picture
            .mime
            .chars()
            .map(|c| if u32::from(c) <= 0xff { c as u8 } else { b'?' }),
    );
    out.push(0);
    out.push(picture.kind);
    match encoding {
        0 => {
            out.extend(picture.description.chars().map(|c| c as u8));
            out.push(0);
        }
        3 => {
            out.extend_from_slice(picture.description.as_bytes());
            out.push(0);
        }
        _ => {
            out.extend_from_slice(&[0xff, 0xfe]);
            out.extend(picture.description.encode_utf16().flat_map(u16::to_le_bytes));
            out.extend_from_slice(&[0, 0]);
        }
    }
    out.extend_from_slice(&picture.data);
    out
}
