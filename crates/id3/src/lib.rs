//! ID3v2 tags (v2.2, v2.3 and v2.4) as frames, kept byte for byte.
//!
//! A tag is read into its frames as they are stored (`id`, `flags`, `body`),
//! without parsing what is in them, and written back from frames, so a frame
//! nobody edits goes back exactly as it came. The codecs of the frames that
//! are edited (text frames, pictures) are separate and decode leniently: a
//! broken string reads as well as it can instead of failing.
//!
//! Written from the specifications (id3.org's informal standards for
//! ID3v2.2, v2.3 and v2.4). No I/O, no dependencies. See
//! `RECORD/2026-08-11.musikmatch-rust-migration.WIP.md` (21:45 to 22:20).

mod error;
mod picture;
mod sync;
mod tag;
mod text;

pub use error::Error;
pub use picture::{Picture, decode_picture, encode_picture};
pub use sync::{resynchronise, unsynchronise};
pub use tag::{Frame, Tag, Version, read, tag_len, write};
pub use text::{decode_text, encode_text};

#[cfg(test)]
mod tests;
