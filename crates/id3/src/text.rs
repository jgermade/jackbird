//! Text information frames (`T___`, but not `TXXX`): an encoding byte, then
//! one string, or several (v2.4) separated by a terminator.

use crate::Version;

/// The strings of a text frame's content, decoded leniently: ISO-8859-1
/// (`$00`), UTF-16 with a byte order mark (`$01`; a string without one takes
/// the previous one's, or a guess), UTF-16BE (`$02`) or UTF-8 (`$03`).
/// Invalid sequences become U+FFFD; trailing empty strings (terminators) are
/// dropped. An empty frame gives no strings.
pub fn decode_text(content: &[u8]) -> Vec<String> {
    let Some((&encoding, rest)) = content.split_first() else {
        return Vec::new();
    };
    let mut values = match encoding {
        1 => utf16_strings(rest, None),
        2 => utf16_strings(rest, Some(true)),
        3 => rest
            .split(|&byte| byte == 0)
            .map(|part| String::from_utf8_lossy(part).into_owned())
            .collect(),
        // ISO-8859-1, and any encoding byte the standard does not define.
        _ => rest.split(|&byte| byte == 0).map(latin1).collect(),
    };
    while values.last().is_some_and(String::is_empty) {
        values.pop();
    }
    values
}

/// A text frame's content holding `value`: ISO-8859-1 when every character
/// fits in it, else UTF-8 in v2.4 and UTF-16 (little-endian, with its byte
/// order mark) in v2.3, which has no UTF-8. No terminator.
pub fn encode_text(value: &str, version: Version) -> Vec<u8> {
    if value.chars().all(|c| u32::from(c) <= 0xff) {
        let mut out = vec![0];
        out.extend(value.chars().map(|c| c as u8));
        out
    } else if version == Version::V24 {
        let mut out = vec![3];
        out.extend_from_slice(value.as_bytes());
        out
    } else {
        let mut out = vec![1, 0xff, 0xfe];
        out.extend(value.encode_utf16().flat_map(u16::to_le_bytes));
        out
    }
}

pub(crate) fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&byte| char::from(byte)).collect()
}

/// UTF-16 strings separated by `$00 00` units. `big_endian`: `Some` for a
/// fixed byte order (UTF-16BE), `None` to read byte order marks.
pub(crate) fn utf16_strings(bytes: &[u8], big_endian: Option<bool>) -> Vec<String> {
    // An odd last byte is no unit, and is dropped.
    let (units, _) = bytes.as_chunks::<2>();
    let mut order = big_endian;
    units
        .split(|unit| *unit == [0, 0])
        .map(|part| {
            let mut part = part;
            if big_endian.is_none() {
                match part.first() {
                    Some([0xff, 0xfe]) => {
                        order = Some(false);
                        part = &part[1..];
                    }
                    Some([0xfe, 0xff]) => {
                        order = Some(true);
                        part = &part[1..];
                    }
                    _ => {}
                }
            }
            let big = *order.get_or_insert_with(|| guess_big_endian(part));
            let words: Vec<u16> = part
                .iter()
                .map(|unit| {
                    if big {
                        u16::from_be_bytes(*unit)
                    } else {
                        u16::from_le_bytes(*unit)
                    }
                })
                .collect();
            String::from_utf16_lossy(&words)
        })
        .collect()
}

/// A string without a byte order mark: big-endian when its units have their
/// zero bytes first (as Latin text in UTF-16BE does), else little-endian,
/// which most writers that leave the mark out use.
fn guess_big_endian(units: &[[u8; 2]]) -> bool {
    let first_zero = units.iter().filter(|unit| unit[0] == 0 && unit[1] != 0).count();
    let second_zero = units.iter().filter(|unit| unit[1] == 0 && unit[0] != 0).count();
    first_zero > second_zero
}

/// Splits `bytes` at the first terminator of `encoding` (one `$00`, or a
/// `$00 00` unit for UTF-16): the string before it, and what follows. No
/// terminator: everything is the string.
pub(crate) fn split_terminated(bytes: &[u8], encoding: u8) -> (&[u8], &[u8]) {
    if encoding == 1 || encoding == 2 {
        let mut at = 0;
        while at + 1 < bytes.len() {
            if bytes[at] == 0 && bytes[at + 1] == 0 {
                return (&bytes[..at], &bytes[at + 2..]);
            }
            at += 2;
        }
        (bytes, &[])
    } else {
        match bytes.iter().position(|&byte| byte == 0) {
            Some(at) => (&bytes[..at], &bytes[at + 1..]),
            None => (bytes, &[]),
        }
    }
}

/// One string in `encoding`, as `decode_text` reads it.
pub(crate) fn decode_one(bytes: &[u8], encoding: u8) -> String {
    match encoding {
        1 => utf16_strings(bytes, None).into_iter().next().unwrap_or_default(),
        2 => utf16_strings(bytes, Some(true)).into_iter().next().unwrap_or_default(),
        3 => String::from_utf8_lossy(bytes).into_owned(),
        _ => latin1(bytes),
    }
}
