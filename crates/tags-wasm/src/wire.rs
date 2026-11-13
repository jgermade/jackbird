//! The wire format between the module and `src/helpers/tagwire.ts`, which
//! mirrors it: little-endian, every string and byte run preceded by its
//! length as a `u32`.
//!
//! - A read's result: the format (`u8`: 0 MP3, 1 FLAC), the fields as
//!   strings in [`Field::ALL`]'s order, then `u8` 1 and the cover's MIME type
//!   and bytes, or `u8` 0.
//! - An error: its code and its message, as strings.
//! - An edit: for each field in order, `u8` 0 to leave it, or `u8` 1 and its
//!   new value; then the cover: `u8` 0 to keep it, 1 and a MIME type and bytes
//!   to set it, 2 to remove it.
//! - A layout (13 bytes): the format (`u8`: 0 MP3, 1 FLAC, 255 none), then
//!   `tags_end`, the audio region's start and its end, as `u32`.
//!
//! The requests: `tags_layout`'s is the file's length (`u32`), its tail (a
//! run of bytes), then its head (the rest); `tags_read`'s a layout, then the
//! head; `tags_write`'s an edit, a layout, then the head. The answers:
//! `tags_layout`'s is `u8` 0 and a layout, or `u8` 1 and how many first bytes
//! it needs (`u32`); `tags_read`'s a read's result; `tags_write`'s the end of
//! the bytes the splice replaces (`u32`; it starts at 0), then what replaces
//! them (the rest). An error answers any of them.

use jackbird_tags::{Cover, CoverEdit, Edit, Error, Field, FileLayout, Format, Layout, Splice, Tags};

fn put_len(out: &mut Vec<u8>, len: usize) {
    out.extend_from_slice(&(len as u32).to_le_bytes());
}

fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    put_len(out, bytes.len());
    out.extend_from_slice(bytes);
}

/// A read's result.
pub fn tags(tags: &Tags) -> Vec<u8> {
    let cover = tags
        .cover
        .as_ref()
        .map_or(0, |cover| cover.data.len() + cover.mime.len());
    let mut out = Vec::with_capacity(64 + cover);
    out.push(match tags.format {
        Format::Mp3 => 0,
        Format::Flac => 1,
    });
    for field in Field::ALL {
        put_bytes(&mut out, tags.fields.get(field).as_bytes());
    }
    match &tags.cover {
        Some(cover) => {
            out.push(1);
            put_bytes(&mut out, cover.mime.as_bytes());
            put_bytes(&mut out, &cover.data);
        }
        None => out.push(0),
    }
    out
}

/// An error.
pub fn error(error: &Error) -> Vec<u8> {
    let mut out = Vec::new();
    put_bytes(&mut out, error.code().as_bytes());
    put_bytes(&mut out, error.to_string().as_bytes());
    out
}

fn put_u32(out: &mut Vec<u8>, value: u64) -> Result<(), Error> {
    let value = u32::try_from(value).map_err(|_| Error::TooLarge)?;
    out.extend_from_slice(&value.to_le_bytes());
    Ok(())
}

fn put_layout(out: &mut Vec<u8>, layout: &FileLayout) -> Result<(), Error> {
    out.push(match layout.format {
        Some(Format::Mp3) => 0,
        Some(Format::Flac) => 1,
        None => 255,
    });
    put_u32(out, layout.tags_end)?;
    put_u32(out, layout.audio.start)?;
    put_u32(out, layout.audio.end)
}

/// `tags_layout`'s answer.
pub fn layout(layout: &Layout) -> Result<Vec<u8>, Error> {
    let mut out = Vec::with_capacity(14);
    match layout {
        Layout::Known(found) => {
            out.push(0);
            put_layout(&mut out, found)?;
        }
        Layout::NeedHead(n) => {
            out.push(1);
            put_u32(&mut out, *n)?;
        }
    }
    Ok(out)
}

/// `tags_write`'s answer.
pub fn splice(splice: Splice) -> Result<Vec<u8>, Error> {
    let mut out = Vec::with_capacity(4 + splice.with.len());
    put_u32(&mut out, splice.replace.end)?;
    out.extend_from_slice(&splice.with);
    Ok(out)
}

/// Reads the wire, or says where it stops making sense.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], String> {
        let end = self.at.checked_add(len).filter(|end| *end <= self.bytes.len());
        let end = end.ok_or_else(|| format!("the request ends early, at byte {}", self.at))?;
        let out = &self.bytes[self.at..end];
        self.at = end;
        Ok(out)
    }

    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn bytes(&mut self) -> Result<&'a [u8], String> {
        let len = self.take(4)?;
        let len = u32::from_le_bytes([len[0], len[1], len[2], len[3]]) as usize;
        self.take(len)
    }

    fn u32(&mut self) -> Result<u64, String> {
        let bytes = self.take(4)?;
        Ok(u64::from(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])))
    }

    fn layout(&mut self) -> Result<FileLayout, String> {
        let format = match self.byte()? {
            0 => Some(Format::Mp3),
            1 => Some(Format::Flac),
            255 => None,
            other => return Err(format!("a format marked {other}")),
        };
        let tags_end = self.u32()?;
        let audio = self.u32()?..self.u32()?;
        Ok(FileLayout {
            format,
            tags_end,
            audio,
        })
    }

    fn rest(&mut self) -> &'a [u8] {
        let out = &self.bytes[self.at..];
        self.at = self.bytes.len();
        out
    }

    fn string(&mut self) -> Result<String, String> {
        String::from_utf8(self.bytes()?.to_vec()).map_err(|_| "a string that is not UTF-8".to_owned())
    }
}

fn edit(reader: &mut Reader<'_>) -> Result<Edit, String> {
    let mut values: Vec<Option<String>> = Vec::with_capacity(Field::ALL.len());
    for _ in Field::ALL {
        values.push(match reader.byte()? {
            0 => None,
            1 => Some(reader.string()?),
            other => return Err(format!("a field marked {other}")),
        });
    }
    let cover = match reader.byte()? {
        0 => CoverEdit::Keep,
        1 => {
            let mime = reader.string()?;
            let data = reader.bytes()?.to_vec();
            CoverEdit::Set(Cover { data, mime })
        }
        2 => CoverEdit::Remove,
        other => return Err(format!("a cover marked {other}")),
    };
    let mut values = values.into_iter();
    let mut next = || values.next().flatten();
    Ok(Edit {
        title: next(),
        artist: next(),
        album: next(),
        year: next(),
        genre: next(),
        track: next(),
        disc: next(),
        album_artist: next(),
        compilation: next(),
        cover,
    })
}

/// `tags_layout`'s request: the file's length, its tail and its head.
pub fn layout_request(bytes: &[u8]) -> Result<(u64, &[u8], &[u8]), String> {
    let mut reader = Reader { bytes, at: 0 };
    let len = reader.u32()?;
    let tail = reader.bytes()?;
    Ok((len, tail, reader.rest()))
}

/// `tags_read`'s request: a layout and the head.
pub fn read_request(bytes: &[u8]) -> Result<(FileLayout, &[u8]), String> {
    let mut reader = Reader { bytes, at: 0 };
    let layout = reader.layout()?;
    Ok((layout, reader.rest()))
}

/// `tags_write`'s request: an edit, a layout and the head.
pub fn write_request(bytes: &[u8]) -> Result<(Edit, FileLayout, &[u8]), String> {
    let mut reader = Reader { bytes, at: 0 };
    let edit = edit(&mut reader)?;
    let layout = reader.layout()?;
    Ok((edit, layout, reader.rest()))
}

#[cfg(test)]
mod tests {
    use jackbird_tags::Fields;

    use super::*;

    /// An edit as `tagwire.ts` encodes it.
    fn encoded(fields: [Option<&str>; 9], cover: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for value in fields {
            match value {
                Some(value) => {
                    out.push(1);
                    put_bytes(&mut out, value.as_bytes());
                }
                None => out.push(0),
            }
        }
        out.extend_from_slice(cover);
        out
    }

    const LAYOUT: [u8; 13] = [1, 10, 0, 0, 0, 10, 0, 0, 0, 0, 1, 0, 0];

    fn layout_flac() -> FileLayout {
        FileLayout {
            format: Some(Format::Flac),
            tags_end: 10,
            audio: 10..256,
        }
    }

    #[test]
    fn reads_a_write_request() {
        let mut cover = vec![1];
        put_bytes(&mut cover, b"image/png");
        put_bytes(&mut cover, &[9, 8, 7]);
        let mut request = encoded(
            [
                Some("Título"),
                None,
                Some(""),
                Some("1959"),
                None,
                Some("3/12"),
                Some("2/2"),
                Some("Various Artists"),
                Some("1"),
            ],
            &cover,
        );
        request.extend_from_slice(&LAYOUT);
        request.extend_from_slice(b"fLaC...");
        let (edit, layout, head) = write_request(&request).unwrap();
        assert_eq!(
            edit,
            Edit {
                title: Some("Título".into()),
                artist: None,
                album: Some(String::new()),
                year: Some("1959".into()),
                genre: None,
                track: Some("3/12".into()),
                disc: Some("2/2".into()),
                album_artist: Some("Various Artists".into()),
                compilation: Some("1".into()),
                cover: CoverEdit::Set(Cover {
                    data: vec![9, 8, 7],
                    mime: "image/png".into()
                }),
            }
        );
        assert_eq!(layout, layout_flac());
        assert_eq!(head, b"fLaC...");
        let mut request = encoded([None; 9], &[2]);
        request.extend_from_slice(&[255, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0]);
        let (edit, layout, head) = write_request(&request).unwrap();
        assert_eq!(edit.cover, CoverEdit::Remove);
        assert_eq!((layout.format, layout.audio), (None, 0..5));
        assert!(head.is_empty());
    }

    #[test]
    fn reads_layout_and_read_requests() {
        let mut request = 300u32.to_le_bytes().to_vec();
        put_bytes(&mut request, b"tail");
        request.extend_from_slice(b"head");
        assert_eq!(layout_request(&request).unwrap(), (300, &b"tail"[..], &b"head"[..]));
        let mut request = LAYOUT.to_vec();
        request.extend_from_slice(b"head");
        assert_eq!(read_request(&request).unwrap(), (layout_flac(), &b"head"[..]));
    }

    #[test]
    fn refuses_a_request_that_makes_no_sense() {
        assert!(write_request(&[]).unwrap_err().contains("ends early"));
        assert!(write_request(&[3]).unwrap_err().contains("field marked 3"));
        assert!(
            write_request(&encoded([None; 9], &[5]))
                .unwrap_err()
                .contains("cover marked 5")
        );
        assert!(read_request(&[7; 13]).unwrap_err().contains("format marked 7"));
        assert!(read_request(&LAYOUT[..12]).unwrap_err().contains("ends early"));
        assert!(layout_request(&[1, 0]).unwrap_err().contains("ends early"));
        let mut long = vec![1];
        put_len(&mut long, 100);
        assert!(write_request(&long).unwrap_err().contains("ends early"));
        let mut invalid = vec![1];
        put_bytes(&mut invalid, &[0xff]);
        assert!(write_request(&invalid).unwrap_err().contains("UTF-8"));
    }

    #[test]
    fn writes_tags_errors_layouts_and_splices() {
        let read = Tags {
            format: Format::Flac,
            fields: Fields {
                title: "T".into(),
                year: "1959".into(),
                ..Fields::default()
            },
            cover: Some(Cover {
                data: vec![1, 2],
                mime: "image/jpeg".into(),
            }),
        };
        let mut expected = vec![1, 1, 0, 0, 0, b'T', 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0];
        expected.extend_from_slice(b"1959");
        // genre, track, disc, album artist and compilation: empty.
        expected.extend_from_slice(&[0; 20]);
        expected.extend_from_slice(&[1, 10, 0, 0, 0]);
        expected.extend_from_slice(b"image/jpeg");
        expected.extend_from_slice(&[2, 0, 0, 0, 1, 2]);
        assert_eq!(tags(&read), expected);
        let untagged = Tags {
            format: Format::Mp3,
            fields: Fields::default(),
            cover: None,
        };
        assert_eq!(tags(&untagged), [vec![0], vec![0; 36], vec![0]].concat());
        let mut expected = vec![6, 0, 0, 0];
        expected.extend_from_slice(b"id3v22");
        let message = Error::Id3v22.to_string();
        expected.extend_from_slice(&(message.len() as u32).to_le_bytes());
        expected.extend_from_slice(message.as_bytes());
        assert_eq!(error(&Error::Id3v22), expected);

        assert_eq!(
            layout(&Layout::Known(layout_flac())).unwrap(),
            [&[0][..], &LAYOUT].concat()
        );
        assert_eq!(layout(&Layout::NeedHead(0x0102_0304)).unwrap(), [1, 4, 3, 2, 1]);
        let huge = FileLayout {
            audio: 0..u64::from(u32::MAX) + 1,
            ..layout_flac()
        };
        assert_eq!(layout(&Layout::Known(huge)).unwrap_err(), Error::TooLarge);
        let made = Splice {
            replace: 0..7,
            with: b"new".to_vec(),
        };
        assert_eq!(splice(made).unwrap(), [7, 0, 0, 0, b'n', b'e', b'w']);
    }
}
