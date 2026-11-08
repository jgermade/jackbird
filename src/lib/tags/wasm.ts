/**
 * The tag engine as WebAssembly: the glue over `crates/tags-wasm`'s exports,
 * written by hand (no bindings crate; E2-D1 of
 * RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-07 20:16).
 * A call copies its request into the module's input buffer, runs, and copies
 * the answer out of its output buffer, in the format of `helpers/tagwire.ts`.
 * The module is built by `scripts/build-wasm.mjs` into `./engine.wasm`.
 */
import { TagError } from "./error.ts";
import {
  decodeError,
  decodeLayout,
  decodeSplice,
  decodeTags,
  encodeLayout,
  encodeRead,
  encodeWrite,
  type WireEdit,
  type WireError,
  type WireLayout,
  type WireLayoutAnswer,
  type WireSplice,
  type WireTags
} from "../../helpers/tagwire.ts";

type Exports = {
  memory: WebAssembly.Memory;
  tags_input(length: number): number;
  tags_layout(): number;
  tags_read(): number;
  tags_write(): number;
  tags_output_ptr(): number;
  tags_output_len(): number;
  tags_release(): void;
};

/**
 * What the module does, on a file's first bytes (`head`) and last ones
 * (`tail`), never its audio. Once a call breaks the module (`broken`), it is
 * not used again.
 */
export type Engine = {
  /** Where the tags end and the audio is, or how many first bytes that needs. */
  layout(head: Uint8Array, tail: Uint8Array, length: number): WireLayoutAnswer;
  /** The tags, from at least the first `layout.tagsEnd` bytes. */
  read(head: Uint8Array, layout: WireLayout): WireTags;
  /** The splice that saves `edit`, from at least the first `layout.tagsEnd` bytes. */
  write(head: Uint8Array, layout: WireLayout, edit: WireEdit): WireSplice;
  readonly broken: boolean;
};

/** An engine over an instance of the module. */
export function engineOf(instance: WebAssembly.Instance): Engine {
  const exports = instance.exports as unknown as Exports;
  let broken = false;

  // One call: the request in, `run`, the answer out (a copy), or the error thrown.
  const call = (request: Uint8Array, run: () => number): Uint8Array => {
    if (broken) {
      throw new TagError("engine-failed", "the tag engine stopped after an earlier failure");
    }
    let status: number;
    let answer: Uint8Array;
    try {
      const at = exports.tags_input(request.length);
      // The memory may have grown: its buffer is read after every call.
      new Uint8Array(exports.memory.buffer, at, request.length).set(request);
      status = run();
      answer = new Uint8Array(exports.memory.buffer, exports.tags_output_ptr(), exports.tags_output_len()).slice();
      exports.tags_release();
    } catch (error) {
      // A trap (a panic, or out of memory) leaves the module in no known state.
      broken = true;
      throw new TagError("engine-failed", `the tag engine failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (status !== 0) {
      const { code, message }: WireError = decodeError(answer);
      throw new TagError(code, message);
    }
    return answer;
  };

  return {
    layout: (head, tail, length) => decodeLayout(call(encodeLayout(length, tail, head), exports.tags_layout)),
    read: (head, layout) => decodeTags(call(encodeRead(layout, head), exports.tags_read)),
    write: (head, layout, edit) => decodeSplice(call(encodeWrite(edit, layout, head), exports.tags_write)),
    get broken() {
      return broken;
    }
  };
}

/** The engine from the module's bytes (tests, which read `engine.wasm` from disk). */
export async function instantiate(module: BufferSource): Promise<Engine> {
  const { instance } = await WebAssembly.instantiate(module, {});
  return engineOf(instance);
}

/** The engine in the app: the module fetched next to this file, compiled while it downloads. */
export async function load(): Promise<Engine> {
  const url = new URL("./engine.wasm", import.meta.url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new TagError("engine-failed", `the tag engine could not be loaded (${response.status})`);
  }
  try {
    const { instance } = await WebAssembly.instantiateStreaming(response.clone(), {});
    return engineOf(instance);
  } catch {
    // A server that does not say application/wasm: compiled from the bytes instead.
    return instantiate(await response.arrayBuffer());
  }
}
