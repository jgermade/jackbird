//! `jackbird-ipod` for the web app, built for `wasm32-unknown-unknown`
//! (`scripts/build-wasm.mjs`) and driven by `src/lib/ipod-db/wasm.ts`: an iPod
//! opened in the browser lists its songs as its database has them, with their
//! covers (`RECORD/2026-11-14.ipod-sync.WIP.md`, W1). No bindings crate, as
//! `crates/tags-wasm`: the module owns two buffers, an input and an output, and
//! exports a few functions over them.
//!
//! A call goes: `ipod_input(len)` gives where to copy the request into the
//! module's memory; `ipod_list`, `ipod_artwork` or `ipod_cover` runs on it,
//! empties the input and returns 0 (done) or 1 (an error, its message in the
//! output as UTF-8); `ipod_output_ptr` and `ipod_output_len` say where the
//! answer is; `ipod_release` drops it. The audio never comes in: only the
//! databases and the covers' slots of the image files.
//! Pointers leave the module as numbers and never come back as slices, so
//! there is no unsafe block: the only unsafe code is the exports' attribute.

pub mod json;

#[cfg(test)]
mod fixture;

use std::cell::RefCell;

use jackbird_ipod::artwork::{self, ArtworkDb, Thumb};
use jackbird_ipod::{cdb, db, device};
use json::Json;

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// The request, taken out of the input buffer.
fn take_input() -> Vec<u8> {
    INPUT.with_borrow_mut(std::mem::take)
}

/// Puts the answer in the output buffer and gives the status.
fn answer(result: Result<Vec<u8>, String>) -> u32 {
    let (status, bytes) = match result {
        Ok(bytes) => (0, bytes),
        Err(message) => (1, message.into_bytes()),
    };
    OUTPUT.with_borrow_mut(|output| *output = bytes);
    status
}

/// "3/12", "3" or "", as the desktop app gives a track's or disc's number.
fn numbered(n: u32, total: u32) -> String {
    match (n, total) {
        (0, _) => String::new(),
        (n, 0) => n.to_string(),
        (n, total) => format!("{n}/{total}"),
    }
}

/// The songs of a database (an `iTunesCDB` or an `iTunesDB`), as JSON: the
/// master playlist's name, the checksum scheme, and each song that has a file,
/// with the fields the desktop app's `ipod_tracks` gives.
pub fn list(data: &[u8]) -> Result<String, String> {
    let data = cdb::inflate(data).map_err(|e| e.to_string())?;
    let database = db::parse(&data).map_err(|e| e.to_string())?;
    let mut json = Json::default();
    json.open(None);
    match database
        .playlists
        .iter()
        .find(|p| p.master)
        .and_then(|p| p.name.as_deref())
    {
        Some(name) => json.text("name", name),
        None => json.null("name"),
    };
    json.number("checksum", database.checksum_scheme);
    json.open_list(Some("songs"));
    for track in &database.tracks {
        let Some(path) = track.path() else { continue };
        let text = |s: &Option<String>| s.clone().unwrap_or_default();
        json.open(None)
            .text("path", &path)
            .number("size", track.size)
            .number("lengthMs", track.length_ms)
            .number("bpm", track.bpm)
            .text("title", &text(&track.title))
            .text("artist", &text(&track.artist))
            .text("album", &text(&track.album))
            .text("albumArtist", &text(&track.album_artist))
            .text("genre", &text(&track.genre))
            .text(
                "year",
                &if track.year == 0 {
                    String::new()
                } else {
                    track.year.to_string()
                },
            )
            .text("trackNumber", &numbered(track.track_number, track.track_count))
            .text("discNumber", &numbered(track.disc_number, track.disc_count))
            .flag("compilation", track.compilation)
            // As the desktop app gives it: the 64 bits as a signed number, in a string (a
            // JavaScript number cannot hold it).
            .text("pid", &(track.database_id as i64).to_string());
        match track.artwork_id {
            Some(id) => json.number("artwork", id),
            None => json.null("artwork"),
        };
        json.close();
    }
    json.close_list().close();
    Ok(json.finish())
}

/// The images of an `ArtworkDB`, as JSON: for each, its largest size, where
/// it is (its file, without the leading ':', its offset and bytes) and its
/// width, height and blank top rows, which `ipod_cover` takes back.
pub fn images(data: &[u8]) -> Result<String, String> {
    let artwork = ArtworkDb::parse(data).map_err(|e| e.to_string())?;
    let mut json = Json::default();
    json.open(None).open_list(Some("images"));
    for image in artwork.images() {
        let Some(t) = image.largest() else { continue };
        json.open(None)
            .number("id", image.id)
            .text("file", t.file.trim_start_matches(':'))
            .number("offset", t.offset)
            .number("size", t.size)
            .number("width", t.width)
            .number("height", t.height)
            .number("top", t.top)
            .close();
    }
    json.close_list().close();
    Ok(json.finish())
}

/// A cover as a PNG. The request: its width, height and blank top rows (each
/// two bytes, little-endian; `top` signed), two bytes of nothing, then its slot.
pub fn cover(request: &[u8]) -> Result<Vec<u8>, String> {
    let at = |i: usize| -> Result<[u8; 2], String> {
        request
            .get(i..i + 2)
            .map(|b| [b[0], b[1]])
            .ok_or_else(|| "the request: too short".to_string())
    };
    let (width, height, top) = (
        u16::from_le_bytes(at(0)?),
        u16::from_le_bytes(at(2)?),
        i16::from_le_bytes(at(4)?),
    );
    let slot = request.get(8..).unwrap_or(&[]);
    let thumb = Thumb {
        format: 0,
        file: String::new(),
        offset: 0,
        size: slot.len() as u32,
        height,
        top,
        left: 0,
        width,
    };
    artwork::cover_png(slot, &thumb).ok_or_else(|| "the cover has no pixels".to_string())
}

/// What an iPod says of itself (`device::facts`), as JSON. The request: three texts, `SysInfo`,
/// `SysInfoExtended` and `.rockbox/rockbox-info.txt`, each its length (four bytes, little-endian;
/// `0xFFFFFFFF` for a file the drive does not have) then its UTF-8.
pub fn device_facts(request: &[u8]) -> Result<String, String> {
    let mut texts: Vec<Option<String>> = Vec::new();
    let mut at = 0;
    for _ in 0..3 {
        let len = request
            .get(at..at + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .ok_or_else(|| "the request: too short".to_string())?;
        at += 4;
        if len == u32::MAX {
            texts.push(None);
            continue;
        }
        let bytes = request
            .get(at..at + len as usize)
            .ok_or_else(|| "the request: too short".to_string())?;
        texts.push(Some(String::from_utf8_lossy(bytes).into_owned()));
        at += len as usize;
    }
    let facts = device::facts(texts[0].as_deref(), texts[1].as_deref(), texts[2].as_deref());
    let mut json = Json::default();
    json.open(None);
    for (key, value) in [
        ("modelNumber", &facts.model_number),
        ("familyId", &facts.family_id),
        ("firmware", &facts.firmware),
        ("serial", &facts.serial),
        ("rockbox", &facts.rockbox),
    ] {
        match value {
            Some(v) => json.text(key, v),
            None => json.null(key),
        };
    }
    json.close();
    Ok(json.finish())
}

/// [`device_facts`] on the request in the input.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ipod_device() -> u32 {
    answer(device_facts(&take_input()).map(String::into_bytes))
}

/// Makes the input buffer `len` bytes long (zeroed), and gives where it
/// starts, for the caller to copy the request into. The output is dropped.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ipod_input(len: usize) -> *mut u8 {
    ipod_release();
    INPUT.with_borrow_mut(|input| {
        *input = vec![0; len];
        input.as_mut_ptr()
    })
}

/// [`list`] on the database in the input.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ipod_list() -> u32 {
    answer(list(&take_input()).map(String::into_bytes))
}

/// [`images`] on the `ArtworkDB` in the input.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ipod_artwork() -> u32 {
    answer(images(&take_input()).map(String::into_bytes))
}

/// [`cover`] on the request in the input.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ipod_cover() -> u32 {
    answer(cover(&take_input()))
}

/// Where the last answer starts.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ipod_output_ptr() -> *const u8 {
    OUTPUT.with_borrow(|output| output.as_ptr())
}

/// How long the last answer is.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ipod_output_len() -> usize {
    OUTPUT.with_borrow(Vec::len)
}

/// Drops the last answer, once the caller has copied it out.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ipod_release() {
    OUTPUT.with_borrow_mut(|output| *output = Vec::new());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(request: &[u8], run: extern "C" fn() -> u32) -> (u32, Vec<u8>) {
        ipod_input(request.len());
        INPUT.with_borrow_mut(|input| input.copy_from_slice(request));
        let status = run();
        let out = OUTPUT.with_borrow(Clone::clone);
        assert_eq!(ipod_output_len(), out.len());
        assert_eq!(ipod_output_ptr(), OUTPUT.with_borrow(|output| output.as_ptr()));
        ipod_release();
        assert_eq!(ipod_output_len(), 0);
        (status, out)
    }

    #[test]
    fn lists_the_songs_of_the_fixture() {
        let files = fixture::files();
        let (status, out) = call(&files.cdb, ipod_list);
        assert_eq!(status, 0);
        let text = String::from_utf8(out).unwrap();
        assert!(text.starts_with(r#"{"name":"Test nano","checksum":3,"songs":[{"path":"iPod_Control/Music/F00/AAAA.mp3","size":4000000,"lengthMs":197000,"bpm":0,"title":"First song","artist":"The Fixtures""#), "{text}");
        assert!(text.contains(r#""trackNumber":"1/2","discNumber":"1/1","compilation":false,"pid":"-6450187065278421731","artwork":100}"#), "{text}");
        assert!(text.contains(r#""title":"Sin carátula \"ni año\"""#), "{text}");
        assert!(
            text.contains(r#""year":"","trackNumber":"","discNumber":"","compilation":true,"pid":"3","artwork":null}"#),
            "{text}"
        );
        assert_eq!(text.matches(r#""path""#).count(), 3);
        // An iTunesDB (not compressed) reads the same.
        let (status, plain) = call(&files.db, ipod_list);
        assert_eq!((status, String::from_utf8(plain).unwrap()), (0, text));
    }

    #[test]
    fn gives_the_images_and_their_covers() {
        let files = fixture::files();
        let (status, out) = call(&files.artwork, ipod_artwork);
        assert_eq!(status, 0);
        assert_eq!(
            String::from_utf8(out).unwrap(),
            r#"{"images":[{"id":100,"file":"F1010_1.ithmb","offset":0,"size":288,"width":12,"height":10,"top":1}]}"#
        );
        let mut request = vec![12, 0, 10, 0, 1, 0, 0, 0];
        request.extend_from_slice(&files.ithmb[..288]);
        let (status, png) = call(&request, ipod_cover);
        assert_eq!(status, 0);
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        // 12 × 9: the blank row above the image is left out.
        assert_eq!(&png[16..24], &[0, 0, 0, 12, 0, 0, 0, 9]);
    }

    #[test]
    fn gives_what_the_ipod_says_of_itself() {
        let text = |t: &str| [&(t.len() as u32).to_le_bytes()[..], t.as_bytes()].concat();
        let mut request = text("ModelNumStr: xA623\n");
        request.extend(u32::MAX.to_le_bytes());
        request.extend(text("Version: 3.15\n"));
        let (status, out) = call(&request, ipod_device);
        assert_eq!(status, 0);
        assert_eq!(
            String::from_utf8(out).unwrap(),
            r#"{"modelNumber":"xA623","familyId":null,"firmware":null,"serial":null,"rockbox":"3.15"}"#
        );
        let (status, _) = call(&[1, 0, 0], ipod_device);
        assert_eq!(status, 1);
        let (status, _) = call(&[9, 0, 0, 0, b'x'], ipod_device);
        assert_eq!(status, 1);
    }

    #[test]
    fn answers_errors_with_their_message() {
        let (status, out) = call(b"not a database", ipod_list);
        assert_eq!(status, 1);
        assert!(!out.is_empty());
        let (status, _) = call(b"mhfd", ipod_artwork);
        assert_eq!(status, 1);
        let (status, out) = call(&[1, 0], ipod_cover);
        assert_eq!((status, out), (1, b"the request: too short".to_vec()));
        let (status, out) = call(&[0; 8], ipod_cover);
        assert_eq!((status, out), (1, b"the cover has no pixels".to_vec()));
    }
}
