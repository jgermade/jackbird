// The desktop app's output (E5): native and shared by default, or native
// and exclusive, or embedded (the webview's <audio>), and the device the
// native player uses; kept between visits, and given to the app. What sounds
// now (its format and its way to the device) is written here by
// lib/player.ts for the faceplate and the preferences to show.
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E5).

import { $reactive } from "jq79";
import { invoke } from "@tauri-apps/api/core";
import { describeFormat, fileKind, formatRate, parseOutputKind, settingsFor, shortFormat, type DeviceInfo, type OutputKind } from "../helpers/output";
import { t } from "./i18n";
import type { Sounding } from "./native-audio";
import { isDesktop, isPhone } from "./platform";
import { STORAGE_KEYS, readStored, writeStored } from "./storage";

export const output = $reactive({
  /** Only the desktop app has the native player (not a phone's). */
  available: isDesktop && !isPhone,
  kind: (isDesktop && !isPhone ? parseOutputKind(readStored(STORAGE_KEYS.output)) : "embedded") as OutputKind,
  /** The device's id; null: the system's default. */
  device: readStored(STORAGE_KEYS.outputDevice) || null,
  devices: [] as DeviceInfo[],
  /** What the native player plays now; null in the embedded output. */
  sounding: null as Sounding | null,
  /** Why the last song went to the embedded output instead. */
  fallback: "",
  /** An Android phone's native player (E6b-D10): whether it is the one here. */
  phone: isPhone && /Android/.test(navigator.userAgent),
  /** "Bit-perfect to a USB DAC", kept on the phone; off by default. */
  bitPerfect: readStored(STORAGE_KEYS.phoneBitPerfect) === "on",
  /** Whether this Android can (14 and later), and the USB DAC connected, if any. */
  bitPerfectPossible: false,
  usb: null as string | null,
  /** The formats the USB DAC takes bit-perfect, as the phone's player last said. */
  offered: ""
});

const PLAYER = "plugin:jackbird-player";

/** Gives the phone's player its setting (from the next song). */
function applyPhoneOutput(): void {
  if (output.phone) void invoke(`${PLAYER}|set_output`, { bitPerfect: output.bitPerfect }).catch(() => undefined);
}

/** Turns "Bit-perfect to a USB DAC" on or off (E6b-D10). */
export function setBitPerfect(on: boolean): void {
  output.bitPerfect = on;
  writeStored(STORAGE_KEYS.phoneBitPerfect, on ? "on" : "");
  applyPhoneOutput();
}

/** Asks the phone's player what it can do, and which DAC is connected. */
export async function loadPhoneOutput(): Promise<void> {
  if (!output.phone) return;
  const info = await invoke<{ bitPerfect: boolean; usb: string | null }>(`${PLAYER}|output_info`).catch(() => null);
  output.bitPerfectPossible = info?.bitPerfect ?? false;
  output.usb = info?.usb ?? null;
}

/** Gives the native player its settings (nothing for the embedded output). */
export function applyOutput(): void {
  const settings = settingsFor(output.kind, output.device);
  if (output.available && settings) void invoke("audio_configure", { settings }).catch(() => undefined);
}

export function setOutputKind(kind: OutputKind): void {
  output.kind = kind;
  writeStored(STORAGE_KEYS.output, kind);
  applyOutput();
}

export function setOutputDevice(device: string | null): void {
  output.device = device;
  writeStored(STORAGE_KEYS.outputDevice, device ?? "");
  applyOutput();
}

/** Asks the app for its devices. */
export async function loadDevices(): Promise<void> {
  if (!output.available) return;
  output.devices = await invoke<DeviceInfo[]>("audio_devices").catch(() => []);
}

applyOutput();
applyPhoneOutput();

/** "Now: FLAC 24 bit · 96 kHz → USB DAC · 96 kHz · bit-perfect"; empty in the embedded output. */
export function soundingText(): string {
  const sounding = output.sounding;
  if (!sounding) return "";
  return t("output.now", {
    format: describeFormat(sounding.codec, sounding.format),
    device: sounding.route.device,
    rate: formatRate(sounding.route.rate),
    fidelity: t(`output.fidelity.${sounding.route.fidelity}`)
  });
}

/**
 * What the display shows of the song's format, in two parts: the format ("24/96", "MP3") and how
 * it reaches the device ("bit-perfect", "DAC", "native"; empty when there is nothing to say). In a
 * native output, what it reports; in the embedded one (the browser's), the file's kind alone, from
 * `relativePath`. Null with neither.
 */
export function soundingParts(relativePath?: string): { format: string; quality: string } | null {
  const sounding = output.sounding;
  if (!sounding) {
    const kind = relativePath ? fileKind(relativePath) : "";
    return kind ? { format: kind, quality: "" } : null;
  }
  const format = shortFormat(sounding.codec, sounding.format);
  // On a phone (E6b-D10): bit-perfect to a DAC, through Android's mixer to a USB DAC ("DAC"), or the
  // format alone to the phone's own output.
  if (output.phone) {
    if (sounding.route.fidelity === "bit-perfect") return { format, quality: t("output.badge.bit-perfect") };
    return { format, quality: sounding.route.device !== "Android" ? t("output.badge.dac") : "" };
  }
  return { format, quality: t(`output.badge.${sounding.route.fidelity}`) };
}
