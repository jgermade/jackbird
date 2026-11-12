/** The frequencies a spectrum display shows, in Hz: where music has something to show. */
export const SPECTRUM_RANGE = { low: 40, high: 16000 } as const;

/** The decibels an analyser's bins span, from 0 to 255: -100 to -10 dB, so loud bass does not clip. */
export const SPECTRUM_DECIBELS = { min: -100, max: -10 } as const;

/**
 * How much a display lifts each octave over the one below, in dB: music, like pink noise, loses
 * about 3 dB an octave, so with this lift every band moves around the same height, instead of the
 * bass pinned at the top and the treble barely lit.
 */
export const SPECTRUM_TILT = 3;

/**
 * An analyser's spectrum (`bins`, each 0–255, low frequencies first, the
 * last one at half of `sampleRate`) folded into `bands` levels from 0 to 1,
 * as a spectrum display shows it. The bands are spaced logarithmically, as
 * hearing is, over `range` (40 Hz to 16 kHz by default), so they show the
 * same frequencies whatever the device's rate. Each is the mean of its bins
 * and at least one bin wide; bands that would start past the last bin (more
 * bands than bins, or a range above half the rate) repeat the last one. Bin
 * 0 (DC) is left out. No bins, no bands or no rate give no levels.
 *
 * With a `tilt` (dB per octave, over bins spanning `decibels`), each band is lifted by that much
 * per octave from the range's middle: the low bands lowered, the high ones raised, so a spectrum
 * that falls by `tilt` an octave shows level. A band with nothing in it stays at 0.
 */
export function spectrumBands(
  bins: ArrayLike<number>,
  bands: number,
  sampleRate: number,
  range: { low: number; high: number } = SPECTRUM_RANGE,
  tilt = 0,
  decibels: { min: number; max: number } = SPECTRUM_DECIBELS
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
    const level = sum / (end - from) / 255;
    // The band's middle, in octaves from the range's middle.
    const octaves = Math.log2(range.high / range.low) * ((band + 0.5) / bands - 0.5);
    const lift = (tilt * octaves) / (decibels.max - decibels.min);
    levels.push(level > 0 ? Math.min(1, Math.max(0, level + lift)) : 0);
    start = end;
  }
  return levels;
}
