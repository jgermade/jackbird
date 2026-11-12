/**
 * What a track's audio is, read from the start of its file: the codec, the sample rate, and the
 * bit depth (FLAC) or the bitrate (MP3, with whether it varies). What the display shows next to
 * the song (the faceplate's format). An ID3v2 tag in front is skipped (an MP3's, or one put before
 * a FLAC's own header). See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-12 23:20).
 */

export type StreamInfo =
  | { codec: "FLAC"; rate: number; bits: number; channels: number }
  | { codec: "MP3"; rate: number; kbps: number; vbr: boolean; channels: number };

const ascii = (bytes: Uint8Array, at: number, text: string): boolean =>
  at + text.length <= bytes.length && [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));

/** Where the audio starts: after an ID3v2 tag (its header, size and footer), or at 0. */
export function audioStart(bytes: Uint8Array): number {
  if (!ascii(bytes, 0, "ID3") || bytes.length < 10) return 0;
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const footer = bytes[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

/** How many bytes of a file's start `streamInfo` needs, once it has the first ten. */
export function streamInfoNeeds(head: Uint8Array): number {
  return audioStart(head) + 8192;
}

function flacInfo(bytes: Uint8Array, at: number): StreamInfo | null {
  // "fLaC", then the first block's header (type 0, STREAMINFO, 34 bytes), then its data.
  if ((bytes[at + 4] & 0x7f) !== 0 || at + 8 + 18 > bytes.length) return null;
  const data = at + 8;
  const rate = (bytes[data + 10] << 12) | (bytes[data + 11] << 4) | (bytes[data + 12] >> 4);
  const channels = ((bytes[data + 12] >> 1) & 0x07) + 1;
  const bits = (((bytes[data + 12] & 0x01) << 4) | (bytes[data + 13] >> 4)) + 1;
  return rate > 0 ? { codec: "FLAC", rate, bits, channels } : null;
}

// MPEG audio, layer III: bitrates (kbps) by index, for MPEG-1 and for MPEG-2 and 2.5; rates by index.
const KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES = [44100, 48000, 32000];

type Frame = { at: number; length: number; rate: number; kbps: number; mpeg1: boolean; mono: boolean };

function frameAt(bytes: Uint8Array, at: number): Frame | null {
  if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[at + 1] >> 3) & 0x03; // 3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5, 1 reserved
  const layer = (bytes[at + 1] >> 1) & 0x03; // 1 is layer III
  const bitrateIndex = bytes[at + 2] >> 4;
  const rateIndex = (bytes[at + 2] >> 2) & 0x03;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const mpeg1 = version === 3;
  const rate = RATES[rateIndex] / (mpeg1 ? 1 : version === 2 ? 2 : 4);
  const kbps = (mpeg1 ? KBPS_V1 : KBPS_V2)[bitrateIndex];
  const padding = (bytes[at + 2] >> 1) & 0x01;
  const length = Math.floor(((mpeg1 ? 144 : 72) * kbps * 1000) / rate) + padding;
  const mono = bytes[at + 3] >> 6 === 3;
  return { at, length, rate, kbps, mpeg1, mono };
}

const word = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

function mp3Info(bytes: Uint8Array, start: number): StreamInfo | null {
  // The first frame whose next one follows it where its length says (or that ends the bytes read).
  let frame: Frame | null = null;
  for (let at = start; at + 4 <= bytes.length && !frame; at += 1) {
    const found = frameAt(bytes, at);
    if (!found) continue;
    const next = found.at + found.length;
    if (next + 4 > bytes.length || frameAt(bytes, next)) frame = found;
  }
  if (!frame) return null;
  const channels = frame.mono ? 1 : 2;
  // A VBR file says so in its first frame: a Xing header (after the side information) or VBRI.
  const side = frame.mpeg1 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17;
  const xing = frame.at + 4 + side;
  const samples = frame.mpeg1 ? 1152 : 576;
  if (ascii(bytes, xing, "Xing") || ascii(bytes, xing, "Info")) {
    const vbr = ascii(bytes, xing, "Xing");
    const flags = word(bytes, xing + 4);
    // With both the frame count and the byte count, the mean bitrate.
    if (vbr && flags & 0x01 && flags & 0x02) {
      const frames = word(bytes, xing + 8);
      const size = word(bytes, xing + 12);
      const seconds = (frames * samples) / frame.rate;
      if (frames > 0 && seconds > 0) return { codec: "MP3", rate: frame.rate, kbps: Math.round((size * 8) / seconds / 1000), vbr, channels };
    }
    return { codec: "MP3", rate: frame.rate, kbps: frame.kbps, vbr, channels };
  }
  if (ascii(bytes, frame.at + 36, "VBRI")) {
    const size = word(bytes, frame.at + 36 + 10);
    const frames = word(bytes, frame.at + 36 + 14);
    const seconds = (frames * samples) / frame.rate;
    const kbps = frames > 0 && seconds > 0 ? Math.round((size * 8) / seconds / 1000) : frame.kbps;
    return { codec: "MP3", rate: frame.rate, kbps, vbr: true, channels };
  }
  return { codec: "MP3", rate: frame.rate, kbps: frame.kbps, vbr: false, channels };
}

/** The audio's codec, rate and depth or bitrate, from the start of its file; null when it is neither. */
export function streamInfo(bytes: Uint8Array): StreamInfo | null {
  const start = audioStart(bytes);
  if (ascii(bytes, start, "fLaC")) return flacInfo(bytes, start);
  return mp3Info(bytes, start);
}

/** A rate in kHz as a display writes it: "44.1", "96", "22.05". */
export function kilohertz(rate: number): string {
  const kilo = rate / 1000;
  return String(Number(kilo.toFixed(3)));
}

/** The quality line: "24 bit · 96 kHz", "320 kbps · 44.1 kHz", "VBR 245 kbps · 44.1 kHz". */
export function streamQuality(info: StreamInfo): string {
  const rate = `${kilohertz(info.rate)} kHz`;
  if (info.codec === "FLAC") return `${info.bits} bit · ${rate}`;
  return `${info.vbr ? "VBR " : ""}${info.kbps} kbps · ${rate}`;
}

/**
 * Whether audio is past a CD's resolution (16 bit, 44.1 or 48 kHz): deeper or faster, as a
 * display's "HD" badge says. Never for a lossy codec (MP3), whatever it decodes to.
 */
export function isHighResolution(codec: string, bits: number, rate: number): boolean {
  if (codec === "MP3") return false;
  return bits > 16 || rate > 48000;
}
