// Tags the benchmark MP3 the way src/lib/id3.ts writes a save (browser-id3-writer,
// six frames and a cover): node make-bench.mjs <audio.mp3> <cover.jpg> <out.mp3>
import { readFileSync, writeFileSync } from "node:fs";
import { ID3Writer } from "browser-id3-writer";

const [audio, cover, out] = process.argv.slice(2);
const writer = new ID3Writer(readFileSync(audio).buffer);
writer.setFrame("TIT2", "Bench").setFrame("TPE1", ["Artist"]).setFrame("TALB", "Album")
  .setFrame("TYER", "1959").setFrame("TCON", ["Jazz"]).setFrame("TRCK", "3/12")
  .setFrame("APIC", { type: 3, data: readFileSync(cover), description: "Cover", useUnicodeEncoding: false, mimeType: "image/jpeg" });
writer.addTag();
writeFileSync(out, Buffer.from(writer.arrayBuffer));
console.log("wrote", out, writer.arrayBuffer.byteLength, "bytes");
