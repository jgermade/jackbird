//! What lies between the decoder and the device: the samples decoded ahead, where each song in
//! them starts, how many frames the device has taken, and the last of them for the spectrum.
//!
//! The device's thread takes samples with [`Pipe::pull`]; the player's thread puts them with
//! [`Pipe::push`]. Both hold the lock only to copy.

use std::collections::VecDeque;
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::{DeviceSample, PcmFormat};

/// Frames of the mono mix kept for the spectrum.
pub const RECENT: usize = 2048;

/// A song's start in the pipe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mark {
    /// The frame of the stream (counted from the output's opening) where it starts.
    pub at: u64,
    /// The song's number in the player.
    pub song: u64,
    /// The frame of the song it starts from (after a seek, not 0).
    pub from: u64,
}

struct State {
    format: PcmFormat,
    samples: VecDeque<i32>,
    /// Frames put in since the output opened.
    pushed: u64,
    /// Frames the device has taken since the output opened.
    pulled: u64,
    /// Songs that start further on, in order.
    marks: VecDeque<Mark>,
    /// The song the device is playing, and where.
    sounding: Mark,
    paused: bool,
    /// Songs that started sounding since the player last asked, in order.
    started: Vec<u64>,
    recent: Vec<f32>,
    recent_at: usize,
}

/// The samples on their way to the device.
pub struct Pipe {
    state: Mutex<State>,
}

impl Pipe {
    /// An empty pipe for songs of `format`, starting with `first`.
    pub fn new(format: PcmFormat, first: Mark) -> Pipe {
        Pipe {
            state: Mutex::new(State {
                format,
                samples: VecDeque::new(),
                pushed: first.at,
                pulled: first.at,
                marks: VecDeque::new(),
                sounding: first,
                paused: false,
                started: vec![first.song],
                recent: vec![0.0; RECENT],
                recent_at: 0,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The format of what is in it.
    pub fn format(&self) -> PcmFormat {
        self.lock().format
    }

    /// Puts decoded samples at its end.
    pub fn push(&self, samples: &[i32]) {
        let mut state = self.lock();
        let channels = usize::from(state.format.channels);
        state.samples.extend(samples);
        state.pushed += (samples.len() / channels) as u64;
    }

    /// Says that the next samples put in are `song`'s, from its frame `from`.
    pub fn mark(&self, song: u64, from: u64) {
        let mut state = self.lock();
        let at = state.pushed;
        if at == state.pulled && state.samples.is_empty() {
            state.sounding = Mark { at, song, from };
            state.started.push(song);
        } else {
            state.marks.push_back(Mark { at, song, from });
        }
    }

    /// Takes away whatever was put in for songs after the one sounding (the next song changed).
    pub fn drop_ahead(&self) {
        let mut state = self.lock();
        if let Some(first) = state.marks.front().copied() {
            let channels = usize::from(state.format.channels);
            let keep = (first.at - state.pulled) as usize * channels;
            state.samples.truncate(keep);
            state.pushed = first.at;
            state.marks.clear();
        }
    }

    /// Empties it and starts again with `song` from its frame `from` (a seek).
    pub fn restart(&self, song: u64, from: u64) {
        let mut state = self.lock();
        state.samples.clear();
        state.marks.clear();
        state.pushed = state.pulled;
        state.sounding = Mark {
            at: state.pulled,
            song,
            from,
        };
        state.started.push(song);
    }

    /// The songs that started sounding since the last call, in order.
    pub fn take_started(&self) -> Vec<u64> {
        std::mem::take(&mut self.lock().started)
    }

    /// Frames waiting to be taken.
    pub fn queued(&self) -> u64 {
        let state = self.lock();
        (state.samples.len() / usize::from(state.format.channels)) as u64
    }

    /// The song sounding and the frame of it the device has reached.
    pub fn position(&self) -> (u64, u64) {
        let state = self.lock();
        (
            state.sounding.song,
            state.sounding.from + (state.pulled - state.sounding.at),
        )
    }

    /// Pauses (the device is given silence, and nothing is taken) or resumes.
    pub fn set_paused(&self, paused: bool) {
        self.lock().paused = paused;
    }

    /// Whether it is paused.
    pub fn paused(&self) -> bool {
        self.lock().paused
    }

    /// Fills `out` (interleaved, whole frames) with the next samples, silence where there are none;
    /// returns the frames of music it took.
    pub fn pull(&self, out: &mut [i32]) -> usize {
        let mut state = self.lock();
        let channels = usize::from(state.format.channels);
        if state.paused {
            out.fill(0);
            return 0;
        }
        let wanted = out.len() / channels;
        let mut taken = 0;
        while taken < wanted {
            // Stop at the next song's start, to move the mark on there.
            let until_mark = state
                .marks
                .front()
                .map_or(u64::MAX, |mark| mark.at.saturating_sub(state.pulled));
            if until_mark == 0 {
                let mark = state.marks.pop_front().unwrap_or(state.sounding);
                state.sounding = mark;
                state.started.push(mark.song);
                continue;
            }
            let available = state.samples.len() / channels;
            let frames = (wanted - taken)
                .min(available)
                .min(until_mark.min(usize::MAX as u64) as usize);
            if frames == 0 {
                break;
            }
            let start = taken * channels;
            for (slot, sample) in out[start..start + frames * channels]
                .iter_mut()
                .zip(state.samples.drain(..frames * channels))
            {
                *slot = sample;
            }
            state.pulled += frames as u64;
            taken += frames;
        }
        out[taken * channels..].fill(0);
        // The mono mix of what was taken, for the spectrum.
        let scale = 1.0 / (1u64 << (state.format.bits - 1)) as f32;
        for frame in out[..taken * channels].chunks_exact(channels) {
            let sum: f32 = frame.iter().map(|sample| *sample as f32).sum();
            let at = state.recent_at;
            state.recent[at] = sum * scale / channels as f32;
            state.recent_at = (at + 1) % RECENT;
        }
        // A song that starts exactly where the samples end becomes the one sounding.
        if let Some(mark) = state.marks.front().copied()
            && mark.at == state.pulled
        {
            state.marks.pop_front();
            state.sounding = mark;
            state.started.push(mark.song);
        }
        taken
    }

    /// The last `into.len()` frames of the mono mix the device took, oldest first.
    pub fn recent(&self, into: &mut [f32]) {
        let state = self.lock();
        let count = into.len().min(RECENT);
        let start = (state.recent_at + RECENT - count) % RECENT;
        for (index, slot) in into.iter_mut().take(count).enumerate() {
            *slot = state.recent[(start + index) % RECENT];
        }
    }
}

/// Writes `samples` (right-aligned at `bits`) as the device's `sample` format into `bytes`
/// (native byte order), exactly when the format carries the depth, reduced when it does not.
pub fn to_device(samples: &[i32], bits: u32, sample: DeviceSample, bytes: &mut [u8]) {
    let width = sample.bytes();
    for (value, out) in samples.iter().zip(bytes.chunks_exact_mut(width)) {
        let value = *value;
        match sample {
            DeviceSample::I16 => {
                let narrow = if bits > 16 {
                    value >> (bits - 16)
                } else {
                    value << (16 - bits)
                };
                out.copy_from_slice(&(narrow as i16).to_ne_bytes());
            }
            DeviceSample::I24 => {
                let narrow = if bits > 24 {
                    value >> (bits - 24)
                } else {
                    value << (24 - bits)
                };
                out.copy_from_slice(&narrow.to_ne_bytes());
            }
            DeviceSample::I24High => {
                let narrow = if bits > 24 {
                    value >> (bits - 24)
                } else {
                    value << (24 - bits)
                };
                out.copy_from_slice(&(narrow << 8).to_ne_bytes());
            }
            DeviceSample::I32 => {
                out.copy_from_slice(&(value << (32 - bits)).to_ne_bytes());
            }
            DeviceSample::F32 => {
                // Exact for up to 24 bits: a float's mantissa holds them.
                let float = value as f32 / (1u64 << (bits - 1)) as f32;
                out.copy_from_slice(&float.to_ne_bytes());
            }
        }
    }
}
