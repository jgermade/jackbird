/**
 * The tag engine on a whole file in memory, giving the module only the parts
 * it asks for (E2b of RECORD/2026-08-11.musikmatch-rust-migration.WIP.md,
 * 2026-11-08 03:10): the last bytes and a head that grows as `layout` asks,
 * then the tags alone, to read or to write. The audio never enters the
 * module. Over any `Engine`, so the tests drive it without the app's loader.
 */
import { FIRST_HEAD, TAIL_LEN, type WireEdit, type WireLayout, type WireTags } from "../../helpers/tagwire.ts";
import { TagError } from "./error.ts";
import type { Engine } from "./wasm.ts";

/**
 * How many heads a file may take. Each one is at least twice the last (a FLAC
 * file with many large pictures would otherwise take one per block), so even
 * a 4 GB file is known in fewer: more is a file that keeps asking.
 */
const MAX_STEPS = 24;

/** Where a file's tags end and its audio is. */
export function layoutOf(engine: Engine, bytes: Uint8Array): WireLayout {
  const tail = bytes.subarray(Math.max(0, bytes.length - TAIL_LEN));
  let given = Math.min(FIRST_HEAD, bytes.length);
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const answer = engine.layout(bytes.subarray(0, given), tail, bytes.length);
    if ("known" in answer) {
      return answer.known;
    }
    if (answer.needHead <= given || answer.needHead > bytes.length) {
      break;
    }
    given = Math.min(bytes.length, Math.max(answer.needHead, given * 2));
  }
  throw new TagError("unreadable", "where its tags end cannot be found");
}

/**
 * A file's tags from a `Blob` (a `File` on a drive), reading only its last bytes and a head that
 * grows as `layout` asks, never the rest: the web's iPod in its Rockbox library (W7,
 * RECORD/2026-11-14.ipod-sync.WIP.md), whose files are read over USB. Null for a file the engine
 * gives no format to.
 */
export async function readBlob(engine: Engine, blob: Blob): Promise<WireTags | null> {
  const length = blob.size;
  const bytesOf = async (start: number, end: number): Promise<Uint8Array> => new Uint8Array(await blob.slice(start, end).arrayBuffer());
  const tail = await bytesOf(Math.max(0, length - TAIL_LEN), length);
  let given = Math.min(FIRST_HEAD, length);
  let head = await bytesOf(0, given);
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const answer = engine.layout(head, tail, length);
    if ("known" in answer) {
      const layout = answer.known;
      if (!layout.format) return null;
      if (head.length < layout.tagsEnd) head = await bytesOf(0, layout.tagsEnd);
      return engine.read(head.subarray(0, layout.tagsEnd), layout);
    }
    if (answer.needHead <= given || answer.needHead > length) break;
    given = Math.min(length, Math.max(answer.needHead, given * 2));
    head = await bytesOf(0, given);
  }
  throw new TagError("unreadable", "where its tags end cannot be found");
}

/** A file's tags, the module given only them. */
export function readOf(engine: Engine, bytes: Uint8Array, layout: WireLayout): WireTags {
  return engine.read(bytes.subarray(0, layout.tagsEnd), layout);
}

/** The file `edit` makes: the module's new tags, then the file's own bytes after its old ones; the same bytes when nothing changes. */
export function writeOf(engine: Engine, bytes: Uint8Array, layout: WireLayout, edit: WireEdit): Uint8Array {
  const head = bytes.subarray(0, layout.tagsEnd);
  const splice = engine.write(head, layout, edit);
  if (splice.replaceEnd !== layout.tagsEnd) {
    throw new TagError("refused-audio", "the engine's splice does not replace the tags it was given");
  }
  if (splice.with.length === head.length && splice.with.every((byte, at) => byte === head[at])) {
    return bytes;
  }
  const out = new Uint8Array(splice.with.length + bytes.length - layout.tagsEnd);
  out.set(splice.with);
  out.set(bytes.subarray(layout.tagsEnd), splice.with.length);
  return out;
}
