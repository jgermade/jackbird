//! Comments and unsynchronised lyrics: `COMM` and `USLT` (v2.3, v2.4), `COM` and `ULT` (v2.2).
//! One layout for both: an encoding byte, a three-letter language, a description ended by a
//! terminator, and the text.

use crate::text::{decode_one, latin1, split_terminated};
use crate::{Error, Version};

/// A comment's (or the lyrics') frame content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Comment {
    /// Its language, three letters (`eng`); as the file holds it.
    pub language: String,
    /// Its description: empty for the comment (or the lyrics) itself; iTunes keeps its own data
    /// in comments described `iTunNORM`, `iTunSMPB`, ….
    pub description: String,
    /// The text.
    pub text: String,
}

/// The comment in a `COMM` or `USLT` frame's content (`COM` or `ULT` in v2.2).
pub fn decode_comment(content: &[u8]) -> Result<Comment, Error> {
    let (&encoding, rest) = content.split_first().ok_or(Error::Malformed("a comment"))?;
    if rest.len() < 3 {
        return Err(Error::Malformed("a comment"));
    }
    let language = latin1(&rest[..3]);
    let (description, text) = split_terminated(&rest[3..], encoding);
    let (text, _) = split_terminated(text, encoding);
    Ok(Comment {
        language,
        description: decode_one(description, encoding),
        text: decode_one(text, encoding),
    })
}

/// A `COMM` or `USLT` frame's content holding `comment`, for v2.3 or v2.4: ISO-8859-1 when
/// everything fits in it, else UTF-8 (v2.4) or UTF-16 with its byte order mark (v2.3). A language
/// that is not three letters is written `eng`.
pub fn encode_comment(comment: &Comment, version: Version) -> Vec<u8> {
    let latin = comment
        .description
        .chars()
        .chain(comment.text.chars())
        .all(|c| u32::from(c) <= 0xff);
    let encoding: u8 = if latin {
        0
    } else if version == Version::V24 {
        3
    } else {
        1
    };
    let language = if comment.language.len() == 3 && comment.language.is_ascii() {
        comment.language.as_str()
    } else {
        "eng"
    };
    let mut out = Vec::with_capacity(comment.text.len() * 2 + comment.description.len() * 2 + 10);
    out.push(encoding);
    out.extend_from_slice(language.as_bytes());
    let put = |out: &mut Vec<u8>, value: &str, terminated: bool| match encoding {
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
    };
    put(&mut out, &comment.description, true);
    put(&mut out, &comment.text, false);
    out
}
