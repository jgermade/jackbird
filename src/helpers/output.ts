// The desktop app's output (E5): which one plays (embedded, the webview's
// <audio>; or the native player, shared or exclusive), the devices each
// can use, and how a song's format and its way to the device are written.
// Pure: lib/output.ts keeps the choice and talks to the app.

export type OutputKind = "embedded" | "shared" | "exclusive";
export type OutputMode = "shared" | "exclusive";
export type Fidelity = "bit-perfect" | "mixer" | "converted";

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

/** A song's format: "FLAC 24 bit · 96 kHz"; MP3 has no depth of its own: "MP3 · 44.1 kHz". */
export function describeFormat(codec: string, format: PcmFormat): string {
  const depth = codec === "MP3" ? "" : ` ${format.bits} bit`;
  return `${codec}${depth} · ${formatRate(format.rate)}`;
}

/** The short form the display shows: "24/96", "16/44.1"; "MP3" for MP3. */
export function shortFormat(codec: string, format: PcmFormat): string {
  if (codec === "MP3") return "MP3";
  const kilo = format.rate / 1000;
  return `${format.bits}/${Number.isInteger(kilo) ? kilo : kilo.toFixed(1)}`;
}
