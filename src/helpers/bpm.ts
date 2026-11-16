// A song's tempo from its decoded audio (RECORD/2026-11-03.deck-design-system.WIP.md, step 3):
// an onset envelope (where the sound's amplitude rises), and its autocorrelation over 60–200 BPM,
// weighted towards 80–160 against half or double tempo. Pure: lib/bpm.ts decodes the file.

/** The tempos looked at, in BPM. */
export const MIN_BPM = 60;
export const MAX_BPM = 200;
/** The tempos preferred: a peak outside them weighs `OUTSIDE` at once, then less the further an octave away. */
const PREFERRED: readonly [number, number] = [80, 160];
const OUTSIDE = 0.7;
/** How fast the weight falls outside them, in octaves. */
const FALL = 0.5;
/** How much of the song is looked at, in seconds: from its middle. */
export const SPAN_S = 60;
/** The envelope's step and window, in samples. */
const HOP = 32;
const WINDOW = 128;

/** The middle `SPAN_S` seconds of `samples` (all of them if shorter). */
export function middleSpan(samples: Float32Array, sampleRate: number): Float32Array {
  const length = Math.min(samples.length, Math.round(SPAN_S * sampleRate));
  const start = Math.floor((samples.length - length) / 2);
  return samples.subarray(start, start + length);
}

/** Where the amplitude rises, one value per `HOP` samples, its mean taken off. */
export function onsetEnvelope(samples: Float32Array): Float64Array {
  const frames = Math.max(0, Math.floor((samples.length - WINDOW) / HOP) + 1);
  const out = new Float64Array(frames);
  let previous = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    let energy = 0;
    const start = frame * HOP;
    for (let i = start; i < start + WINDOW; i += 1) energy += samples[i] * samples[i];
    const amplitude = Math.sqrt(energy / WINDOW);
    out[frame] = frame === 0 ? 0 : Math.max(0, amplitude - previous);
    previous = amplitude;
  }
  let mean = 0;
  for (const value of out) mean += value;
  mean /= frames;
  for (let i = 0; i < frames; i += 1) out[i] -= mean;
  return out;
}

function autocorrelation(envelope: Float64Array, lag: number): number {
  let sum = 0;
  for (let i = lag; i < envelope.length; i += 1) sum += envelope[i] * envelope[i - lag];
  return sum;
}

/**
 * A tempo's weight: 1 within the preferred ones; outside them, a step down, then less the further
 * an octave away. A beat's half tempo is as strong a peak as the beat (every other beat lines up
 * too): within the range is what tells them apart.
 */
export function tempoWeight(bpm: number): number {
  const [low, high] = PREFERRED;
  if (bpm >= low && bpm <= high) return 1;
  const octaves = bpm < low ? Math.log2(low / bpm) : Math.log2(bpm / high);
  return OUTSIDE * Math.exp(-0.5 * (octaves / FALL) ** 2);
}

/** The peak's place between its neighbours (a parabola through the three), as a fraction of a lag. */
function interpolate(before: number, at: number, after: number): number {
  const curve = before - 2 * at + after;
  return curve === 0 ? 0 : (0.5 * (before - after)) / curve;
}

/**
 * The tempo of mono `samples` at `sampleRate`, in BPM to a tenth, or null when there is no beat to
 * tell (silence, or too short: less than four seconds).
 */
export function detectBpm(samples: Float32Array, sampleRate: number): number | null {
  const span = middleSpan(samples, sampleRate);
  if (span.length < sampleRate * 4) return null;
  const envelope = onsetEnvelope(span);
  const fps = sampleRate / HOP;
  const lagOf = (bpm: number) => (60 * fps) / bpm;
  // Four seconds are more than two of the longest lags (a beat at 60 BPM).
  const shortest = Math.floor(lagOf(MAX_BPM));
  const longest = Math.ceil(lagOf(MIN_BPM));

  const zero = autocorrelation(envelope, 0);
  if (!(zero > 0)) return null;
  let best = -1;
  let bestScore = 0;
  const scores = new Map<number, number>();
  for (let lag = shortest - 1; lag <= longest + 1; lag += 1) scores.set(lag, autocorrelation(envelope, lag));
  for (let lag = shortest; lag <= longest; lag += 1) {
    const here = scores.get(lag)!;
    // A peak only: higher than both its neighbours.
    if (here <= scores.get(lag - 1)! || here < scores.get(lag + 1)!) continue;
    const score = here * tempoWeight((60 * fps) / lag);
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // No beat: the best peak is weak against the envelope's own energy. Steady noise gives ~0.03,
  // songs 0.08–0.25 (the samples), a click track ~0.9.
  if (best < 0 || bestScore < zero * 0.05) return null;

  // Told more finely at a multiple of the lag (up to four beats on, as far as half the envelope
  // reaches), whose error is shared between the beats.
  const rough = best + interpolate(scores.get(best - 1)!, scores.get(best)!, scores.get(best + 1)!);
  const times = Math.max(1, Math.min(4, Math.floor((envelope.length / 2 - 4) / rough)));
  const around = Math.round(rough * times);
  let peak = around;
  for (let lag = around - 3; lag <= around + 3; lag += 1) if (autocorrelation(envelope, lag) > autocorrelation(envelope, peak)) peak = lag;
  const offset = interpolate(autocorrelation(envelope, peak - 1), autocorrelation(envelope, peak), autocorrelation(envelope, peak + 1));
  return Math.round(((60 * fps * times) / (peak + offset)) * 10) / 10;
}
