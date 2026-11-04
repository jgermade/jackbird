/**
 * An analyser's spectrum (`bins`, each 0–255, low frequencies first) folded
 * into `bands` levels from 0 to 1, as a spectrum display shows it. The bands
 * are spaced logarithmically, as hearing is, so the low end gets more of them
 * than a linear split would give it; each is at least one bin wide, and is
 * the mean of its bins. No bins, or no bands, give no levels.
 */
export function spectrumBands(bins: ArrayLike<number>, bands: number): number[] {
  const count = bins.length;
  if (count === 0 || bands <= 0) {
    return [];
  }
  const levels: number[] = [];
  let start = 0;
  for (let band = 0; band < bands; band += 1) {
    // Where this band ends on a log scale from bin 1 to the last, never before the next bin.
    const edge = Math.round(Math.pow(count, (band + 1) / bands));
    const end = Math.min(count, Math.max(start + 1, edge));
    let sum = 0;
    for (let bin = start; bin < end; bin += 1) {
      sum += bins[bin];
    }
    levels.push(sum / (end - start) / 255);
    start = Math.min(end, count - 1);
  }
  return levels;
}
