/**
 * The tag engine as WebAssembly: the glue over `crates/tags-wasm`'s exports,
 * written by hand (no bindings crate; E2-D1 of
 * RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-07 20:16).
 * A call copies its request into the module's input buffer, runs, and copies
 * the answer out of its output buffer, in the format of `helpers/tagwire.ts`.
 * The module is built by `scripts/build-wasm.mjs` into `./engine.wasm`.
 */
import { TagError } from "./error.ts";
import { decodeError, decodeRegion, decodeTags, encodeWrite, type WireEdit, type WireError, type WireTags } from "../../helpers/tagwire.ts";

type Exports = {
  memory: WebAssembly.Memory;
  tags_input(length: number): number;
  tags_read(): number;
  tags_write(): number;
  tags_region(): number;
  tags_output_ptr(): number;
  tags_output_len(): number;
  tags_release(): void;
};

/** What the module does. Once a call breaks the module (`broken`), it is not used again. */
export type Engine = {
  read(file: Uint8Array): WireTags;
  write(file: Uint8Array, edit: WireEdit): Uint8Array;
  region(file: Uint8Array): { start: number; end: number };
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
    read: (file) => decodeTags(call(file, exports.tags_read)),
    write: (file, edit) => call(encodeWrite(edit, file), exports.tags_write),
    region: (file) => decodeRegion(call(file, exports.tags_region)),
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
