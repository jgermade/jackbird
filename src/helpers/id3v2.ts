/**
 * ID3v2 tags (v2.3 and v2.4) as frames, enough to keep the frames an edit
 * does not touch. `browser-id3-writer`, which writes jackbird's tags, drops
 * the whole tag it finds and writes only the frames it is given; so a save
 * would lose the album artist, the disc number, comments, lyrics, ReplayGain
 * and every other frame the editor does not show. See
 * RECORD/2026-11-04.github-actions-workflows.WIP.md (12:29).
 */

/** One frame as it sits in a tag: its id, its two flag bytes, and its body, untouched. */
export type Id3Frame = {
  id: string;
  flags: readonly [number, number];
  body: Uint8Array;
};

/** A tag read from the start of a file: its version, its frames, and where the audio starts. */
export type Id3Tag = {
  version: 3 | 4;
  frames: Id3Frame[];
  /** The offset of the first byte after the tag (and its footer). */
  end: number;
};

const syncsafe = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] & 0x7f) << 21) | ((bytes[at + 1] & 0x7f) << 14) | ((bytes[at + 2] & 0x7f) << 7) | (bytes[at + 3] & 0x7f);

const plain = (bytes: Uint8Array, at: number): number =>
  bytes[at] * 0x1000000 + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];

const FRAME_ID = /^[A-Z0-9]{4}$/;

/** Undoes ID3's unsynchronisation: every 0x00 right after a 0xFF goes. */
export function resynchronise(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let length = 0;
  for (let at = 0; at < bytes.length; at += 1) {
    if (bytes[at] === 0x00 && at > 0 && bytes[at - 1] === 0xff) {
      continue;
    }
    out[length] = bytes[at];
    length += 1;
  }
  return out.slice(0, length);
}

/**
 * The frames of a tag's body, from `start`, with frame sizes read by `size`;
 * `null` unless they end cleanly: at the body's end, or in padding (zeros).
 */
function framesOf(body: Uint8Array, start: number, size: (bytes: Uint8Array, at: number) => number): Id3Frame[] | null {
  const frames: Id3Frame[] = [];
  let at = start;
  while (at + 10 <= body.length) {
    const id = String.fromCharCode(body[at], body[at + 1], body[at + 2], body[at + 3]);
    if (!FRAME_ID.test(id)) {
      break;
    }
    const length = size(body, at + 4);
    const from = at + 10;
    if (from + length > body.length) {
      return null;
    }
    frames.push({ id, flags: [body[at + 8], body[at + 9]], body: body.slice(from, from + length) });
    at = from + length;
  }
  return body.subarray(at).every((byte) => byte === 0) ? frames : null;
}

/**
 * The ID3v2 tag at the start of `bytes`: its version, frames and end. `null`
 * without one, for v2.2 (three-letter frames), or when its frames cannot be
 * read cleanly. A v2.3 tag's unsynchronisation is undone; an extended
 * header is skipped; a v2.4 tag whose frame sizes do not read as syncsafe is
 * read again with plain sizes, as some old writers (iTunes) wrote them.
 */
export function readId3v2(bytes: Uint8Array): Id3Tag | null {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
    return null;
  }
  const version = bytes[3];
  if (version !== 3 && version !== 4) {
    return null;
  }
  const flags = bytes[5];
  const size = syncsafe(bytes, 6);
  const end = 10 + size + (version === 4 && flags & 0x10 ? 10 : 0);
  let body = bytes.subarray(10, Math.min(bytes.length, 10 + size));
  if (version === 3 && flags & 0x80) {
    body = resynchronise(body);
  }
  const start = flags & 0x40 ? (version === 3 ? plain(body, 0) + 4 : syncsafe(body, 0)) : 0;
  const frames = framesOf(body, start, version === 4 ? syncsafe : plain) ?? (version === 4 ? framesOf(body, start, plain) : null);
  return frames ? { version, frames, end } : null;
}

const putSyncsafe = (out: Uint8Array, at: number, value: number): void => {
  out[at] = (value >>> 21) & 0x7f;
  out[at + 1] = (value >>> 14) & 0x7f;
  out[at + 2] = (value >>> 7) & 0x7f;
  out[at + 3] = value & 0x7f;
};

const putPlain = (out: Uint8Array, at: number, value: number): void => {
  out[at] = (value >>> 24) & 0xff;
  out[at + 1] = (value >>> 16) & 0xff;
  out[at + 2] = (value >>> 8) & 0xff;
  out[at + 3] = value & 0xff;
};

/** A tag holding `frames`, in `version`, with no tag flags (no unsynchronisation, extended header or footer). */
export function writeId3v2(version: 3 | 4, frames: readonly Id3Frame[]): Uint8Array {
  const total = frames.reduce((sum, frame) => sum + 10 + frame.body.length, 0);
  const out = new Uint8Array(10 + total);
  out.set([0x49, 0x44, 0x33, version, 0, 0]);
  putSyncsafe(out, 6, total);
  let at = 10;
  for (const frame of frames) {
    for (let index = 0; index < 4; index += 1) {
      out[at + index] = frame.id.charCodeAt(index);
    }
    (version === 4 ? putSyncsafe : putPlain)(out, at + 4, frame.body.length);
    out[at + 8] = frame.flags[0];
    out[at + 9] = frame.flags[1];
    out.set(frame.body, at + 10);
    at += 10 + frame.body.length;
  }
  return out;
}

/** The text frames the editor writes; the year is TYER in v2.3 and TDRC in v2.4, and both are its. */
const EDITED_TEXT = new Set(["TIT2", "TPE1", "TALB", "TYER", "TDRC", "TCON", "TRCK"]);

/**
 * The file a save leaves: `written` is the file as `browser-id3-writer` wrote
 * it (a v2.3 tag with only jackbird's frames, then the audio); `source` is the
 * file before. The result has the writer's frames, then every frame of the
 * original the editor does not manage, untouched and in their order, all in
 * the original tag's version (TYER becomes TDRC in v2.4). The editor manages
 * the frames in `EDITED_TEXT` and the first picture (APIC), which is the one
 * it shows. A frame flagged "discard when the tag is altered" goes, as the
 * standard asks. Without an original tag, or with one that cannot be read,
 * `written` is returned as it is.
 */
export function keepUneditedFrames(source: Uint8Array, written: Uint8Array): Uint8Array {
  const original = readId3v2(source);
  const fresh = readId3v2(written);
  if (!original || !fresh) {
    return written;
  }
  const firstPicture = original.frames.findIndex((frame) => frame.id === "APIC");
  const discard = original.version === 4 ? 0x40 : 0x80;
  const kept = original.frames.filter(
    (frame, index) => !EDITED_TEXT.has(frame.id) && index !== firstPicture && !(frame.flags[0] & discard)
  );
  const edited = fresh.frames.map((frame) => (original.version === 4 && frame.id === "TYER" ? { ...frame, id: "TDRC" } : frame));
  const tag = writeId3v2(original.version, [...edited, ...kept]);
  const audio = written.subarray(fresh.end);
  const out = new Uint8Array(tag.length + audio.length);
  out.set(tag);
  out.set(audio, tag.length);
  return out;
}
