// The wasm build gives the same bytes as the native one: for every source the
// semantics run wrote, the merged writer through the wasm must reproduce the
// native output byte for byte. Then the wasm memory after one benchmark save.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// The work folder: <repo>/.tmp/e0 (see ../run-all.sh).
const e0 = new URL("../../../.tmp/e0/", import.meta.url).pathname;
const { initSync, read, write } = await import(join(e0, "wasm/release/e0_spike.js"));
const exports = initSync({ module: readFileSync(join(e0, "wasm/release/e0_spike_bg.opt.wasm")) });
const out = join(e0, "out");
const newCover = readFileSync(join(e0, "fixtures/cover9.jpg"));
let same = 0, differ = 0;
for (const name of readdirSync(out).filter((n) => n.includes(".src."))) {
  const [kase, , ext] = name.split(".");
  const src = readFileSync(join(out, name));
  const r = read(src);
  const fields = [r.title, r.artist, r.album, r.year, r.genre, r.track];
  r.free();
  for (const [what, cover] of [["title", undefined], ["title-cover", newCover]]) {
    const wasm = write(src, 2, "After", ...fields.slice(1), cover, "image/jpeg");
    const native = readFileSync(join(out, `${kase}.merged.${what}.${ext}`));
    if (Buffer.compare(Buffer.from(wasm), native) === 0) same += 1;
    else { differ += 1; console.log("DIFFERS", kase, what); }
  }
}
console.log(`wasm vs native, merged writer: ${same} identical, ${differ} different`);

const before = exports.memory.buffer.byteLength;
const bench = readFileSync(join(e0, "bench/bench.mp3"));
const r = read(bench);
const cover = r.cover;
write(bench, 2, "After", r.artist, r.album, r.year, r.genre, r.track, cover, r.cover_mime);
console.log(`wasm memory: ${(before / 2 ** 20).toFixed(1)} MB before, ${(exports.memory.buffer.byteLength / 2 ** 20).toFixed(1)} MB after reading and saving the ${(bench.length / 2 ** 20).toFixed(1)} MB file (it never shrinks)`);
for (let i = 0; i < 5; i += 1) write(bench, 2, "After", r.artist, r.album, r.year, r.genre, r.track, cover, r.cover_mime);
console.log(`after five more saves: ${(exports.memory.buffer.byteLength / 2 ** 20).toFixed(1)} MB`);
