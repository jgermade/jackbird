# Rust tag engine and Tauri v2

What is planned, in order. The reasoning lives in
[RECORD/2026-08-11.musikmatch-rust-migration.WIP.md](../../RECORD/2026-08-11.musikmatch-rust-migration.WIP.md)
(extension of 2026-11-04 12:44), which re-plans that record's milestones M2 and M5: the tag engine
first, then the desktop app, with the daemon, the SQLite index and the sync mesh deferred.

Dates are estimates from the day each step starts; each step ends with its "done when" met and a
walkthrough in the record. E0, the spike, is done: the rest goes ahead with the changes the record
lists (2026-11-04, 18:30 for E2, 21:45 to 22:20 for E1, 19:41 for E4's media URLs, the latter awaiting approval).
E1 is done too (2026-11-04): jackbird's own tag crates replaced `lofty`. The web plan that ran
after it ([web-queue-views-renaming.md](web-queue-views-renaming.md)) is done as well. E2 is done
(2026-11-07, record from 20:16): the web app reads, writes and hashes through the engine as
WebAssembly, and its former tag libraries are gone. E3 (FLAC) and E4 (the desktop app) are next,
awaiting the owner's go.
After E4 comes the family instance ([family-instance.md](family-instance.md)).

```mermaid
gantt
  title Rust tag engine and Tauri v2
  dateFormat YYYY-MM-DD
  axisFormat %d %b
  section Decide
    E0 Spike: lofty in wasm, Tauri shell      :done, e0, 2026-11-04, 1d
  section Tag engine
    E1 Own tag crates (id3, flac, tags)       :done, e1, after e0, 5d
    E2 The engine in the web app (wasm)        :done, e2, after e1, 5d
    E3 FLAC                                    :e3, after e2, 4d
  section Desktop
    E4 Tauri v2 desktop app                    :e4, after e2, 10d
    E5 Native audio output (hi-fi, optional)   :e5, after e4, 10d
  section Mobile
    E6 Tauri v2 mobile (spike, then Player)    :e6, after e5, 10d
```

| Step | Scope | Done when |
| --- | --- | --- |
| E0 Spike (**done**, 2026-11-04) | `lofty` built for `wasm32-unknown-unknown`; size and speed against today's engine on the 13 MB benchmark file; whether `lofty` keeps unedited ID3 frames, Vorbis comments and FLAC blocks; a Tauri v2 shell loading today's `dist/` on macOS, Windows and Linux (jq79, `<audio>`, the analyser) | go, with a merge layer in E1 (record, 18:30–19:41); the owner's run by hand of the CI bundles is pending |
| E1 Tag engine (**done**, 2026-11-04) | jackbird's own crates, with no tag dependency (record, 21:45 to 22:20): `crates/id3` (ID3v2 frames kept as raw bytes, text and picture codecs), `crates/flac` (blocks, Vorbis comment entries, pictures), `crates/tags` (the six fields and the cover over both, the audio region, the year rule, the refusals and three safeguards: fields read back, audio byte-identical, every unedited frame, block and comment kept byte for byte), with `cargo test` on shared fixtures | the fixtures pass, including every case the TypeScript `id3v2` tests cover |
| E2 Engine in the web (**done**, 2026-11-07) | `crates/tags-wasm` (no bindings crate: E2-D1, record 2026-11-07 20:16), covers removable (`CoverEdit`), `src/lib/tags/` with one interface and its wasm implementation, loaded lazily; `jsmediatags`, `browser-id3-writer` and `src/helpers/id3v2.ts` retired; checksums keep their definitions | `npm test` runs the fixtures against the wasm build; an existing `.meta/` reopens without re-reading any file; the first load is no slower |
| E3 FLAC | the walk takes `.flac`; MIME types by extension; `Mp3Track` becomes `Track`; texts no longer say MP3 only | a FLAC library opens, plays, edits and saves, and every saved file decodes with `ffmpeg` and keeps its unedited comments and blocks |
| E4 Tauri desktop | `src-tauri/`: the same UI in the webview; a native `VFSAdapter` over Tauri commands and the folder dialog; tags and checksums run natively, on paths (no whole files over the IPC); the session keeps paths; playback streams from disk; release builds for macOS, Windows and Linux in GitHub Actions | the desktop app opens a folder, plays, edits and reopens it after a restart on all three systems |
| E5 Native output | optional: decoding and output in Rust, with exclusive / bit-perfect modes where the system offers them; the analyser fed from Rust; `<audio>` stays as the fallback | a 24/96 FLAC plays bit-perfect on at least one system, checked with a loopback or the device's own sample-rate display |
| E6 Mobile | a spike on file access (Android SAF, iOS security-scoped bookmarks), then a Player-first app | decided by the spike, recorded before any build |

Deferred, decided separately: `.meta` v2 (covers out of the snapshot; SHA-256), the axum daemon and
the SQLite index, wiring the vfs-sync mesh, the rename to Musikmatch, scanning in a Web Worker.
