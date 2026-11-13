// The desktop app's output (E5): which one plays (embedded, the webview's
// <audio>; or the native player, shared or exclusive), the devices each
// can use, and how a song's format and its way to the device are written.
// Pure: lib/output.ts keeps the choice and talks to the app.

export type OutputKind = "embedded" | "shared" | "exclusive";
export type OutputMode = "shared" | "exclusive";
/**
 * How faithful the way to the device is: bit-perfect; through the system's mixer; converted (another
 * rate or depth); or, on a phone (E6b-D10), bit-perfect but for the phone's volume, which jackbird
 * applies itself below its top since Android leaves it to the DAC.
 */
export type Fidelity = "bit-perfect" | "mixer" | "converted" | "volume";

/** What a song decodes to. */
export type PcmFormat = { rate: number; channels: number; bits: number };

/** Where a song plays, and how (crates/audio's Route). */
export type Route = { device: string; mode: OutputMode; rate: number; sample: string; fidelity: Fidelity };

/** A device the native player can use. */
export type DeviceInfo = { id: string; name: string; default: boolean; modes: OutputMode[] };

/** Native, shared: the default (the owner's choice, 2026-11-09). */
export const DEFAULT_OUTPUT: OutputKind = "shared";

/** A stored choice, or the default. */
export function parseOutputKind(value: string | null): OutputKind {
  return value === "embedded" || value === "shared" || value === "exclusive" ? value : DEFAULT_OUTPUT;
}

/** The native player's settings for a choice; null when the embedded output plays. */
export function settingsFor(kind: OutputKind, device: string | null): { mode: OutputMode; device: string | null } | null {
  return kind === "embedded" ? null : { mode: kind, device };
}

/** The devices a choice can use (none for the embedded output). */
export function devicesFor(kind: OutputKind, devices: readonly DeviceInfo[]): DeviceInfo[] {
  return kind === "embedded" ? [] : devices.filter((device) => device.modes.includes(kind));
}

/** A rate as people read it: "96 kHz", "44.1 kHz". */
export function formatRate(hertz: number): string {
  const kilo = hertz / 1000;
  return `${Number.isInteger(kilo) ? kilo : kilo.toFixed(1)} kHz`;
}

/** A song's format: "FLAC 24 bit · 96 kHz"; MP3 has no depth of its own, nor a song whose depth is not known: "MP3 · 44.1 kHz". */
export function describeFormat(codec: string, format: PcmFormat): string {
  const depth = codec === "MP3" || format.bits <= 0 ? "" : ` ${format.bits} bit`;
  return `${codec}${depth} · ${formatRate(format.rate)}`;
}

/** The short form the display shows: "24/96", "16/44.1"; "MP3" for MP3. */
export function shortFormat(codec: string, format: PcmFormat): string {
  if (codec === "MP3" || format.bits <= 0) return codec;
  const kilo = format.rate / 1000;
  return `${format.bits}/${Number.isInteger(kilo) ? kilo : kilo.toFixed(1)}`;
}

/**
 * A file of a folder opened on the device, as a `file://` URL a native player opens (E6b-D9: the
 * phone's player reads the file itself): the folder's absolute path and the file's path in it, each
 * name escaped.
 */
export function fileUrl(root: string, path: string): string {
  const names = `${root.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`.split("/");
  return `file://${names.map((name) => encodeURIComponent(name)).join("/")}`;
}

/** A file's kind as a display shows it, from its name: "MP3", "FLAC"; empty without an extension. */
export function fileKind(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
}

/**
 * The depth a device takes its samples at, as a display writes it, from what an output reports:
 * the desktop's sample formats ("i16", "i24", "i24high", "i32", "f32") and Android's ("16-bit",
 * "24-bit", "32-bit", "float"). "24 bit", "32 bit float"; empty for one it does not know.
 */
export function sampleDepth(sample: string): string {
  const name = sample.trim().toLowerCase();
  if (name === "f32" || name === "float") return "32 bit float";
  const bits = /^(?:i(\d+)(?:high)?|(\d+)-bit)$/.exec(name);
  const depth = bits?.[1] ?? bits?.[2];
  return depth ? `${depth} bit` : "";
}
