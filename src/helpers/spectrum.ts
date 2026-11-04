/** The frequencies a spectrum display shows, in Hz: where music has something to show. */
export const SPECTRUM_RANGE = { low: 40, high: 16000 } as const;

/**
 * An analyser's spectrum (`bins`, each 0–255, low frequencies first, the
 * last one at half of `sampleRate`) folded into `bands` levels from 0 to 1,
 * as a spectrum display shows it. The bands are spaced logarithmically, as
 * hearing is, over `range` (40 Hz to 16 kHz by default), so they show the
 * same frequencies whatever the device's rate. Each is the mean of its bins
 * and at least one bin wide; bands that would start past the last bin (more
 * bands than bins, or a range above half the rate) repeat the last one. Bin
 * 0 (DC) is left out. No bins, no bands or no rate give no levels.
 */
export function spectrumBands(
  bins: ArrayLike<number>,
  bands: number,
  sampleRate: number,
  range: { low: number; high: number } = SPECTRUM_RANGE
): number[] {
  const count = bins.length;
  if (count === 0 || bands <= 0 || !(sampleRate > 0)) {
    return [];
  }
  // Bin k is at k × binHz, up to the last at half the rate.
  const binHz = sampleRate / 2 / count;
  const binAt = (hz: number) => Math.round(hz / binHz);
  const levels: number[] = [];
  let start = Math.max(1, binAt(range.low));
  for (let band = 0; band < bands; band += 1) {
    const edge = binAt(range.low * Math.pow(range.high / range.low, (band + 1) / bands));
    const from = Math.min(start, count - 1);
    const end = Math.min(count, Math.max(from + 1, edge));
    let sum = 0;
    for (let bin = from; bin < end; bin += 1) {
      sum += bins[bin];
    }
    levels.push(sum / (end - from) / 255);
    start = end;
  }
  return levels;
}
