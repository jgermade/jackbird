//! jackbird's iPod databases, read from bytes and written back.
//!
//! - [`sysinfo`]: the device's `SysInfo` file and the scalar values of its
//!   `SysInfoExtended` (which the iPod sends over USB, or a copy on its disk);
//! - [`device`]: the generation, the checksum scheme its firmware expects, the
//!   database file it reads, and its FireWire GUID;
//! - [`cdb`]: an `iTunesCDB` (nano 5G to 7G) turned into the `iTunesDB` it
//!   compresses;
//! - [`db`]: the tracks and playlists of an `iTunesDB`;
//! - [`chunk`]: an `iTunesDB` as a tree of chunks, written back byte for byte;
//! - [`hashab`]: the signature the nano 6G and 7G check on their databases;
//! - [`library`]: the SQLite library of the nano 6G and 7G, as data: its
//!   schema, its post-process and its rows;
//! - [`song`]: a song as jackbird adds it, and its `mhit` and rows;
//! - [`collate`]: how the nano's menus sort, and the library's ranks.
//!
//! No I/O: the caller reads the files (or the USB request) and hands the bytes
//! in. Malformed input is an [`Error`] that names its offset, never a panic.
//! See `RECORD/2026-11-14.ipod-sync.WIP.md`.

pub mod cdb;
pub mod chunk;
pub mod collate;
pub mod db;
pub mod device;
pub mod hashab;
pub mod library;
pub mod song;
pub mod sysinfo;

mod bytes;
mod sha1 {
    //! SHA-1, as one call.
    use sha1::{Digest, Sha1};

    pub(crate) fn sha1(data: &[u8]) -> [u8; 20] {
        Sha1::digest(data).into()
    }
}

use std::fmt;

/// Why bytes could not be read as an iPod database.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// The data ends before what it announces.
    Truncated {
        /// Where the missing bytes should have been.
        offset: usize,
    },
    /// A chunk was not the one expected there.
    UnexpectedChunk {
        /// Where the chunk starts.
        offset: usize,
        /// What was expected (`mhbd`, `mhit`, …).
        expected: &'static str,
        /// The four bytes found instead.
        found: [u8; 4],
    },
    /// A length field that cannot be right (shorter than its header, or past
    /// its parent's end).
    BadLength {
        /// Where the field's chunk starts.
        offset: usize,
    },
    /// The zlib stream of an `iTunesCDB` could not be inflated.
    Inflate {
        /// Where the stream starts.
        offset: usize,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Truncated { offset } => write!(f, "the data ends early, at {offset:#x}"),
            Error::UnexpectedChunk {
                offset,
                expected,
                found,
            } => write!(
                f,
                "expected {expected} at {offset:#x}, found {:?}",
                String::from_utf8_lossy(found)
            ),
            Error::BadLength { offset } => write!(f, "a length that cannot be right, in the chunk at {offset:#x}"),
            Error::Inflate { offset } => write!(f, "the compressed database at {offset:#x} could not be inflated"),
        }
    }
}

impl std::error::Error for Error {}
