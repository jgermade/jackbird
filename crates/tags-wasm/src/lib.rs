//! `jackbird-tags` for the web app, built for `wasm32-unknown-unknown`
//! (`scripts/build-wasm.mjs`) and driven by `src/lib/tags/wasm.ts`. No
//! bindings crate: the module owns two buffers, an input and an output, and
//! exports a few functions over them (E2-D1 of
//! `RECORD/2026-08-11.musikmatch-rust-migration.WIP.md`, 2026-11-07 20:16).
//!
//! A call goes: `tags_input(len)` gives where to copy the request into the
//! module's memory; `tags_read`, `tags_write` or `tags_region` runs on it,
//! empties the input and returns 0 (done) or 1 (an error); `tags_output_ptr`
//! and `tags_output_len` say where the answer is, in the wire format of
//! [`wire`]; `tags_release` drops it. The prefix keeps the exports clear of
//! the C library's `read` and `write` when the crate is built natively, for
//! its tests.
//! Pointers leave the module as numbers and never come back as slices, so
//! there is no unsafe block: the only unsafe code is the exports' attribute.

pub mod wire;

use std::cell::RefCell;

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// The request, taken out of the input buffer.
fn take_input() -> Vec<u8> {
    INPUT.with_borrow_mut(std::mem::take)
}

/// Puts the answer in the output buffer and gives the status.
fn answer(result: Result<Vec<u8>, Vec<u8>>) -> u32 {
    let (status, bytes) = match result {
        Ok(bytes) => (0, bytes),
        Err(bytes) => (1, bytes),
    };
    OUTPUT.with_borrow_mut(|output| *output = bytes);
    status
}

/// Makes the input buffer `len` bytes long (zeroed), and gives where it
/// starts, for the caller to copy the request into. The output is dropped.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn tags_input(len: usize) -> *mut u8 {
    tags_release();
    INPUT.with_borrow_mut(|input| {
        *input = vec![0; len];
        input.as_mut_ptr()
    })
}

/// Reads the file in the input: the output is its tags, or the error.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn tags_read() -> u32 {
    let file = take_input();
    answer(
        jackbird_tags::read(&file)
            .map(|tags| wire::tags(&tags))
            .map_err(|error| wire::error(&error)),
    )
}

/// Writes the edit in the input into the file after it: the output is the
/// new file, or the error.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn tags_write() -> u32 {
    let request = take_input();
    answer(match wire::edit(&request) {
        Ok((edit, start)) => jackbird_tags::write(&request[start..], &edit).map_err(|error| wire::error(&error)),
        Err(why) => Err(wire::error(&jackbird_tags::Error::Unreadable(format!(
            "the request: {why}"
        )))),
    })
}

/// The audio region of the file in the input, which its audio checksum
/// hashes: the output is its start and end. Never fails.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn tags_region() -> u32 {
    let file = take_input();
    let range = jackbird_tags::audio_region(&file);
    answer(Ok(wire::region(range.start, range.end)))
}

/// Where the last answer starts.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn tags_output_ptr() -> *const u8 {
    OUTPUT.with_borrow(|output| output.as_ptr())
}

/// How long the last answer is.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn tags_output_len() -> usize {
    OUTPUT.with_borrow(Vec::len)
}

/// Drops the last answer, once the caller has copied it out.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn tags_release() {
    OUTPUT.with_borrow_mut(|output| *output = Vec::new());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(request: &[u8], run: extern "C" fn() -> u32) -> (u32, Vec<u8>) {
        tags_input(request.len());
        INPUT.with_borrow_mut(|input| input.copy_from_slice(request));
        let status = run();
        let out = OUTPUT.with_borrow(Clone::clone);
        assert_eq!(tags_output_len(), out.len());
        assert_eq!(tags_output_ptr(), OUTPUT.with_borrow(|output| output.as_ptr()));
        tags_release();
        assert_eq!(tags_output_len(), 0);
        (status, out)
    }

    /// A v2.3 tag holding a title, then a frame sync.
    fn mp3() -> Vec<u8> {
        let mut out = b"ID3\x03\x00\x00\x00\x00\x00\x0f".to_vec();
        out.extend_from_slice(b"TIT2\x00\x00\x00\x05\x00\x00\x00Kind");
        out.extend_from_slice(&[0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]);
        out
    }

    #[test]
    fn reads_writes_and_gives_regions_through_the_buffers() {
        let (status, out) = call(&mp3(), tags_read);
        assert_eq!(status, 0);
        assert_eq!(&out[..9], [0, 4, 0, 0, 0, b'K', b'i', b'n', b'd']);

        let mut request = vec![1, 5, 0, 0, 0];
        request.extend_from_slice(b"Blue!");
        request.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        request.extend_from_slice(&mp3());
        let (status, file) = call(&request, tags_write);
        assert_eq!(status, 0);
        assert_eq!(jackbird_tags::read(&file).unwrap().fields.title, "Blue!");

        let (status, out) = call(&mp3(), tags_region);
        assert_eq!(status, 0);
        assert_eq!(out, [25, 0, 0, 0, 33, 0, 0, 0]);
        assert_eq!(mp3().len(), 33);
    }

    #[test]
    fn answers_errors_with_their_code() {
        let (status, out) = call(b"nothing", tags_read);
        assert_eq!(status, 1);
        assert_eq!(&out[4..17], b"not-supported");
        let (status, out) = call(&[9], tags_write);
        assert_eq!(status, 1);
        assert_eq!(&out[4..14], b"unreadable");
        let mut request = vec![0; 6];
        request.push(0);
        request.extend_from_slice(b"nothing");
        let (status, out) = call(&request, tags_write);
        assert_eq!(status, 1);
        assert_eq!(&out[4..17], b"not-supported");
    }
}
