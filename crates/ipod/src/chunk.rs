//! An `iTunesDB` as a tree of chunks, read and written back byte for byte.
//!
//! Every chunk keeps its header as it was read: jackbird changes the fields it
//! knows in place and never rebuilds a header from a model, so whatever it does
//! not understand travels through untouched. On writing, only the lengths and
//! the list counts are recomputed, from what the tree holds.
//!
//! Three shapes, as the iPodLinux wiki documents them and the owner's nano 7G
//! confirms (`RECORD/2026-11-14.ipod-sync.WIP.md`, N3):
//!
//! - a **list** (`mhlt`, `mhlp`, `mhla`, `mhli`): its header holds the count of
//!   its children at `0x08` instead of a total length, and the children follow
//!   it;
//! - a **container** (`mhbd`, `mhsd`, `mhit`, `mhyp`, `mhip`, `mhia`, `mhii`):
//!   its total length at `0x08` covers its header and its children;
//! - anything else (`mhod`, and chunks jackbird does not know) is a header and
//!   a body kept as raw bytes.
//!
//! A container's own counts of its children (an `mhit`'s `mhod`s at `0x0C`,
//! an `mhyp`'s `mhip`s at `0x10`, the `mhbd`'s sections at `0x14`) are fields
//! of its header, set by whoever edits the tree: what each one counts is not
//! always every child.

use crate::Error;
use crate::bytes::{array, len_at};

/// Chunks whose `0x08` is the count of the children that follow them.
const LISTS: [&[u8; 4]; 4] = [b"mhlt", b"mhlp", b"mhla", b"mhli"];
/// Chunks whose children are chunks, inside their total length.
const CONTAINERS: [&[u8; 4]; 7] = [b"mhbd", b"mhsd", b"mhit", b"mhyp", b"mhip", b"mhia", b"mhii"];

/// The deepest nesting a database may have: far more than iTunes writes, and a
/// bound on what a malformed one can make the reader recurse into.
const MAX_DEPTH: usize = 16;

/// A chunk: its four-byte name, its header (the name and lengths included) and
/// what follows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chunk {
    /// The header as read, from the name to its last byte.
    pub header: Vec<u8>,
    /// What follows the header.
    pub body: Body,
}

/// What follows a chunk's header.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Body {
    /// Bytes kept as they are (an `mhod`'s string, an unknown chunk).
    Raw(Vec<u8>),
    /// Child chunks, inside the chunk's total length.
    Children(Vec<Chunk>),
    /// A list's items, as many as its count.
    List(Vec<Chunk>),
}

impl Chunk {
    /// The chunk's name (`mhit`, …).
    pub fn name(&self) -> [u8; 4] {
        self.header[..4]
            .try_into()
            .expect("a header holds at least its name and lengths")
    }

    /// Its children or items (none for a raw chunk).
    pub fn children(&self) -> &[Chunk] {
        match &self.body {
            Body::Raw(_) => &[],
            Body::Children(c) | Body::List(c) => c,
        }
    }

    /// Its children or items, to change them (`None` for a raw chunk).
    pub fn children_mut(&mut self) -> Option<&mut Vec<Chunk>> {
        match &mut self.body {
            Body::Raw(_) => None,
            Body::Children(c) | Body::List(c) => Some(c),
        }
    }

    /// The chunk's length once written: its header and everything under it.
    pub fn len(&self) -> usize {
        self.header.len()
            + match &self.body {
                Body::Raw(raw) => raw.len(),
                Body::Children(c) | Body::List(c) => c.iter().map(Chunk::len).sum(),
            }
    }

    /// Whether the chunk is empty. A chunk never is (it holds at least its
    /// header); this exists because `len` does.
    pub fn is_empty(&self) -> bool {
        false
    }

    /// The chunk written out. Its total length (or a list's count) is set from
    /// what it holds, and so are its children's.
    pub fn write(&self) -> Result<Vec<u8>, Error> {
        let mut out = Vec::with_capacity(self.len());
        self.write_into(&mut out)?;
        Ok(out)
    }

    fn write_into(&self, out: &mut Vec<u8>) -> Result<(), Error> {
        let start = out.len();
        out.extend_from_slice(&self.header);
        let field = match &self.body {
            Body::Raw(raw) => {
                out.extend_from_slice(raw);
                None
            }
            Body::Children(children) => {
                for child in children {
                    child.write_into(out)?;
                }
                None
            }
            Body::List(items) => {
                for item in items {
                    item.write_into(out)?;
                }
                Some(items.len())
            }
        };
        let value = field.unwrap_or(out.len() - start);
        let value = u32::try_from(value).map_err(|_| Error::BadLength { offset: start })?;
        out[start + 8..start + 12].copy_from_slice(&value.to_le_bytes());
        Ok(())
    }
}

/// Reads an `iTunesDB` (an `iTunesCDB` must be inflated first,
/// [`crate::cdb::inflate`]) into its tree, rooted at the `mhbd`.
pub fn parse(data: &[u8]) -> Result<Chunk, Error> {
    let name: [u8; 4] = array(data, 0)?;
    if &name != b"mhbd" {
        return Err(Error::UnexpectedChunk {
            offset: 0,
            expected: "mhbd",
            found: name,
        });
    }
    let (chunk, end) = read(data, 0, data.len(), 0)?;
    if end != data.len() {
        return Err(Error::BadLength { offset: 0 });
    }
    Ok(chunk)
}

/// Reads the chunk at `offset`, which must end by `end`, and gives it with
/// where it ends.
fn read(data: &[u8], offset: usize, end: usize, depth: usize) -> Result<(Chunk, usize), Error> {
    if depth > MAX_DEPTH {
        return Err(Error::BadLength { offset });
    }
    let name: [u8; 4] = array(data, offset)?;
    let header_len = len_at(data, offset + 4, offset)?;
    let field = len_at(data, offset + 8, offset)?;
    let header_end = offset.checked_add(header_len).ok_or(Error::BadLength { offset })?;
    if header_len < 12 || header_end > end {
        return Err(Error::BadLength { offset });
    }
    let header = data[offset..header_end].to_vec();

    if LISTS.contains(&&name) {
        let mut items = Vec::new();
        let mut at = header_end;
        for _ in 0..field {
            if at >= end {
                return Err(Error::Truncated { offset: at });
            }
            let (item, next) = read(data, at, end, depth + 1)?;
            items.push(item);
            at = next;
        }
        return Ok((
            Chunk {
                header,
                body: Body::List(items),
            },
            at,
        ));
    }

    let chunk_end = offset.checked_add(field).ok_or(Error::BadLength { offset })?;
    if field < header_len || chunk_end > end {
        return Err(Error::BadLength { offset });
    }
    let body = if CONTAINERS.contains(&&name) {
        let mut children = Vec::new();
        let mut at = header_end;
        while at < chunk_end {
            let (child, next) = read(data, at, chunk_end, depth + 1)?;
            children.push(child);
            at = next;
        }
        Body::Children(children)
    } else {
        Body::Raw(data[header_end..chunk_end].to_vec())
    };
    Ok((Chunk { header, body }, chunk_end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::sample_database;

    #[test]
    fn round_trip_is_byte_exact() {
        let db = sample_database();
        let tree = parse(&db).unwrap();
        assert_eq!(tree.write().unwrap(), db);
        assert_eq!(tree.len(), db.len());
        assert_eq!(&tree.name(), b"mhbd");
    }

    #[test]
    fn lengths_and_counts_follow_the_tree() {
        let db = sample_database();
        let mut tree = parse(&db).unwrap();
        // Drop the first track of the track list: its mhsd shrinks, and the
        // list's count goes down by one.
        let sections = tree.children_mut().unwrap();
        let tracks = sections
            .iter_mut()
            .find(|s| s.header[12..16] == 1u32.to_le_bytes())
            .unwrap();
        let list = &mut tracks.children_mut().unwrap()[0];
        let before = list.children().len();
        let removed = list.children_mut().unwrap().remove(0).len();
        let out = tree.write().unwrap();
        assert_eq!(out.len(), db.len() - removed);
        let again = parse(&out).unwrap();
        assert_eq!(again.write().unwrap(), out);
        let tracks = again
            .children()
            .iter()
            .find(|s| s.header[12..16] == 1u32.to_le_bytes())
            .unwrap();
        assert_eq!(tracks.children()[0].children().len(), before - 1);
        assert_eq!(crate::db::parse(&out).unwrap().tracks.len(), before - 1);
    }

    #[test]
    fn unknown_chunks_travel_untouched() {
        let mut db = sample_database();
        // An unknown section: an mhsd of a type jackbird ignores, holding a chunk
        // it has never seen.
        let mut odd = b"zzzz".to_vec();
        odd.extend(16u32.to_le_bytes());
        odd.extend(20u32.to_le_bytes());
        odd.extend([1, 2, 3, 4, 5, 6, 7, 8]);
        let mut section = b"mhsd".to_vec();
        section.extend(16u32.to_le_bytes());
        section.extend(((16 + odd.len()) as u32).to_le_bytes());
        section.extend(99u32.to_le_bytes());
        section.extend(&odd);
        db.extend(&section);
        let total = db.len() as u32;
        db[8..12].copy_from_slice(&total.to_le_bytes());
        let tree = parse(&db).unwrap();
        assert_eq!(tree.write().unwrap(), db);
    }

    #[test]
    fn malformed_is_an_error_never_a_panic() {
        let db = sample_database();
        assert!(parse(b"mhbd").is_err());
        assert!(parse(b"mhit\x0c\0\0\0\x0c\0\0\0").is_err());
        for cut in [13, 100, db.len() / 2, db.len() - 1] {
            assert!(parse(&db[..cut]).is_err(), "cut at {cut}");
        }
        let mut bad = db.clone();
        bad[4..8].copy_from_slice(&4u32.to_le_bytes());
        assert!(parse(&bad).is_err());
        let mut long = db.clone();
        long.push(0);
        assert!(parse(&long).is_err());
        // A list claiming more items than there are.
        for i in 0..db.len() - 12 {
            if &db[i..i + 4] == b"mhlt" {
                let mut lie = db.clone();
                lie[i + 8..i + 12].copy_from_slice(&1000u32.to_le_bytes());
                assert!(parse(&lie).is_err());
            }
        }
    }
}
