/**
 * jackbird's own identity of a song (the owner, 2026-11-25; RECORD/2026-08-11.musikmatch-rust-migration.WIP.md,
 * `track_id`): a UUID v4, given once, the first time jackbird writes a file's tags, and kept through
 * renames and later edits (`TXXX:jackbird track_id`, `JACKBIRD_TRACK_ID`). Made from
 * `crypto.getRandomValues`, which a page has even where `crypto.randomUUID` is not (a server reached
 * by `http://` on the home network is no secure context).
 */

/** A UUID v4 from 16 random bytes. */
export function uuidOf(bytes: Uint8Array): string {
  if (bytes.length < 16) throw new Error("a UUID needs 16 bytes");
  const b = bytes.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A new track id. */
export function newTrackId(random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  return uuidOf(random(new Uint8Array(16)));
}

/** The tags to write with their track id: the one they carry, else the file's, else a new one. */
export function withTrackId<T extends { jackbirdTrackId?: string }>(metadata: T, current: { jackbirdTrackId?: string }, make: () => string = newTrackId): T {
  if (metadata.jackbirdTrackId) return metadata;
  return { ...metadata, jackbirdTrackId: current.jackbirdTrackId || make() };
}
