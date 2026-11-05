//! Unsynchronisation (ID3v2.3 §5, ID3v2.4 §6.1): a `$00` after each `$FF`
//! that could be read as the start of an MPEG frame, so players that do not
//! know ID3 skip the tag.

/// Undoes unsynchronisation: every `$00` right after a `$FF` goes.
pub fn resynchronise(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    for (at, &byte) in bytes.iter().enumerate() {
        if byte == 0x00 && at > 0 && bytes[at - 1] == 0xff {
            continue;
        }
        out.push(byte);
    }
    out
}

/// Applies unsynchronisation: a `$00` after each `$FF` that is followed by
/// `%111xxxxx` or `$00`, or that ends the data.
pub fn unsynchronise(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + bytes.len() / 64 + 1);
    for (at, &byte) in bytes.iter().enumerate() {
        out.push(byte);
        if byte == 0xff {
            match bytes.get(at + 1) {
                None => out.push(0),
                Some(&next) if next >= 0xe0 || next == 0 => out.push(0),
                Some(_) => {}
            }
        }
    }
    out
}

/// A 28-bit integer stored in four bytes of seven bits each.
pub(crate) fn syncsafe(bytes: &[u8]) -> usize {
    ((bytes[0] as usize & 0x7f) << 21)
        | ((bytes[1] as usize & 0x7f) << 14)
        | ((bytes[2] as usize & 0x7f) << 7)
        | (bytes[3] as usize & 0x7f)
}

/// A 32-bit big-endian integer.
pub(crate) fn plain(bytes: &[u8]) -> usize {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize
}

pub(crate) fn put_syncsafe(value: usize) -> [u8; 4] {
    [
        ((value >> 21) & 0x7f) as u8,
        ((value >> 14) & 0x7f) as u8,
        ((value >> 7) & 0x7f) as u8,
        (value & 0x7f) as u8,
    ]
}

/// The largest value a syncsafe integer holds.
pub(crate) const SYNCSAFE_MAX: usize = 0x0fff_ffff;
