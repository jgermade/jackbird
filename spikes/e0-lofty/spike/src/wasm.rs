//! The spike's JavaScript face. Bytes in are copied into the module's memory
//! (`&[u8]` / `Vec<u8>`), bytes out are copied back as `Uint8Array`s.

use wasm_bindgen::prelude::*;

use crate::{Cover, Fields};

#[wasm_bindgen(getter_with_clone)]
pub struct ReadResult {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub year: String,
    pub genre: String,
    pub track: String,
    pub cover: Option<Vec<u8>>,
    pub cover_mime: String,
}

#[wasm_bindgen]
pub fn read(bytes: &[u8]) -> Result<ReadResult, JsError> {
    let (f, cover) = crate::read(bytes).map_err(|e| JsError::new(&e))?;
    let (cover, cover_mime) = match cover {
        Some(c) => (Some(c.data), c.mime),
        None => (None, String::new()),
    };
    Ok(ReadResult { title: f.title, artist: f.artist, album: f.album, year: f.year, genre: f.genre, track: f.track, cover, cover_mime })
}

#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn write(
    bytes: Vec<u8>,
    way: u8,
    title: String,
    artist: String,
    album: String,
    year: String,
    genre: String,
    track: String,
    cover: Option<Vec<u8>>,
    cover_mime: String,
) -> Result<Vec<u8>, JsError> {
    let fields = Fields { title, artist, album, year, genre, track };
    let cover = cover.map(|data| Cover { data, mime: cover_mime });
    // 0: lofty's generic Tag, 1: its concrete tags, 2: the merged writer.
    let out = match way {
        0 => crate::write_generic(bytes, &fields, cover.as_ref()),
        1 => crate::write_concrete(bytes, &fields, cover.as_ref()),
        _ => crate::write_merged(bytes, &fields, cover.as_ref()),
    };
    out.map_err(|e| JsError::new(&e))
}
