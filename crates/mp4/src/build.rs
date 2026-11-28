//! Boxes made anew (a rebuilt `ilst`, `meta`, `udta`, `moov`), and the chunk offsets that a `moov`
//! of another size moves.

use crate::{Error, Kind, child, children, u32_at, u64_at};

/// A box: a 32-bit size when it fits, else a 64-bit one; its type; its content.
pub fn boxed(kind: &Kind, content: &[u8]) -> Vec<u8> {
    let size = content.len() as u64 + 8;
    let mut out = Vec::with_capacity(content.len() + 16);
    match u32::try_from(size) {
        Ok(size) => {
            out.extend(size.to_be_bytes());
            out.extend(kind);
        }
        Err(_) => {
            out.extend(1u32.to_be_bytes());
            out.extend(kind);
            out.extend((size + 8).to_be_bytes());
        }
    }
    out.extend(content);
    out
}

/// A full box: its version and flags (four bytes), then its content.
pub fn full_boxed(kind: &Kind, version_flags: [u8; 4], content: &[u8]) -> Vec<u8> {
    let mut body = version_flags.to_vec();
    body.extend(content);
    boxed(kind, &body)
}

/// A `data` atom: its type ([`crate::data_type`]), no locale, its value.
pub fn data_atom(kind: u32, value: &[u8]) -> Vec<u8> {
    let mut body = (kind & 0x00ff_ffff).to_be_bytes().to_vec();
    body.extend([0, 0, 0, 0]);
    body.extend(value);
    boxed(b"data", &body)
}

/// An item of `ilst`: its type and its atoms.
pub fn item(kind: &Kind, atoms: &[Vec<u8>]) -> Vec<u8> {
    boxed(kind, &atoms.concat())
}

/// A freeform item, `----`: its `mean`, its `name`, its atoms.
pub fn freeform(mean: &str, name: &str, atoms: &[Vec<u8>]) -> Vec<u8> {
    let mut body = full_boxed(b"mean", [0; 4], mean.as_bytes());
    body.extend(full_boxed(b"name", [0; 4], name.as_bytes()));
    body.extend(atoms.concat());
    boxed(b"----", &body)
}

/// `size` bytes of room: a `free` box of zeros (`size` is 8 or more).
pub fn room(size: u64) -> Vec<u8> {
    boxed(
        b"free",
        &vec![0; usize::try_from(size.saturating_sub(8)).unwrap_or_default()],
    )
}

/// A track's chunk offsets (`stco`, or `co64` when `wide`): where its entries lie in `moov`'s
/// content, and the offsets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChunkTable {
    /// Where the entries start and end in `moov`'s content (past the count).
    pub entries: (usize, usize),
    /// 64-bit offsets (`co64`).
    pub wide: bool,
    /// The offsets: where each chunk starts in the file.
    pub offsets: Vec<u64>,
}

/// Where `child` starts its content within `bytes`, given where `bytes` starts.
fn content_start(base: usize, found: &crate::Child<'_>) -> usize {
    base + found.range.1 - found.body.len()
}

/// Every track's chunk offsets, from `moov`'s content.
pub fn chunk_tables(moov: &[u8]) -> Result<Vec<ChunkTable>, Error> {
    let mut tables = Vec::new();
    for trak in children(moov)?.into_iter().filter(|found| found.kind == *b"trak") {
        let mut base = content_start(0, &trak);
        let mut within = trak.body;
        let mut found = true;
        for kind in [b"mdia", b"minf", b"stbl"] {
            match child(within, kind)? {
                Some(next) => {
                    base = content_start(base, &next);
                    within = next.body;
                }
                None => {
                    found = false;
                    break;
                }
            }
        }
        if !found {
            continue;
        }
        for table in children(within)?
            .into_iter()
            .filter(|found| matches!(&found.kind, b"stco" | b"co64"))
        {
            let wide = table.kind == *b"co64";
            let at = content_start(base, &table);
            let count = u32_at(table.body, 4).ok_or(Error::Truncated("a chunk offset table"))? as usize;
            let width = if wide { 8 } else { 4 };
            let start = at + 8;
            let end = start + count * width;
            if 8 + count * width > table.body.len() {
                return Err(Error::Truncated("a chunk offset table"));
            }
            let offsets = (0..count)
                .map(|index| {
                    let entry = 8 + index * width;
                    if wide {
                        u64_at(table.body, entry).unwrap_or_default()
                    } else {
                        u64::from(u32_at(table.body, entry).unwrap_or_default())
                    }
                })
                .collect();
            tables.push(ChunkTable {
                entries: (start, end),
                wide,
                offsets,
            });
        }
    }
    Ok(tables)
}

/// Shifts by `by` every chunk offset of `moov`'s content at `from` or past it (the audio that
/// moves). `Err` when an offset would leave its width (a 32-bit `stco` past 4 GiB) or go below 0.
pub fn shift_chunks(moov: &mut [u8], from: u64, by: i64) -> Result<(), Error> {
    for table in chunk_tables(moov)? {
        let width = if table.wide { 8 } else { 4 };
        for (index, offset) in table.offsets.iter().enumerate() {
            if *offset < from {
                continue;
            }
            let moved = offset
                .checked_add_signed(by)
                .ok_or(Error::Truncated("a chunk offset"))?;
            let at = table.entries.0 + index * width;
            if table.wide {
                moov[at..at + 8].copy_from_slice(&moved.to_be_bytes());
            } else {
                let moved = u32::try_from(moved).map_err(|_| Error::BadSize {
                    kind: *b"stco",
                    at: at as u64,
                })?;
                moov[at..at + 4].copy_from_slice(&moved.to_be_bytes());
            }
        }
    }
    Ok(())
}
