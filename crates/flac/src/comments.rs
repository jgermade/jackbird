//! Vorbis comments: a vendor string and entries `KEY=value`, each stored as
//! a little-endian length and bytes.

use crate::Error;

/// A `VORBIS_COMMENT` block, entry by entry, as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Comments {
    /// The vendor string's bytes.
    pub vendor: Vec<u8>,
    /// Each entry's bytes, normally `KEY=value` in UTF-8, kept whatever they hold.
    pub entries: Vec<Vec<u8>>,
    /// Bytes after the last entry (a framing bit some writers add), kept.
    pub trailing: Vec<u8>,
}

fn u32_at(bytes: &[u8], at: usize) -> Result<usize, Error> {
    let word = bytes.get(at..at + 4).ok_or(Error::Truncated)?;
    Ok(u32::from_le_bytes([word[0], word[1], word[2], word[3]]) as usize)
}

impl Comments {
    /// Comments with a vendor string and no entries.
    pub fn new(vendor: &str) -> Self {
        Comments {
            vendor: vendor.as_bytes().to_vec(),
            entries: Vec::new(),
            trailing: Vec::new(),
        }
    }

    /// Reads a `VORBIS_COMMENT` block's body.
    pub fn parse(body: &[u8]) -> Result<Self, Error> {
        let vendor_length = u32_at(body, 0)?;
        let vendor = body.get(4..4 + vendor_length).ok_or(Error::Truncated)?.to_vec();
        let mut at = 4 + vendor_length;
        let count = u32_at(body, at)?;
        at += 4;
        let mut entries = Vec::with_capacity(count.min(1024));
        for _ in 0..count {
            let length = u32_at(body, at)?;
            entries.push(body.get(at + 4..at + 4 + length).ok_or(Error::Truncated)?.to_vec());
            at += 4 + length;
        }
        Ok(Comments {
            vendor,
            entries,
            trailing: body[at..].to_vec(),
        })
    }

    /// The block's body.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(self.vendor.len() as u32).to_le_bytes());
        out.extend_from_slice(&self.vendor);
        out.extend_from_slice(&(self.entries.len() as u32).to_le_bytes());
        for entry in &self.entries {
            out.extend_from_slice(&(entry.len() as u32).to_le_bytes());
            out.extend_from_slice(entry);
        }
        out.extend_from_slice(&self.trailing);
        out
    }

    /// The index of each entry whose key is `key`, compared without case
    /// (ASCII), in order.
    pub fn positions(&self, key: &str) -> Vec<usize> {
        self.entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| key_is(entry, key))
            .map(|(index, _)| index)
            .collect()
    }

    /// The first value of `key`, decoded leniently, if there is one.
    pub fn get(&self, key: &str) -> Option<String> {
        self.entries
            .iter()
            .find(|entry| key_is(entry, key))
            .map(|entry| value_of(entry))
    }
}

/// An entry's key: the bytes before its first `=`; `None` without one.
pub fn key(entry: &[u8]) -> Option<&[u8]> {
    entry.iter().position(|&byte| byte == b'=').map(|end| &entry[..end])
}

/// Whether an entry's key is `key`, without case (ASCII).
fn key_is(entry: &[u8], wanted: &str) -> bool {
    key(entry).is_some_and(|found| found.eq_ignore_ascii_case(wanted.as_bytes()))
}

/// An entry's value: the bytes after its first `=`, as UTF-8, leniently.
fn value_of(entry: &[u8]) -> String {
    let start = entry
        .iter()
        .position(|&byte| byte == b'=')
        .map_or(entry.len(), |end| end + 1);
    String::from_utf8_lossy(&entry[start..]).into_owned()
}

/// An entry `key=value`.
pub fn entry(key: &str, value: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(key.len() + 1 + value.len());
    out.extend_from_slice(key.as_bytes());
    out.push(b'=');
    out.extend_from_slice(value.as_bytes());
    out
}
