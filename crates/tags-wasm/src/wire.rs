//! The wire format between the module and `src/helpers/tagwire.ts`, which
//! mirrors it: little-endian, every string and byte run preceded by its
//! length as a `u32`.
//!
//! - A read's result: the format (`u8`: 0 MP3, 1 FLAC), the six fields as
//!   strings in [`Field::ALL`]'s order, then `u8` 1 and the cover's MIME type
//!   and bytes, or `u8` 0.
//! - An error: its code and its message, as strings.
//! - An edit (the request of a write): for each field in order, `u8` 0 to
//!   leave it, or `u8` 1 and its new value; then the cover: `u8` 0 to keep it,
//!   1 and a MIME type and bytes to set it, 2 to remove it.
//! - A region: its start and end, as `u32`.

use jackbird_tags::{Cover, CoverEdit, Edit, Error, Field, Format, Tags};

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

/// A region.
pub fn region(start: usize, end: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(8);
    out.extend_from_slice(&(start as u32).to_le_bytes());
    out.extend_from_slice(&(end as u32).to_le_bytes());
    out
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

    fn string(&mut self) -> Result<String, String> {
        String::from_utf8(self.bytes()?.to_vec()).map_err(|_| "a string that is not UTF-8".to_owned())
    }
}

/// An edit, from a write's request; what follows it is the file. Gives the
/// edit and where the file starts.
pub fn edit(bytes: &[u8]) -> Result<(Edit, usize), String> {
    let mut reader = Reader { bytes, at: 0 };
    let mut values: Vec<Option<String>> = Vec::with_capacity(6);
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
    let edit = Edit {
        title: next(),
        artist: next(),
        album: next(),
        year: next(),
        genre: next(),
        track: next(),
        cover,
    };
    Ok((edit, reader.at))
}

#[cfg(test)]
mod tests {
    use jackbird_tags::Fields;

    use super::*;

    /// An edit as `tagwire.ts` encodes it.
    fn encoded(fields: [Option<&str>; 6], cover: &[u8]) -> Vec<u8> {
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

    #[test]
    fn reads_an_edit_and_where_the_file_starts() {
        let mut cover = vec![1];
        put_bytes(&mut cover, b"image/png");
        put_bytes(&mut cover, &[9, 8, 7]);
        let mut request = encoded(
            [Some("Título"), None, Some(""), Some("1959"), None, Some("3/12")],
            &cover,
        );
        let start = request.len();
        request.extend_from_slice(b"ID3...");
        let (edit, at) = edit(&request).unwrap();
        assert_eq!(at, start);
        assert_eq!(
            edit,
            Edit {
                title: Some("Título".into()),
                artist: None,
                album: Some(String::new()),
                year: Some("1959".into()),
                genre: None,
                track: Some("3/12".into()),
                cover: CoverEdit::Set(Cover {
                    data: vec![9, 8, 7],
                    mime: "image/png".into()
                }),
            }
        );
        assert_eq!(edit_of(&encoded([None; 6], &[0])), Edit::default());
        assert_eq!(edit_of(&encoded([None; 6], &[2])).cover, CoverEdit::Remove);
    }

    fn edit_of(bytes: &[u8]) -> Edit {
        edit(bytes).unwrap().0
    }

    #[test]
    fn refuses_a_request_that_makes_no_sense() {
        assert!(edit(&[]).unwrap_err().contains("ends early"));
        assert!(edit(&[3]).unwrap_err().contains("field marked 3"));
        assert!(edit(&encoded([None; 6], &[5])).unwrap_err().contains("cover marked 5"));
        let mut long = vec![1];
        put_len(&mut long, 100);
        assert!(edit(&long).unwrap_err().contains("ends early"));
        let mut invalid = vec![1];
        put_bytes(&mut invalid, &[0xff]);
        assert!(edit(&invalid).unwrap_err().contains("UTF-8"));
    }

    #[test]
    fn writes_tags_errors_and_regions() {
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
        expected.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 1, 10, 0, 0, 0]);
        expected.extend_from_slice(b"image/jpeg");
        expected.extend_from_slice(&[2, 0, 0, 0, 1, 2]);
        assert_eq!(tags(&read), expected);
        let untagged = Tags {
            format: Format::Mp3,
            fields: Fields::default(),
            cover: None,
        };
        assert_eq!(tags(&untagged), [vec![0], vec![0; 24], vec![0]].concat());
        let mut expected = vec![6, 0, 0, 0];
        expected.extend_from_slice(b"id3v22");
        let message = Error::Id3v22.to_string();
        expected.extend_from_slice(&(message.len() as u32).to_le_bytes());
        expected.extend_from_slice(message.as_bytes());
        assert_eq!(error(&Error::Id3v22), expected);
        assert_eq!(region(10, 0x0102_0304), [10, 0, 0, 0, 4, 3, 2, 1]);
    }
}
