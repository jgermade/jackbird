# E0 spike: lofty in wasm, and what it keeps

The code behind E0's points 1 and 2 of the Rust tag engine plan
([ROADMAP/2026-11-04/rust-tag-engine-and-tauri.md](../../ROADMAP/2026-11-04/rust-tag-engine-and-tauri.md)).
The plan, the results and the go are in
[RECORD/2026-08-11.musikmatch-rust-migration.WIP.md](../../RECORD/2026-08-11.musikmatch-rust-migration.WIP.md)
(2026-11-04, 18:10 to 18:35). It is kept as E1's starting point, and nothing in the app imports it;
the folder goes once E1 has taken what it needs.

| Path | What |
| --- | --- |
| `spike/src/lib.rs` | `lofty` over bytes: `read`, and three writers: `write_generic` (lofty's generic `Tag`), `write_concrete` (its `Id3v2Tag` and `VorbisComments`), `write_merged` (the concrete tags plus the steps that keep everything: changed fields only and in place, the year as a timestamp, v2.4 plain frame sizes normalised, the padding reused, a FLAC's leading ID3v2, and the strict re-read and audio check). `read_slim` and `write_merged_slim` do the same without `Probe`. |
| `spike/src/wasm.rs` | the JavaScript face (wasm-bindgen) |
| `spike/src/bin/semantics.rs` | builds the MP3 and FLAC fixtures byte by byte, edits them with the three writers, and reports what each kept |
| `spike/src/bin/bench.rs` | the benchmark, natively |
| `slim/` | a wasm build of only `read_slim` and `write_merged_slim`, to measure its size |
| `scripts/validate.py` | `mutagen` and `ffmpeg` on every file the semantics run wrote |
| `scripts/wasm-equiv.mjs` | the wasm writer against the native one, byte for byte; the module's memory |
| `scripts/make-bench.mjs` | tags the benchmark MP3 as `src/lib/id3.ts` does |
| `scripts/bench-chromium.cjs` | today's engine against the wasm, in Chromium on the dev server |
| `run-all.sh` | all of it, from nothing |

```bash
bash spikes/e0-lofty/run-all.sh
```

It needs Rust (it adds the `wasm32-unknown-unknown` target), Node 22, `ffmpeg`, `python3`, `curl`
and Playwright's Chromium, downloads `wasm-bindgen`'s CLI and binaryen's `wasm-opt`, and writes
everything (build output, fixtures, results) into `.tmp/e0/`, which git ignores.
