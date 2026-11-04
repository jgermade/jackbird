#!/usr/bin/env bash
# E0, points 1 and 2, from nothing: fixtures, builds, the write-semantics run and its
# independent checks, the wasm sizes, wasm against native, and the Chromium benchmark.
# Needs Rust (with the wasm32-unknown-unknown target), Node 22, ffmpeg, python3, curl and
# Playwright's Chromium; everything it makes goes into <repo>/.tmp/e0/.
# See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (18:10, 18:30).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="$repo/.tmp/e0"
export CARGO_TARGET_DIR="$work/target"
mkdir -p "$work"/{fixtures,bench,tools,wasm}
cd "$work"

# Tools: wasm-bindgen's CLI (the same version as the crate's) and binaryen's wasm-opt.
WB="$work/tools/wasm-bindgen-0.2.130-x86_64-unknown-linux-musl/wasm-bindgen"
OPT="$work/tools/binaryen-version_124/bin/wasm-opt"
if [ ! -x "$WB" ]; then
  curl -sSL https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.130/wasm-bindgen-0.2.130-x86_64-unknown-linux-musl.tar.gz | tar -xz -C tools
fi
if [ ! -x "$OPT" ]; then
  curl -sSL https://github.com/WebAssembly/binaryen/releases/download/version_124/binaryen-version_124-x86_64-linux.tar.gz | tar -xz -C tools
fi
[ -d venv ] || { python3 -m venv venv && venv/bin/pip install -q mutagen==1.48.1 brotli; }
rustup target add wasm32-unknown-unknown >/dev/null

# Fixtures: 3 s of tone with no tags, and three small real JPEGs.
ff="ffmpeg -hide_banner -loglevel error -y"
$ff -f lavfi -i "sine=frequency=440:duration=3" -c:a libmp3lame -b:a 128k -id3v2_version 0 -write_xing 0 -map_metadata -1 fixtures/audio.mp3
$ff -f lavfi -i "sine=frequency=440:duration=3" -c:a flac -map_metadata -1 fixtures/audio.flac
for i in 1 2 9; do $ff -f lavfi -i "testsrc=size=$((40 + i * 8))x$((40 + i * 8))" -frames:v 1 -q:v 5 "fixtures/cover$i.jpg"; done

# 2. Write semantics: three writers, ten cases, two edits; then mutagen and ffmpeg on every file.
cargo build --quiet --release --manifest-path "$here/spike/Cargo.toml" --bins
rm -rf out
COVERS=fixtures "$CARGO_TARGET_DIR/release/semantics" fixtures/audio.mp3 fixtures/audio.flac out > semantics.txt
venv/bin/python -I "$here/scripts/validate.py" out > validate.txt
tail -1 validate.txt

# 1. The wasm builds: every format (through Probe) and MP3 + FLAC only (slim).
cargo build --quiet --lib --target wasm32-unknown-unknown --release --manifest-path "$here/spike/Cargo.toml"
cargo build --quiet --target wasm32-unknown-unknown --release --manifest-path "$here/slim/Cargo.toml"
"$WB" --target web --out-dir wasm/release "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/e0_spike.wasm"
"$WB" --target web --out-dir wasm/slim "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/e0_slim.wasm"
"$OPT" -Oz --strip-debug --strip-producers wasm/release/e0_spike_bg.wasm -o wasm/release/e0_spike_bg.opt.wasm
"$OPT" -Oz --strip-debug --strip-producers wasm/slim/e0_slim_bg.wasm -o wasm/slim/e0_slim_bg.opt.wasm
venv/bin/python -I - <<'EOF'
import gzip, brotli, pathlib
for p in ["wasm/release/e0_spike_bg.opt.wasm", "wasm/slim/e0_slim_bg.opt.wasm", "wasm/release/e0_spike.js"]:
    b = pathlib.Path(p).read_bytes()
    print(f"{p:36} raw {len(b)/1024:7.1f} KB  gzip-9 {len(gzip.compress(b, 9))/1024:6.1f} KB  brotli-11 {len(brotli.compress(b, quality=11))/1024:6.1f} KB")
EOF

# The benchmark file: 5 min at 320 kbps and a ~1.4 MB cover, tagged as src/lib/id3.ts writes.
$ff -f lavfi -i "anoisesrc=d=300:c=pink:r=44100:a=0.3" -ac 2 -c:a libmp3lame -b:a 320k -id3v2_version 0 -write_xing 0 -map_metadata -1 bench/bench-audio.mp3
$ff -f lavfi -i "nullsrc=s=1200x1200,geq=lum='random(1)*255':cb='128+random(2)*60':cr='128+random(3)*60'" -frames:v 1 -q:v 2 bench/cover.jpg
node "$here/scripts/make-bench.mjs" bench/bench-audio.mp3 bench/cover.jpg bench/bench.mp3

# wasm against native, and the module's memory.
node "$here/scripts/wasm-equiv.mjs"

# Natively (the Tauri path).
"$CARGO_TARGET_DIR/release/bench" bench/bench.mp3

# In Chromium, on the dev server (started here when nothing listens on 8666).
started=""
if ! curl -s -o /dev/null http://localhost:8666/; then
  (cd "$repo" && npx vite --port 8666 --strictPort > "$work/vite.log" 2>&1 &)
  started=1
  for _ in $(seq 1 60); do curl -s -o /dev/null http://localhost:8666/ && break; sleep 0.5; done
fi
node "$here/scripts/bench-chromium.cjs" release | tee bench-release.json
[ -z "$started" ] || pkill -f "vite --port 8666" || true
