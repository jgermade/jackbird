// The web's iPod fixture (fixtures/ipod/web/, made by crates/ipod-wasm's own writers) against the
// built module (src/lib/ipod-db/ipod.wasm, scripts/build-wasm.mjs, which `npm test` runs first),
// as the app drives it: the songs, the images and a cover. RECORD/2026-11-14.ipod-sync.WIP.md, W1.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { IpodDbError, instantiate, type IpodDb } from "./wasm.ts";

const drive = new URL("../../../fixtures/ipod/web/iPod_Control/", import.meta.url);
const bytesOf = (name: string) => new Uint8Array(readFileSync(new URL(name, drive)));
const db: IpodDb = await instantiate(readFileSync(fileURLToPath(new URL("./ipod.wasm", import.meta.url))));

describe("the iPod module as wasm, on the fixture", () => {
  it("lists the songs as the database has them", () => {
    const listing = db.list(bytesOf("iTunes/iTunesCDB"));
    assert.equal(listing.name, "Test nano");
    assert.equal(listing.checksum, 3);
    assert.deepEqual(
      listing.songs.map((song) => [song.path, song.title, song.trackNumber, song.artwork]),
      [
        ["iPod_Control/Music/F00/AAAA.mp3", "First song", "1/2", 100],
        ["iPod_Control/Music/F01/BBBB.mp3", "Second song", "2/2", 100],
        ["iPod_Control/Music/F02/CCCC.m4a", 'Sin carátula "ni año"', "", null]
      ]
    );
    assert.deepEqual(listing.songs[0], {
      path: "iPod_Control/Music/F00/AAAA.mp3",
      size: 4000000,
      lengthMs: 197000,
      title: "First song",
      artist: "The Fixtures",
      album: "Fixtures",
      albumArtist: "The Fixtures",
      genre: "Rock",
      year: "2024",
      trackNumber: "1/2",
      discNumber: "1/1",
      compilation: false,
      pid: "-6450187065278421731",
      artwork: 100
    });
    assert.equal(listing.songs[2].compilation, true);
  });

  it("gives the images and a cover as a PNG", () => {
    const images = db.images(bytesOf("Artwork/ArtworkDB"));
    assert.deepEqual(images, [{ id: 100, file: "F1010_1.ithmb", offset: 0, size: 288, width: 12, height: 10, top: 1 }]);
    const [image] = images;
    const slot = bytesOf(`Artwork/${image.file}`).subarray(image.offset, image.offset + image.size);
    const png = db.cover(image, slot);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    // 12 × 9: the blank row above the image is left out.
    assert.deepEqual([view.getUint32(16), view.getUint32(20)], [12, 9]);
  });

  it("throws the module's message, and keeps working after it", () => {
    assert.throws(() => db.list(new TextEncoder().encode("not a database")), IpodDbError);
    assert.throws(() => db.cover({ id: 1, file: "", offset: 0, size: 0, width: 0, height: 0, top: 0 }, new Uint8Array()), /no pixels/);
    assert.equal(db.broken, false);
    assert.equal(db.list(bytesOf("iTunes/iTunesCDB")).songs.length, 3);
  });
});
