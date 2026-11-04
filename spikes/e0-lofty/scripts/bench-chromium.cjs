// E0.1 in Chromium, on the dev server: today's engine (src/lib/id3.ts) against
// the lofty wasm, on .tmp/e0/bench/bench.mp3. Medians of 9 runs after one
// discarded. node bench-chromium.cjs <release|speed>
const { chromium } = require("playwright");

const profile = process.argv[2] || "release";
const BASE = "http://localhost:8666";
const RUNS = 10;

async function inPage(browser, fn, arg) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // A page the dev server serves without starting the app.
  await page.goto(`${BASE}/.tmp/e0/bench/cover.jpg`);
  const result = await page.evaluate(fn, arg);
  await page.close();
  if (errors.length) console.error(errors);
  return result;
}

(async () => {
  const browser = await chromium.launch();
  const wasmJs = `/.tmp/e0/wasm/${profile}/e0_spike.js`;
  const wasmBin = `/.tmp/e0/wasm/${profile}/e0_spike_bg.opt.wasm`;

  // Loading: each in a fresh page (cold), then again in the same page (warm).
  const cold = [];
  let warm = [];
  for (let i = 0; i < 7; i += 1) {
    const r = await inPage(browser, async ({ wasmJs, wasmBin }) => {
      const bytes = await (await fetch(wasmBin)).arrayBuffer();
      const glue = await import(wasmJs);
      let t = performance.now();
      const module = await WebAssembly.compile(bytes);
      const compile = performance.now() - t;
      t = performance.now();
      glue.initSync({ module });
      const instantiate = performance.now() - t;
      const again = [];
      for (let j = 0; j < 5; j += 1) {
        const t2 = performance.now();
        await WebAssembly.compile(bytes);
        again.push(performance.now() - t2);
      }
      return { compile, instantiate, again };
    }, { wasmJs, wasmBin });
    cold.push(r);
    warm = warm.concat(r.again);
  }

  const timings = await inPage(browser, async ({ wasmJs, wasmBin, RUNS }) => {
    const id3 = await import("/src/lib/id3.ts");
    const glue = await import(wasmJs);
    await glue.default({ module_or_path: await (await fetch(wasmBin)).arrayBuffer() });
    const src = new Uint8Array(await (await fetch("/.tmp/e0/bench/bench.mp3")).arrayBuffer());
    const median = (xs) => { const s = xs.slice(1).sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    const time = async (fn) => {
      const xs = [];
      let last;
      for (let i = 0; i < RUNS; i += 1) {
        const t = performance.now();
        last = await fn();
        xs.push(performance.now() - t);
      }
      return { ms: median(xs), last };
    };

    const out = {};
    const todayRead = await time(() => id3.readTrackMetadataFromBytes(src, "bench.mp3"));
    out.todayRead = todayRead.ms;
    const meta = todayRead.last;
    const edit = { ...meta, title: "After" };
    const todayWrite = await time(() => id3.writeTrackMetadataToBytes(src, edit));
    out.todayWrite = todayWrite.ms;
    out.todayWriteSize = todayWrite.last.length;

    const wasmRead = await time(() => {
      const r = glue.read(src);
      const url = r.cover ? URL.createObjectURL(new Blob([r.cover], { type: r.cover_mime })) : null;
      const fields = { title: r.title, artist: r.artist, album: r.album, year: r.year, genre: r.genre, track: r.track, cover: r.cover, mime: r.cover_mime };
      if (url) URL.revokeObjectURL(url);
      r.free();
      return fields;
    });
    out.wasmRead = wasmRead.ms;
    const f = wasmRead.last;
    out.wasmReadFields = { title: f.title, artist: f.artist, album: f.album, year: f.year, genre: f.genre, track: f.track, cover: f.cover?.length };
    out.todayReadFields = { ...meta, coverDataUrl: meta.coverDataUrl?.length };
    // Only the fields: what the editor reads to fill a form (no cover URL).
    out.wasmReadNoUrl = (await time(() => { const r = glue.read(src); r.free(); })).ms;

    const write = (way, withCover) => () => glue.write(src, way, "After", f.artist, f.album, f.year, f.genre, f.track, withCover ? f.cover : undefined, f.mime);
    for (const [name, way] of [["merged", 2], ["concrete", 1], ["generic", 0]]) {
      for (const withCover of [false, true]) {
        const r = await time(write(way, withCover));
        out[`wasmWrite_${name}_${withCover ? "cover" : "title"}`] = r.ms;
        out[`wasmWrite_${name}_${withCover ? "cover" : "title"}_size`] = r.last.length;
      }
    }
    // The bytes written by the merged writer still read back, with the title.
    const check = glue.read(write(2, true)());
    out.roundTrip = { title: check.title, cover: check.cover?.length };
    out.sourceSize = src.length;
    out.wasmMemoryMB = glue.__wbg_get_imports ? undefined : undefined;
    return out;
  }, { wasmJs, wasmBin, RUNS });

  const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(JSON.stringify({
    profile,
    load: {
      coldCompileMs: med(cold.map((c) => c.compile)),
      coldInstantiateMs: med(cold.map((c) => c.instantiate)),
      warmCompileMs: med(warm),
      coldCompileAll: cold.map((c) => +c.compile.toFixed(1))
    },
    ...timings
  }, null, 2));
  await browser.close();
})();
