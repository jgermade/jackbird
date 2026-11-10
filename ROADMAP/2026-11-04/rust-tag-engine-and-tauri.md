# Rust tag engine and Tauri v2

What is planned, in order. The reasoning lives in
[RECORD/2026-08-11.musikmatch-rust-migration.WIP.md](../../RECORD/2026-08-11.musikmatch-rust-migration.WIP.md)
(extension of 2026-11-04 12:44), which re-plans that record's milestones M2 and M5: the tag engine
first, then the desktop app, with the daemon, the SQLite index and the sync mesh deferred.

Dates are estimates from the day each step starts; each step ends with its "done when" met and a
walkthrough in the record. E0, the spike, is done: the rest goes ahead with the changes the record
lists (2026-11-04, 18:30 for E2, 21:45 to 22:20 for E1, 19:41 for E4's media URLs, approved with E4 on 2026-11-08).
E1 is done too (2026-11-04): jackbird's own tag crates replaced `lofty`. The web plan that ran
after it ([web-queue-views-renaming.md](web-queue-views-renaming.md)) is done as well. E2 is done
(2026-11-07, record from 20:16): the web app reads, writes and hashes through the engine as
WebAssembly, and its former tag libraries are gone. E3 is done too (2026-11-07, record from
22:28): FLAC libraries open, play, edit and save. E2b, asked after E3 (record, 2026-11-08 03:09
to 03:16), is done as well: the engine is given a file's tags and last bytes, never its audio, and
returns a splice. E4, the desktop app, is done too (2026-11-08, record from 10:52; CI passes its
unattended check on macOS, Windows and Linux). Next: the service
([../2026-11-08/service.md](../2026-11-08/service.md), S1 to S4; S1 and S2 done on 2026-11-08),
then the rest of the family instance ([family-instance.md](family-instance.md)), E5 and E6. The
family instance is done (F1 to F5, 2026-11-09), and so is E5 (2026-11-09, record from 19:37):
the desktop app plays through Rust, native and shared by default. E6's spike is done too
(2026-11-10, record from 2026-11-09 21:24 to the closing extension of 2026-11-10 12:37): the app runs on
Android and iOS as a client of an instance; a queue cannot go on in the background from the page,
so playback on the phones must be native. Next: E6b, the Player-first phone app with native
playback, **proposed in the record's closing extension and waiting for the owner's approval**.
Left to the owner by hand on real machines: E4's bundles (a folder chosen, heard, edited, the app
restarted).

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
    E3 FLAC                                    :done, e3, after e2, 4d
    E2b The engine by ranges and splices       :done, e2b, after e3, 3d
  section Desktop
    E4 Tauri v2 desktop app                    :done, e4, after e2b, 10d
    E5 Native audio output (hi-fi, optional)   :done, e5, after e4, 10d
  section Mobile
    E6 Tauri v2 mobile spike                   :done, e6, after e5, 2d
    E6b Phone app: native playback, offline    :e6b, after e6, 10d
```

| Step | Scope | Done when |
| --- | --- | --- |
| E0 Spike (**done**, 2026-11-04) | `lofty` built for `wasm32-unknown-unknown`; size and speed against today's engine on the 13 MB benchmark file; whether `lofty` keeps unedited ID3 frames, Vorbis comments and FLAC blocks; a Tauri v2 shell loading today's `dist/` on macOS, Windows and Linux (jq79, `<audio>`, the analyser) | go, with a merge layer in E1 (record, 18:30–19:41); the owner's run by hand of the CI bundles is pending |
| E1 Tag engine (**done**, 2026-11-04) | jackbird's own crates, with no tag dependency (record, 21:45 to 22:20): `crates/id3` (ID3v2 frames kept as raw bytes, text and picture codecs), `crates/flac` (blocks, Vorbis comment entries, pictures), `crates/tags` (the six fields and the cover over both, the audio region, the year rule, the refusals and three safeguards: fields read back, audio byte-identical, every unedited frame, block and comment kept byte for byte), with `cargo test` on shared fixtures | the fixtures pass, including every case the TypeScript `id3v2` tests cover |
| E2 Engine in the web (**done**, 2026-11-07) | `crates/tags-wasm` (no bindings crate: E2-D1, record 2026-11-07 20:16), covers removable (`CoverEdit`), `src/lib/tags/` with one interface and its wasm implementation, loaded lazily; `jsmediatags`, `browser-id3-writer` and `src/helpers/id3v2.ts` retired; checksums keep their definitions | `npm test` runs the fixtures against the wasm build; an existing `.meta/` reopens without re-reading any file; the first load is no slower |
| E3 FLAC (**done**, 2026-11-07) | the walk takes `.flac`; MIME types by extension; `Mp3Track` becomes `Track`; texts no longer say MP3 only | a FLAC library opens, plays, edits and saves, and every saved file decodes with `ffmpeg` and keeps its unedited comments and blocks |
| E2b By ranges (**done**, 2026-11-08) | the engine takes a file's head and tail (`layout`, `read_head`) and returns a splice (`write_head`); the module never gets the audio; the web app checks a saved file's audio region before giving it back; `AGENTS.md`'s rule of the crates says so | the module's memory after reading and saving a 150 MB file is about the size of its tags; every fixture gives the same bytes by both paths |
| E4 Tauri desktop (**done**, 2026-11-08; checked in CI on the three systems, the owner's run by hand pending) | `src-tauri/`: the same UI in the webview; a native `VFSAdapter` over Tauri commands and the folder dialog; tags and checksums run natively, on paths (no whole files over the IPC); the session keeps paths; playback streams from disk; release builds for macOS, Windows and Linux in GitHub Actions | the desktop app opens a folder, plays, edits and reopens it after a restart on all three systems |
| E5 Native output (**done**, 2026-11-09; native shared by default, exclusive and embedded to choose; gapless; CI on the three systems, bit for bit through ALSA's default device on Linux; the exclusive paths and the owner's run on macOS with the DAC pending) | optional: decoding and output in Rust, with exclusive / bit-perfect modes where the system offers them; the analyser fed from Rust; `<audio>` stays as the fallback | a 24/96 FLAC plays bit-perfect on at least one system, checked with a loopback or the device's own sample-rate display |
| E6 Mobile spike (**done**, 2026-11-10; CI in Android's emulator and iOS's simulator) | the web app in the phones' webviews as a client of an instance; background playback and the lock screen; local files (SAF, security-scoped bookmarks) weighed; OpenSubsonic checked with an outside client (py-opensonic) | decided by the spike, recorded before any build: our own app as a client, **native playback** on each phone, OpenSubsonic kept, local files later |
| E6b Phone app (**proposed**, waiting for the owner's approval) | a native player per phone (Android: Media3 in a `MediaSessionService`; iOS: `AVQueuePlayer` with now playing and remote commands) that plays the queue the page hands it; the played counts kept while the page is suspended; offline songs kept on the phone; the APK and the IPA on the release | on a real phone of each and in CI: a queue from the instance plays on with the screen off, its controls on the lock screen, a kept album plays without a connection, the counts reach the instance |

Deferred, decided separately: `.meta` v2 (covers out of the snapshot; SHA-256), the axum daemon and
the SQLite index, wiring the vfs-sync mesh, the rename to Musikmatch, scanning in a Web Worker.
