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

/** Above this bitrate (kbit/s) an MPEG-4 song is Apple Lossless: AAC rarely passes 320, ALAC rarely falls below 500. */
const LOSSLESS_KBPS = 400;

/**
 * The codec an iPod's database names (`AudioProps.kind`), in any of iTunes' languages: the
 * codec's own name is never translated ("Apple Lossless audio file", "Archivo de audio AAC").
 * "" when it names none of them.
 */
export function codecOfKind(kind: string): string {
  const text = kind.toLowerCase();
  if (text.includes("lossless") || text.includes("alac")) return "ALAC";
  if (text.includes("aac")) return "AAC";
  if (text.includes("mpeg") || text.includes("mp3")) return "MP3";
  if (text.includes("aiff")) return "AIFF";
  if (text.includes("wav")) return "WAV";
  return "";
}

/**
 * The codec a track's mark shows (CodecMark): what an iPod's database names (`audio.kind`),
 * first; else MP3 and FLAC by their extension; an MPEG-4 song (`.m4a`) Apple Lossless ("ALAC")
 * above 400 kbit/s, else "AAC", as `.m4p`, `.m4b` and `.aac`; "WAV", "AIFF", "OGG", "OPUS"; any
 * other its extension in capitals; "" with none. `audio` is the track's (`Track.audio`).
 */
export function codecLabel(path: string, audio?: { bitrate?: number; kind?: string } | null): string {
  const named = audio?.kind ? codecOfKind(audio.kind) : "";
  if (named) return named;
  const label = formatLabel(path);
  switch (label) {
    case "M4A": return (audio?.bitrate ?? 0) > LOSSLESS_KBPS ? "ALAC" : "AAC";
    case "M4P":
    case "M4B":
    case "AAC": return "AAC";
    case "AIF":
    case "AIFF": return "AIFF";
    case "OGG":
    case "OGA": return "OGG";
    default: return label;
  }
}
