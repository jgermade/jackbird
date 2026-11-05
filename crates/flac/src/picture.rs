//! `PICTURE` blocks (RFC 9639 §8.8), and the image dimensions a new one needs.

use crate::Error;

/// A `PICTURE` block's content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Picture {
    /// The picture type, as ID3's: 3 is the front cover.
    pub kind: u32,
    /// Its MIME type.
    pub mime: String,
    /// Its description.
    pub description: String,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// Colour depth, in bits per pixel.
    pub depth: u32,
    /// The number of colours of an indexed image; 0 otherwise.
    pub colors: u32,
    /// The image's bytes.
    pub data: Vec<u8>,
}

fn u32_at(bytes: &[u8], at: usize) -> Result<u32, Error> {
    let word = bytes.get(at..at + 4).ok_or(Error::Truncated)?;
    Ok(u32::from_be_bytes([word[0], word[1], word[2], word[3]]))
}

fn bytes_at(bytes: &[u8], at: usize) -> Result<(&[u8], usize), Error> {
    let length = u32_at(bytes, at)? as usize;
    let slice = bytes.get(at + 4..at + 4 + length).ok_or(Error::Truncated)?;
    Ok((slice, at + 4 + length))
}

/// Reads a `PICTURE` block's body.
pub fn decode_picture(body: &[u8]) -> Result<Picture, Error> {
    let kind = u32_at(body, 0)?;
    let (mime, at) = bytes_at(body, 4)?;
    let (description, at) = bytes_at(body, at)?;
    let width = u32_at(body, at)?;
    let height = u32_at(body, at + 4)?;
    let depth = u32_at(body, at + 8)?;
    let colors = u32_at(body, at + 12)?;
    let (data, _) = bytes_at(body, at + 16)?;
    Ok(Picture {
        kind,
        mime: String::from_utf8_lossy(mime).into_owned(),
        description: String::from_utf8_lossy(description).into_owned(),
        width,
        height,
        depth,
        colors,
        data: data.to_vec(),
    })
}

/// A `PICTURE` block's body.
pub fn encode_picture(picture: &Picture) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 + picture.mime.len() + picture.description.len() + picture.data.len());
    out.extend_from_slice(&picture.kind.to_be_bytes());
    for text in [picture.mime.as_bytes(), picture.description.as_bytes()] {
        out.extend_from_slice(&(text.len() as u32).to_be_bytes());
        out.extend_from_slice(text);
    }
    for value in [picture.width, picture.height, picture.depth, picture.colors] {
        out.extend_from_slice(&value.to_be_bytes());
    }
    out.extend_from_slice(&(picture.data.len() as u32).to_be_bytes());
    out.extend_from_slice(&picture.data);
    out
}

/// A PNG's or a JPEG's width, height and bits per pixel, from its header;
/// `None` for anything else.
pub fn image_size(data: &[u8]) -> Option<(u32, u32, u32)> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") && data.get(12..16) == Some(b"IHDR") {
        let width = u32::from_be_bytes(data.get(16..20)?.try_into().ok()?);
        let height = u32::from_be_bytes(data.get(20..24)?.try_into().ok()?);
        let bits = u32::from(*data.get(24)?);
        let channels = match data.get(25)? {
            0 | 3 => 1,
            2 => 3,
            4 => 2,
            6 => 4,
            _ => return None,
        };
        return Some((width, height, bits * channels));
    }
    if data.starts_with(&[0xff, 0xd8]) {
        // The markers up to the first start of frame (SOF0–SOF15 but DHT,
        // JPG and DAC), which holds the precision, the size and the components.
        let mut at = 2;
        while at + 4 <= data.len() {
            if data[at] != 0xff {
                return None;
            }
            let marker = data[at + 1];
            if marker == 0xff {
                at += 1;
                continue;
            }
            let length = u16::from_be_bytes([data[at + 2], data[at + 3]]) as usize;
            if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
                let frame = data.get(at + 4..at + 10)?;
                let height = u32::from(u16::from_be_bytes([frame[1], frame[2]]));
                let width = u32::from(u16::from_be_bytes([frame[3], frame[4]]));
                return Some((width, height, u32::from(frame[0]) * u32::from(frame[5])));
            }
            at += 2 + length;
        }
    }
    None
}
