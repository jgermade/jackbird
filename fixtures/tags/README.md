# Tag fixtures

Small MP3 and FLAC files for the tag engine's tests: `cargo test` runs them through `crates/tags`
(`crates/tags/tests/fixtures.rs`), and from E2 `npm test` runs them through the engine's wasm build.
`cases.json` says what each must give: its format, its six fields, its cover (file, MIME type,
SHA-1), its audio region (start, end, SHA-1) and what a save of a new title gives (`ok`, or the
error's code).

The tags and FLAC metadata blocks are built byte by byte around half a second of `ffmpeg` audio,
and one file was saved as the app saved before E2 (`browser-id3-writer`, then `keepUneditedFrames`,
both retired since; the script keeps that file as it is), so the expectations come from how each
file was built, not from the code under test. The audio regions of the MP3 files are the ones the
app's checksums always hashed (`getAudioFrameSlice` before E2, `jackbird_tags::audio_region` now).

They are committed, so the tests need neither `ffmpeg` nor Node. To make them again (the same bytes
for the same `ffmpeg`):

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning fixtures/tags/make.mjs
```

The cases: E0's eighteen frames in v2.3 and v2.4, unsynchronised, with plain v2.4 sizes, with an
extended header, a footer, an ID3v1 tag, an APEv2 tag; no tag; a v2.4 frame's own flags; duplicate
frames; a year that is not a date; empty frames; UTF-16 and several values; ID3v2.2; junk after the
frames; a file saved by today's app. FLAC: every kind of block, the padding first, none, an ID3v2 tag
before `fLaC`, no comments, odd comments, a track total and a PNG cover.

## MPEG-4 audio (`.m4a`)

`make-m4a.mjs` makes `m4a-*.m4a` and `cases-m4a.json` (RECORD/2026-11-28.aac-m4a.WIP.md, A0): half
a second of `ffmpeg` audio (AAC, and Apple Lossless), whose samples the script lays out in chunks
in `mdat` and around which it writes every box (`ftyp`, `moov` with its sample tables, `udta`/
`meta`/`ilst`, `free`, `mdat`). Each case adds its codec; its audio region is `mdat`'s content. One
file, `m4a-made-by-afconvert.m4a`, was made by macOS's `afconvert` and is kept as it was made.

It is apart from `make.mjs` so that making these again leaves the MP3 and FLAC fixtures as they are
(another `ffmpeg` encodes other bytes); it reuses their covers.

```bash
node fixtures/tags/make-m4a.mjs
```

The cases: iTunes' layout (`moov` first, 1 KiB of `free` after `ilst`), the same with no `free`, with
`free` between `moov` and `mdat`, with `moov` last; 64-bit chunk offsets (`co64`); a 64-bit `mdat`
size; no `udta`; an empty `ilst`; QuickTime's `meta` without version and flags; Apple Lossless with
a PNG cover and a track and disc without totals; the genre as `gnre`; UTF-8 beyond Latin-1; and the
file `afconvert` made. Every field jackbird has, two covers, freeform atoms (`----`) and atoms it
does not know, which a save must keep.
