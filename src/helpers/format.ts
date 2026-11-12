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
