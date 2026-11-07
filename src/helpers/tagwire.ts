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

/** A region: the first byte and the one after the last. */
export function decodeRegion(bytes: Uint8Array): { start: number; end: number } {
  const reader = new Reader(bytes);
  return { start: reader.u32(), end: reader.u32() };
}

/** The request of a write: the edit, then the file. */
export function encodeWrite(edit: WireEdit, file: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  const u32 = (value: number) => {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    parts.push(out);
  };
  const run = (bytes: Uint8Array) => {
    u32(bytes.length);
    parts.push(bytes);
  };
  for (const field of WIRE_FIELDS) {
    const value = edit.fields[field];
    if (value === undefined) {
      parts.push(Uint8Array.of(0));
    } else {
      parts.push(Uint8Array.of(1));
      run(encoder.encode(value));
    }
  }
  if ("set" in edit.cover) {
    parts.push(Uint8Array.of(1));
    run(encoder.encode(edit.cover.set.mime));
    run(edit.cover.set.data);
  } else {
    parts.push(Uint8Array.of("remove" in edit.cover ? 2 : 0));
  }
  parts.push(file);
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
