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
