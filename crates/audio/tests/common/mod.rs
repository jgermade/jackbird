//! What the tests share: the fixtures (`fixtures/audio/`, made by its `make.mjs`) and the PCM as
//! FLAC's MD5 is defined over it.

#![allow(dead_code)]

use std::path::PathBuf;

use jackbird_audio::Source;
use md5::{Digest, Md5};
use serde_json::Value;

/// A fixture's path.
pub fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/audio")
        .join(name)
}

/// What `cases.json` says of a fixture.
pub fn case(name: &str) -> Value {
    let text = std::fs::read_to_string(fixture("cases.json")).expect("cases.json");
    let cases: Value = serde_json::from_str(&text).expect("cases.json is JSON");
    cases[name].clone()
}

/// Samples (right-aligned at `bits`) as FLAC's MD5 takes them: little-endian, signed, in as many
/// bytes as the depth needs.
pub fn pcm_bytes(samples: &[i32], bits: u32) -> Vec<u8> {
    let width = bits.div_ceil(8) as usize;
    samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes()[..width].to_vec())
        .collect()
}

/// An MD5 in hexadecimal.
pub fn md5_hex(bytes: &[u8]) -> String {
    Md5::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A whole file decoded.
pub fn decode_all(name: &str) -> (Source, Vec<i32>) {
    let mut source = Source::open(&fixture(name)).expect("the fixture opens");
    let mut samples = Vec::new();
    while let Some(block) = source.next_block().expect("it decodes") {
        samples.extend_from_slice(block);
    }
    (source, samples)
}
