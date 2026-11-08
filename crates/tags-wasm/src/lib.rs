//! `jackbird-tags` for the web app, built for `wasm32-unknown-unknown`
//! (`scripts/build-wasm.mjs`) and driven by `src/lib/tags/wasm.ts`. No
//! bindings crate: the module owns two buffers, an input and an output, and
//! exports a few functions over them (E2-D1 of
//! `RECORD/2026-08-11.musikmatch-rust-migration.WIP.md`, 2026-11-07 20:16).
//!
//! A call goes: `tags_input(len)` gives where to copy the request into the
//! module's memory; `tags_layout`, `tags_read` or `tags_write` runs on it,
//! empties the input and returns 0 (done) or 1 (an error); `tags_output_ptr`
//! and `tags_output_len` say where the answer is, in the wire format of
//! [`wire`]; `tags_release` drops it. Only a file's head and tail come in
//! (E2b, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-08
//! 03:10): its audio never does. The prefix keeps the exports clear of
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

/// An error for a request the wire format refuses.
fn bad_request(why: String) -> Vec<u8> {
    wire::error(&jackbird_tags::Error::Unreadable(format!("the request: {why}")))
}

/// Where the file in the input's tags end and its audio is (the request: its
/// length, its tail, its head): the output is the layout, or how many first
/// bytes it needs.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn tags_layout() -> u32 {
    let request = take_input();
    answer(match wire::layout_request(&request) {
        Ok((len, tail, head)) => jackbird_tags::layout(head, tail, len)
            .and_then(|found| wire::layout(&found))
            .map_err(|error| wire::error(&error)),
        Err(why) => Err(bad_request(why)),
    })
}

/// Reads the tags of a file (the request: its layout and its head): the
/// output is its tags, or the error.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn tags_read() -> u32 {
    let request = take_input();
    answer(match wire::read_request(&request) {
        Ok((layout, head)) => jackbird_tags::read_head(head, &layout)
            .map(|tags| wire::tags(&tags))
            .map_err(|error| wire::error(&error)),
        Err(why) => Err(bad_request(why)),
    })
}

/// Writes an edit into a file's tags (the request: the edit, its layout and
/// its head): the output is the splice that saves it, or the error.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn tags_write() -> u32 {
    let request = take_input();
    answer(match wire::write_request(&request) {
        Ok((edit, layout, head)) => jackbird_tags::write_head(head, &layout, &edit)
            .and_then(wire::splice)
            .map_err(|error| wire::error(&error)),
        Err(why) => Err(bad_request(why)),
    })
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

    fn layout_request(file: &[u8], head: usize) -> Vec<u8> {
        let mut out = (file.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(&(file.len() as u32).to_le_bytes());
        out.extend_from_slice(file);
        out.extend_from_slice(&file[..head]);
        out
    }

    #[test]
    fn finds_reads_and_writes_through_the_buffers() {
        let file = mp3();
        assert_eq!(file.len(), 33);
        let (status, out) = call(&layout_request(&file, 4), tags_layout);
        assert_eq!((status, out), (0, vec![1, 10, 0, 0, 0]));
        let (status, out) = call(&layout_request(&file, 33), tags_layout);
        assert_eq!(status, 0);
        let layout = [0, 25, 0, 0, 0, 25, 0, 0, 0, 33, 0, 0, 0];
        assert_eq!(out, [&[0][..], &layout].concat());

        let (status, out) = call(&[&layout[..], &file[..25]].concat(), tags_read);
        assert_eq!(status, 0);
        assert_eq!(&out[..9], [0, 4, 0, 0, 0, b'K', b'i', b'n', b'd']);

        let mut request = vec![1, 5, 0, 0, 0];
        request.extend_from_slice(b"Blue!");
        request.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        request.extend_from_slice(&layout);
        request.extend_from_slice(&file[..25]);
        let (status, out) = call(&request, tags_write);
        assert_eq!(status, 0);
        assert_eq!(out[..4], [25, 0, 0, 0]);
        let saved = [&out[4..], &file[25..]].concat();
        assert_eq!(jackbird_tags::read(&saved).unwrap().fields.title, "Blue!");
    }

    #[test]
    fn answers_errors_with_their_code() {
        let (status, out) = call(&layout_request(b"nothing at all", 14), tags_layout);
        assert_eq!(status, 0);
        assert_eq!(out[1], 255);
        let none = [255, 0, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0];
        let (status, out) = call(&[&none[..], b"nothing"].concat(), tags_read);
        assert_eq!(status, 1);
        assert_eq!(&out[4..17], b"not-supported");
        let (status, out) = call(&[9], tags_write);
        assert_eq!(status, 1);
        assert_eq!(&out[4..14], b"unreadable");
        let (status, out) = call(&[1, 2], tags_layout);
        assert_eq!(status, 1);
        assert_eq!(&out[4..14], b"unreadable");
        let (status, out) = call(&[0; 3], tags_read);
        assert_eq!(status, 1);
        assert_eq!(&out[4..14], b"unreadable");
        let (status, out) = call(&layout_request(&mp3(), 4)[..10], tags_layout);
        assert_eq!(status, 1);
        assert_eq!(&out[4..14], b"unreadable");
    }
}
