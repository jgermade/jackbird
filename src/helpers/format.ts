const BYTE_UNITS = ["Bytes", "KB", "MB", "GB"];

/** `1.50 MB`: binary units, two decimals, up to GB (anything larger in GB). */
export function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return "0 Bytes";
  }
  const unit = Math.min(BYTE_UNITS.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))));
  return `${(bytes / 1024 ** unit).toFixed(2)} ${BYTE_UNITS[unit]}`;
}

/** A track number without its total: `"03/12"` is `"03"`. Empty when there is none. */
export function formatTrackNumber(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(0, slash).trim();
}

/** `03:12`: minutes and seconds of a duration, whole seconds; unknown or negative is `00:00`. */
export function formatTime(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The zeros a display dims at the left of a counter's digits: the leading ones, never the last
 * digit, unless every digit is a zero ("00" is all dimmed: no minutes yet). "03" gives "0",
 * "12" gives "", "00" gives "00".
 */
export function dimmedLead(digits: string): string {
  if (/^0+$/.test(digits)) return digits;
  return (/^0+/.exec(digits.slice(0, -1)) ?? [""])[0];
}

/**
 * A time as a display's clock shows it: its minutes (at least two digits) split into the zeros it
 * dims (`lead`, see dimmedLead) and the rest it lights, and its seconds (two digits). A time below
 * zero, or not a number (a song whose length is not known yet), shows as 0.
 */
export function clockParts(seconds: number): { lead: string; minutes: string; seconds: string } {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = String(Math.floor(whole / 60)).padStart(2, "0");
  const lead = dimmedLead(minutes);
  return { lead, minutes: minutes.slice(lead.length), seconds: String(whole % 60).padStart(2, "0") };
}

/**
 * What a list shows before a track's title: its number, or while the tags are still being read
 * "…". A track with no number shows nothing: a blank as wide as a number when others in the list
 * have one (so the titles line up), or no column at all when none has (`numbered` false: "").
 */
export function trackLead(trackNumber: string | undefined, loading: boolean, numbered: boolean): string {
  const number = formatTrackNumber(trackNumber);
  if (number) return number;
  if (loading) return "…";
  return numbered ? " " : "";
}

/**
 * A track's number alone, for a list: its leading digits as a number, its total and anything after
 * them dropped ("2 de 6", "2/6", "2/" and "02" give "2"); a value with no leading digits as it is
 * (its part before a "/"); none, "".
 */
export function cleanTrackNumber(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  const digits = trimmed.match(/^\d+/);
  return digits ? String(Number(digits[0])) : formatTrackNumber(trimmed);
}

/** A track's length: "3:17", "1:02:03" past the hour; "" when unknown. */
export function formatDuration(ms: number | undefined | null): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "";
  const whole = Math.round(ms / 1000);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** A file's audio as one line for a list: "MP3 · 320 kbps · 44.1 kHz · 3:17", in `locale`'s decimals; what is unknown left out. */
export function audioLine(
  audio: { durationMs: number; bitrate: number; sampleRate: number; bits: number; vbr: boolean } | null | undefined,
  format: string,
  locale: string
): string {
  const parts = [format];
  if (audio) {
    if (audio.bitrate > 0) parts.push(`${audio.bitrate} kbps${audio.vbr && !audio.bits ? " VBR" : ""}`);
    if (audio.sampleRate > 0) parts.push(`${(audio.sampleRate / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} kHz`);
    if (audio.bits > 0) parts.push(`${audio.bits} bits`);
    const length = formatDuration(audio.durationMs);
    if (length) parts.push(length);
  }
  return parts.filter(Boolean).join(" · ");
}
