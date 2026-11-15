/**
 * An iPod's databases as WebAssembly: the glue over `crates/ipod-wasm`'s exports, written by hand
 * as `../tags/wasm.ts` is (RECORD/2026-11-14.ipod-sync.WIP.md, W1). A call copies its request into
 * the module's input buffer, runs, and copies the answer out of its output buffer: JSON for the
 * songs and the images, a PNG for a cover, a UTF-8 message for an error. The module is built by
 * `scripts/build-wasm.mjs` into `./ipod.wasm`, and is loaded only when an iPod is opened.
 */

type Exports = {
  memory: WebAssembly.Memory;
  ipod_input(length: number): number;
  ipod_list(): number;
  ipod_artwork(): number;
  ipod_cover(): number;
  ipod_device(): number;
  ipod_output_ptr(): number;
  ipod_output_len(): number;
  ipod_release(): void;
};

/** A song as the iPod's database lists it, with the fields the desktop app's `ipod_tracks` gives. */
export type IpodSong = {
  /** Its file, relative to the iPod's root, with `/`. */
  path: string;
  size: number;
  lengthMs: number;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  genre: string;
  year: string;
  /** "3/12", "3" or "". */
  trackNumber: string;
  discNumber: string;
  compilation: boolean;
  /** Its 64-bit ID in the database, as a signed number in a string. */
  pid: string;
  /** Its cover's image in the `ArtworkDB`, if it has one. */
  artwork: number | null;
};

/** What an iPod's database holds. */
export type IpodListing = {
  /** Its master playlist's name. */
  name: string | null;
  /** The checksum scheme its header names (3: `hashAB`, the nano 6G and 7G). */
  checksum: number;
  songs: IpodSong[];
};

/** An image of the `ArtworkDB`: its largest size, and where that is in its file. */
export type IpodImage = {
  id: number;
  /** Its file, under `iPod_Control/Artwork/`. */
  file: string;
  offset: number;
  size: number;
  width: number;
  height: number;
  /** Blank rows above it. */
  top: number;
};

/** What an iPod says of itself in its files (`device::facts`). */
export type IpodFacts = {
  modelNumber: string | null;
  familyId: string | null;
  firmware: string | null;
  serial: string | null;
  rockbox: string | null;
};

/** An error of the module: its message, or a trap (`broken`). */
export class IpodDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpodDbError";
  }
}

/** What the module does. Once a call breaks it (`broken`), it is not used again. */
export type IpodDb = {
  /** The songs of an `iTunesCDB` or `iTunesDB`. */
  list(database: Uint8Array): IpodListing;
  /** The images of an `ArtworkDB`. */
  images(artworkDb: Uint8Array): IpodImage[];
  /** An image's cover as a PNG, from its slot (`image.size` bytes at `image.offset` in its file). */
  cover(image: IpodImage, slot: Uint8Array): Uint8Array;
  /** What the iPod says of itself, from `SysInfo`, `SysInfoExtended` and `rockbox-info.txt` (null for one it lacks). */
  device(sysinfo: string | null, extended: string | null, rockboxInfo: string | null): IpodFacts;
  readonly broken: boolean;
};

/** The module over an instance of it. */
export function ipodDbOf(instance: WebAssembly.Instance): IpodDb {
  const exports = instance.exports as unknown as Exports;
  let broken = false;

  // One call: the request in, `run`, the answer out (a copy), or the error thrown.
  const call = (request: Uint8Array, run: () => number): Uint8Array => {
    if (broken) throw new IpodDbError("the iPod module stopped after an earlier failure");
    let status: number;
    let answer: Uint8Array;
    try {
      const at = exports.ipod_input(request.length);
      // The memory may have grown: its buffer is read after every call.
      new Uint8Array(exports.memory.buffer, at, request.length).set(request);
      status = run();
      answer = new Uint8Array(exports.memory.buffer, exports.ipod_output_ptr(), exports.ipod_output_len()).slice();
      exports.ipod_release();
    } catch (error) {
      // A trap (a panic, or out of memory) leaves the module in no known state.
      broken = true;
      throw new IpodDbError(`the iPod module failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (status !== 0) throw new IpodDbError(new TextDecoder().decode(answer));
    return answer;
  };
  const json = <T>(answer: Uint8Array): T => JSON.parse(new TextDecoder().decode(answer)) as T;

  return {
    list: (database) => json<IpodListing>(call(database, exports.ipod_list)),
    images: (artworkDb) => json<{ images: IpodImage[] }>(call(artworkDb, exports.ipod_artwork)).images,
    cover(image, slot) {
      const request = new Uint8Array(8 + slot.length);
      const view = new DataView(request.buffer);
      view.setUint16(0, image.width, true);
      view.setUint16(2, image.height, true);
      view.setInt16(4, image.top, true);
      request.set(slot, 8);
      return call(request, exports.ipod_cover);
    },
    device(...texts) {
      const encoded = texts.map((text) => (text === null ? null : new TextEncoder().encode(text)));
      const request = new Uint8Array(encoded.reduce((sum, bytes) => sum + 4 + (bytes?.length ?? 0), 0));
      const view = new DataView(request.buffer);
      let at = 0;
      for (const bytes of encoded) {
        view.setUint32(at, bytes ? bytes.length : 0xffffffff, true);
        at += 4;
        if (bytes) {
          request.set(bytes, at);
          at += bytes.length;
        }
      }
      return json<IpodFacts>(call(request, exports.ipod_device));
    },
    get broken() {
      return broken;
    }
  };
}

/** The module from its bytes (tests, which read `ipod.wasm` from disk). */
export async function instantiate(module: BufferSource): Promise<IpodDb> {
  const { instance } = await WebAssembly.instantiate(module, {});
  return ipodDbOf(instance);
}

/** The module in the app: fetched next to this file, compiled while it downloads. */
export async function load(): Promise<IpodDb> {
  const url = new URL("./ipod.wasm", import.meta.url);
  const response = await fetch(url);
  if (!response.ok) throw new IpodDbError(`the iPod module could not be loaded (${response.status})`);
  try {
    const { instance } = await WebAssembly.instantiateStreaming(response.clone(), {});
    return ipodDbOf(instance);
  } catch {
    // A server that does not say application/wasm: compiled from the bytes instead.
    return instantiate(await response.arrayBuffer());
  }
}
