//! The spectrum of what the device took, as Web Audio's `AnalyserNode` gives it with
//! `getByteFrequencyData` (fftSize 1024, smoothing 0.8, -100 to -30 dB): a Blackman window, the
//! magnitudes over the window's length, smoothed with the previous ones, in decibels, scaled to
//! 0–255. The interface turns the bins into bands as it does for the embedded output
//! (`src/helpers/spectrum.ts`). The FFT is written here: 1024 points, radix 2.

use std::f32::consts::PI;

/// Points of the transform (Web Audio's `fftSize`).
pub const SIZE: usize = 1024;
/// Bins it gives (Web Audio's `frequencyBinCount`).
pub const BINS: usize = SIZE / 2;
const SMOOTHING: f32 = 0.8;
const MIN_DB: f32 = -100.0;
const MAX_DB: f32 = -30.0;

/// The analyser's state between readings (the smoothing needs the previous magnitudes).
pub struct Spectrum {
    window: Vec<f32>,
    smoothed: Vec<f32>,
    real: Vec<f32>,
    imaginary: Vec<f32>,
}

impl Default for Spectrum {
    fn default() -> Self {
        Spectrum::new()
    }
}

impl Spectrum {
    /// An analyser with nothing heard yet.
    pub fn new() -> Spectrum {
        let window = (0..SIZE)
            .map(|index| {
                let x = index as f32 / SIZE as f32;
                0.42 - 0.5 * (2.0 * PI * x).cos() + 0.08 * (4.0 * PI * x).cos()
            })
            .collect();
        Spectrum {
            window,
            smoothed: vec![0.0; BINS],
            real: vec![0.0; SIZE],
            imaginary: vec![0.0; SIZE],
        }
    }

    /// The bins (0–255, low frequencies first) of the last [`SIZE`] samples, from -1 to 1.
    pub fn bins(&mut self, samples: &[f32]) -> Vec<u8> {
        for index in 0..SIZE {
            self.real[index] = samples.get(index).copied().unwrap_or(0.0) * self.window[index];
            self.imaginary[index] = 0.0;
        }
        fft(&mut self.real, &mut self.imaginary);
        let mut bins = Vec::with_capacity(BINS);
        for index in 0..BINS {
            let magnitude = self.real[index].hypot(self.imaginary[index]) / SIZE as f32;
            let smoothed = SMOOTHING * self.smoothed[index] + (1.0 - SMOOTHING) * magnitude;
            self.smoothed[index] = if smoothed.is_finite() { smoothed } else { 0.0 };
            let decibels = 20.0 * self.smoothed[index].max(1e-12).log10();
            let scaled = 255.0 * (decibels - MIN_DB) / (MAX_DB - MIN_DB);
            bins.push(scaled.clamp(0.0, 255.0) as u8);
        }
        bins
    }
}

/// An in-place radix-2 FFT of a power-of-two length.
fn fft(real: &mut [f32], imaginary: &mut [f32]) {
    let size = real.len();
    let mut swap = 0;
    for index in 1..size {
        let mut bit = size >> 1;
        while swap & bit != 0 {
            swap ^= bit;
            bit >>= 1;
        }
        swap |= bit;
        if index < swap {
            real.swap(index, swap);
            imaginary.swap(index, swap);
        }
    }
    let mut length = 2;
    while length <= size {
        let angle = -2.0 * PI / length as f32;
        for start in (0..size).step_by(length) {
            for step in 0..length / 2 {
                let (sin, cos) = (angle * step as f32).sin_cos();
                let even = start + step;
                let odd = even + length / 2;
                let odd_real = real[odd] * cos - imaginary[odd] * sin;
                let odd_imaginary = real[odd] * sin + imaginary[odd] * cos;
                real[odd] = real[even] - odd_real;
                imaginary[odd] = imaginary[even] - odd_imaginary;
                real[even] += odd_real;
                imaginary[even] += odd_imaginary;
            }
        }
        length <<= 1;
    }
}
