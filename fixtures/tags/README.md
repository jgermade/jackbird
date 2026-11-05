# Tag fixtures

Small MP3 and FLAC files for the tag engine's tests: `cargo test` runs them through `crates/tags`
(`crates/tags/tests/fixtures.rs`), and from E2 `npm test` runs them through the engine's wasm build.
`cases.json` says what each must give: its format, its six fields, its cover (file, MIME type,
SHA-1), its audio region (start, end, SHA-1) and what a save of a new title gives (`ok`, or the
error's code).

The tags and FLAC metadata blocks are built byte by byte around half a second of `ffmpeg` audio,
and one file is saved as today's app saves (`browser-id3-writer`, then `keepUneditedFrames`), so the
expectations come from how each file was built, not from the code under test. The audio regions of
the MP3 files are the ones `getAudioFrameSlice` (`src/lib/id3.ts`) gives.

They are committed, so the tests need neither `ffmpeg` nor Node. To make them again (the same bytes
for the same `ffmpeg`), after `npm ci`:

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning fixtures/tags/make.mjs
```

The cases: E0's eighteen frames in v2.3 and v2.4, unsynchronised, with plain v2.4 sizes, with an
extended header, a footer, an ID3v1 tag, an APEv2 tag; no tag; a v2.4 frame's own flags; duplicate
frames; a year that is not a date; empty frames; UTF-16 and several values; ID3v2.2; junk after the
frames; a file saved by today's app. FLAC: every kind of block, the padding first, none, an ID3v2 tag
before `fLaC`, no comments, odd comments, a track total and a PNG cover.
