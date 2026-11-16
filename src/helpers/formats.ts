/**
 * The audio formats jackbird opens, by extension: which files of a folder are
 * tracks, and the MIME type the player gives each. One list, so a format is
 * added in one place. See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md
 * (2026-11-07 22:28, E3-D1).
 */

/** Each format: its extension (lower case, with the dot), MIME type and name. */
export const AUDIO_FORMATS = [
  { extension: ".mp3", mime: "audio/mpeg", name: "MP3" },
  { extension: ".flac", mime: "audio/flac", name: "FLAC" }
] as const;

export type AudioFormat = (typeof AUDIO_FORMATS)[number];

/** The format of a path, by its extension in any case; null for any other file. */
export function audioFormatOf(path: string): AudioFormat | null {
  const lower = path.toLowerCase();
  return AUDIO_FORMATS.find((format) => lower.endsWith(format.extension)) ?? null;
}

/** Whether a path is a track jackbird opens. */
export function isAudioFile(path: string): boolean {
  return audioFormatOf(path) !== null;
}

/** The MIME type a track is played with, by its extension; "" for a file that is not one. */
export function audioMimeType(path: string): string {
  return audioFormatOf(path)?.mime ?? "";
}

/**
 * The word a track's row shows for its format: a known format's name ("MP3", "FLAC"), else its
 * extension in capitals (an iPod's "M4A"); "" with none.
 */
export function formatLabel(path: string): string {
  const known = audioFormatOf(path);
  if (known) return known.name;
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : "";
}
