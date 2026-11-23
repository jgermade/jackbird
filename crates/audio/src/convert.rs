//! A song converted to the format of the output already open, so that it follows the one before
//! without the output opening again (gapless, crossfade: [`crate::Transition`]), in the shared
//! mode only: there the system's mixer converts it anyway, and here it is done once, well.
//!
//! - **The depth**, upward and nothing else changing: shifted, exactly (no conversion at all).
//! - **The channels**: mono to both sides of a stereo output, or stereo to mono as their mean.
//! - **The rate**: `rubato`'s FFT resampler (synchronous, a fixed ratio), its delay taken off the
//!   start and its padding off the end, so the song keeps its length to the frame.

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Indexing, Resampler};

use crate::PcmFormat;

/// Frames given to the resampler at a time.
const CHUNK: usize = 1024;

/// A song's samples made into another format's, block by block.
pub struct Converter {
    from: PcmFormat,
    to: PcmFormat,
    resampler: Option<Fft<f32>>,
    /// Frames waiting for a whole chunk: floats from -1 to 1, interleaved, in `to`'s channels.
    pending: Vec<f32>,
    /// Output frames still to drop: the resampler's delay.
    delay: usize,
    /// Input frames taken, and output frames given, for the song's length at the end.
    taken: u64,
    given: u64,
    out: Vec<i32>,
}

impl Converter {
    /// A converter from `from` to `to`; none when the channels cannot be mapped (other than mono
    /// and stereo) or the rates cannot be converted.
    pub fn new(from: PcmFormat, to: PcmFormat) -> Option<Converter> {
        let mapped = from.channels == to.channels
            || (from.channels == 1 && to.channels == 2)
            || (from.channels == 2 && to.channels == 1);
        if !mapped || from.channels == 0 {
            return None;
        }
        let resampler = if from.rate == to.rate {
            None
        } else {
            let made = Fft::<f32>::new(
                from.rate as usize,
                to.rate as usize,
                CHUNK,
                usize::from(to.channels),
                FixedSync::Input,
            );
            Some(made.ok()?)
        };
        let delay = resampler.as_ref().map_or(0, Resampler::output_delay);
        Some(Converter {
            from,
            to,
            resampler,
            pending: Vec::new(),
            delay,
            taken: 0,
            given: 0,
            out: Vec::new(),
        })
    }

    /// Whether only the depth changes, upward: the samples are the file's own, shifted.
    pub fn exact(&self) -> bool {
        self.from.rate == self.to.rate && self.from.channels == self.to.channels && self.to.bits >= self.from.bits
    }

    /// The next block of the song, converted (possibly nothing yet: the resampler takes chunks).
    pub fn push(&mut self, block: &[i32]) -> &[i32] {
        self.out.clear();
        if self.exact() {
            let shift = self.to.bits - self.from.bits;
            self.out.extend(block.iter().map(|sample| sample << shift));
            return &self.out;
        }
        let scale = 1.0 / (1u64 << (self.from.bits - 1)) as f32;
        let channels = usize::from(self.from.channels);
        for frame in block.chunks_exact(channels) {
            match (self.from.channels, self.to.channels) {
                (1, 2) => {
                    let value = frame[0] as f32 * scale;
                    self.pending.extend([value, value]);
                }
                (2, 1) => self.pending.push((frame[0] as f32 + frame[1] as f32) * 0.5 * scale),
                _ => self.pending.extend(frame.iter().map(|sample| *sample as f32 * scale)),
            }
            self.taken += 1;
        }
        self.drain(false);
        &self.out
    }

    /// The end of the song: what the resampler still holds.
    pub fn finish(&mut self) -> &[i32] {
        self.out.clear();
        if !self.exact() {
            self.drain(true);
        }
        &self.out
    }

    /// Converts what is pending into `out`: whole chunks, or (at the end) the rest and the
    /// resampler's padding, up to the song's length at the new rate.
    fn drain(&mut self, end: bool) {
        let channels = usize::from(self.to.channels);
        let Some(resampler) = self.resampler.as_mut() else {
            let pending = std::mem::take(&mut self.pending);
            self.given += (pending.len() / channels) as u64;
            for value in pending {
                self.out.push(to_int(value, self.to.bits));
            }
            return;
        };
        let wanted = (self.taken as f64 * f64::from(self.to.rate) / f64::from(self.from.rate)).round() as u64;
        loop {
            let next = resampler.input_frames_next();
            let have = self.pending.len() / channels;
            if have < next && !end {
                return;
            }
            if end && have == 0 && self.given >= wanted {
                return;
            }
            let frames = have.min(next);
            let mut chunk: Vec<f32> = self.pending.drain(..frames * channels).collect();
            chunk.resize(next * channels, 0.0);
            let Ok(input) = InterleavedSlice::new(&chunk[..], channels, next) else {
                return;
            };
            let indexing = Indexing::new().partial_len(frames);
            let Ok(output) = resampler.process(&input, if frames < next { Some(&indexing) } else { None }) else {
                return;
            };
            let data = output.take_data();
            let mut produced = data.len() / channels;
            let mut start = 0;
            if self.delay > 0 {
                let dropped = self.delay.min(produced);
                self.delay -= dropped;
                start = dropped;
                produced -= dropped;
            }
            let mut keep = produced as u64;
            if end {
                keep = keep.min(wanted.saturating_sub(self.given));
            }
            for value in &data[start * channels..(start + keep as usize) * channels] {
                self.out.push(to_int(*value, self.to.bits));
            }
            self.given += keep;
            if end && self.given >= wanted && self.pending.is_empty() {
                return;
            }
        }
    }
}

/// A float from -1 to 1 as a sample of `bits`.
fn to_int(value: f32, bits: u32) -> i32 {
    let top = ((1u64 << (bits - 1)) - 1) as f64;
    (f64::from(value) * (top + 1.0)).round().clamp(-top - 1.0, top) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn format(rate: u32, channels: u16, bits: u32) -> PcmFormat {
        PcmFormat { rate, channels, bits }
    }

    /// A sine of `hz` at half scale, `frames` long, in `channels` (the same on each).
    fn sine(hz: f64, rate: u32, channels: u16, bits: u32, frames: usize) -> Vec<i32> {
        let scale = (1u64 << (bits - 2)) as f64;
        (0..frames)
            .flat_map(|frame| {
                let value = (2.0 * std::f64::consts::PI * hz * frame as f64 / f64::from(rate)).sin() * scale;
                std::iter::repeat_n(value.round() as i32, usize::from(channels))
            })
            .collect()
    }

    fn all(converter: &mut Converter, samples: &[i32], block: usize) -> Vec<i32> {
        let mut out = Vec::new();
        for piece in samples.chunks(block) {
            out.extend_from_slice(converter.push(piece));
        }
        out.extend_from_slice(converter.finish());
        out
    }

    #[test]
    fn a_shallower_song_is_shifted_exactly() {
        let mut converter = Converter::new(format(44100, 2, 16), format(44100, 2, 24)).expect("made");
        assert!(converter.exact());
        assert_eq!(converter.push(&[1, -2, 300, -32768]), &[256, -512, 76800, -8388608]);
        assert!(converter.finish().is_empty());
    }

    #[test]
    fn mono_goes_to_both_sides_and_stereo_to_its_mean() {
        let mut up = Converter::new(format(44100, 1, 16), format(44100, 2, 16)).expect("made");
        assert_eq!(up.push(&[100, -100]), &[100, 100, -100, -100]);
        let mut down = Converter::new(format(44100, 2, 16), format(44100, 1, 16)).expect("made");
        assert_eq!(down.push(&[100, 300, -100, -300]), &[200, -200]);
    }

    #[test]
    fn other_channels_are_not_mapped() {
        assert!(Converter::new(format(44100, 6, 16), format(44100, 2, 16)).is_none());
    }

    #[test]
    fn a_resampled_song_keeps_its_length_and_its_tone() {
        let frames = 44100;
        let song = sine(1000.0, 44100, 2, 16, frames);
        let mut converter = Converter::new(format(44100, 2, 16), format(96000, 2, 24)).expect("made");
        let out = all(&mut converter, &song, 4096);
        assert_eq!(out.len(), 96000 * 2, "one second at the new rate, to the frame");
        // The same sine at the new rate and depth, away from the ends (the filter's edges).
        let expected = sine(1000.0, 96000, 2, 24, 96000);
        let worst = out[20000..170000]
            .iter()
            .zip(&expected[20000..170000])
            .map(|(got, want)| (got - want).abs())
            .max()
            .unwrap_or(0);
        // Within one step of the 16-bit original (256 at 24 bits): nothing added above its own noise.
        assert!(worst < 256, "within a 16-bit step: {worst}");
    }

    #[test]
    fn a_resampled_song_comes_out_in_any_blocks() {
        let song = sine(440.0, 48000, 1, 24, 12345);
        let mut one = Converter::new(format(48000, 1, 24), format(44100, 2, 24)).expect("made");
        let mut other = Converter::new(format(48000, 1, 24), format(44100, 2, 24)).expect("made");
        let whole = all(&mut one, &song, 12345);
        let pieces = all(&mut other, &song, 777);
        assert_eq!(whole, pieces);
        assert_eq!(whole.len(), (12345.0f64 * 44100.0 / 48000.0).round() as usize * 2);
    }
}
