/**
 * The wire format between jackbird's tag engine, built as WebAssembly
 * (`crates/tags-wasm`), and the web app: the mirror of
 * `crates/tags-wasm/src/wire.rs`, which says what each message holds.
 * Little-endian; every string and run of bytes comes after its length, a u32.
 * See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-07 20:16, E2-D2).
 */

/** The six fields, in the engine's order (`Field::ALL`). */
export const WIRE_FIELDS = ["title", "artist", "album", "year", "genre", "track"] as const;

export type WireField = (typeof WIRE_FIELDS)[number];

/** A picture's bytes and MIME type. */
export type WireCover = { mime: string; data: Uint8Array };

/** What reading a file gives. */
export type WireTags = {
  format: "mp3" | "flac";
  fields: Record<WireField, string>;
  cover: WireCover | null;
};

/** What a write does: a field left out stays, "" removes it; the cover is kept, set or removed. */
export type WireEdit = {
  fields: Partial<Record<WireField, string>>;
  cover: { keep: true } | { set: WireCover } | { remove: true };
};

/** An error the engine gives: a stable code (`Error::code()`) and a message in English. */
export type WireError = { code: string; message: string };

/** Where a file's tags end and its audio is (`FileLayout`); `format` null for a file the engine does not read. */
export type WireLayout = {
  format: "mp3" | "flac" | null;
  /** The first byte after the tags: a save replaces the bytes before it. */
  tagsEnd: number;
  /** The region the audio checksum hashes. */
  audio: { start: number; end: number };
};

/** What `tags_layout` answers: the layout, or how many first bytes it needs. */
export type WireLayoutAnswer = { known: WireLayout } | { needHead: number };

/** What a save writes: the file's bytes up to `replaceEnd` replaced with `with`. */
export type WireSplice = { replaceEnd: number; with: Uint8Array };

/** How many of a file's last bytes the engine reads (`TAIL_LEN`). */
export const TAIL_LEN = 160;

/** How many first bytes to give the engine the first time (`FIRST_HEAD`). */
export const FIRST_HEAD = 64 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Reads the wire, or throws where it stops making sense. */
class Reader {
  private at = 0;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;

  // No parameter properties: the tests run with Node's type stripping, which refuses them.
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private need(length: number): void {
    if (this.at + length > this.bytes.length) {
      throw new Error(`the engine's answer ends early, at byte ${this.at}`);
    }
  }

  byte(): number {
    this.need(1);
    return this.bytes[this.at++];
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.at, true);
    this.at += 4;
    return value;
  }

  run(): Uint8Array {
    const length = this.u32();
    this.need(length);
    const out = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return out;
  }

  string(): string {
    return decoder.decode(this.run());
  }

  layout(): WireLayout {
    const format = this.byte();
    if (format !== 0 && format !== 1 && format !== 255) {
      throw new Error(`the engine's answer has format ${format}`);
    }
    const tagsEnd = this.u32();
    const start = this.u32();
    return { format: format === 0 ? "mp3" : format === 1 ? "flac" : null, tagsEnd, audio: { start, end: this.u32() } };
  }

  rest(): Uint8Array {
    const out = this.bytes.subarray(this.at);
    this.at = this.bytes.length;
    return out;
  }
}

/** A read's result. The cover's bytes are a copy, free of the buffer they came in. */
export function decodeTags(bytes: Uint8Array): WireTags {
  const reader = new Reader(bytes);
  const format = reader.byte();
  if (format > 1) {
    throw new Error(`the engine's answer has format ${format}`);
  }
  const fields = {} as Record<WireField, string>;
  for (const field of WIRE_FIELDS) {
    fields[field] = reader.string();
  }
  const cover = reader.byte() === 1 ? { mime: reader.string(), data: reader.run().slice() } : null;
  return { format: format === 0 ? "mp3" : "flac", fields, cover };
}

/** An error's code and message. */
export function decodeError(bytes: Uint8Array): WireError {
  const reader = new Reader(bytes);
  return { code: reader.string(), message: reader.string() };
}

/** `tags_layout`'s answer. */
export function decodeLayout(bytes: Uint8Array): WireLayoutAnswer {
  const reader = new Reader(bytes);
  return reader.byte() === 0 ? { known: reader.layout() } : { needHead: reader.u32() };
}

/** `tags_write`'s answer. The new bytes are a copy, free of the buffer they came in. */
export function decodeSplice(bytes: Uint8Array): WireSplice {
  const reader = new Reader(bytes);
  return { replaceEnd: reader.u32(), with: reader.rest().slice() };
}

/** Joins runs of bytes into one. */
function joined(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const u32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
};

const run = (bytes: Uint8Array): Uint8Array[] => [u32(bytes.length), bytes];

function layoutBytes(layout: WireLayout): Uint8Array[] {
  const format = layout.format === "mp3" ? 0 : layout.format === "flac" ? 1 : 255;
  return [Uint8Array.of(format), u32(layout.tagsEnd), u32(layout.audio.start), u32(layout.audio.end)];
}

/** `tags_layout`'s request: the file's length, its tail, its head. */
export function encodeLayout(length: number, tail: Uint8Array, head: Uint8Array): Uint8Array {
  return joined([u32(length), ...run(tail), head]);
}

/** `tags_read`'s request: the layout, then the head. */
export function encodeRead(layout: WireLayout, head: Uint8Array): Uint8Array {
  return joined([...layoutBytes(layout), head]);
}

/** `tags_write`'s request: the edit, the layout, then the head. */
export function encodeWrite(edit: WireEdit, layout: WireLayout, head: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const field of WIRE_FIELDS) {
    const value = edit.fields[field];
    parts.push(...(value === undefined ? [Uint8Array.of(0)] : [Uint8Array.of(1), ...run(encoder.encode(value))]));
  }
  if ("set" in edit.cover) {
    parts.push(Uint8Array.of(1), ...run(encoder.encode(edit.cover.set.mime)), ...run(edit.cover.set.data));
  } else {
    parts.push(Uint8Array.of("remove" in edit.cover ? 2 : 0));
  }
  return joined([...parts, ...layoutBytes(layout), head]);
}
