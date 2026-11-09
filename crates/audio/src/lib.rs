//! jackbird's native output (E5, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-09
//! 19:37 and the extensions after it): the desktop app's player in Rust, so a song reaches the
//! device at its own rate and depth.
//!
//! - **Decoding** ([`Source`]): FLAC and MP3 with `symphonia`, read from disk as it plays, never
//!   whole; samples come out as integers at the file's own depth (MP3, a lossy format, at 24 bits).
//! - **The player** ([`Player`]): a thread that decodes ahead into a [`Pipe`], from which the
//!   output takes what it plays. The next song is decoded into the same pipe when its format is
//!   the same (gapless); another format reopens the output once the first has played.
//! - **Outputs** ([`Output`]): a device, shared (the system's mixer) or exclusive (macOS's hog
//!   mode, WASAPI's exclusive mode, ALSA's `hw:` devices), behind the `device` feature; and a
//!   capture output, which records what a device would have been given (the tests).
//! - **The spectrum** ([`Spectrum`]): from what the output took, on the same scale as Web Audio's
//!   analyser, so the interface draws it the same way in both outputs.
//!
//! The tag crates stay free of dependencies; this one is beside them, as `store` is.

mod capture;
mod decode;
#[cfg(feature = "device")]
mod device;
mod engine;
mod pipe;
mod spectrum;

pub use capture::{Capture, CaptureOutput};
pub use decode::Source;
#[cfg(feature = "device")]
pub use device::{DeviceOutput, devices};
pub use engine::{Event, Player, Status};
pub use pipe::{Pipe, to_device};
pub use spectrum::Spectrum;

use serde::{Deserialize, Serialize};

/// What a song decodes to: the samples' rate, channels and depth.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PcmFormat {
    /// Frames a second.
    pub rate: u32,
    /// Channels in each frame.
    pub channels: u16,
    /// Significant bits of each sample (16, 24, 32; MP3 is decoded at 24).
    pub bits: u32,
}

/// How a device is used.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Through the system's mixer, beside other apps' sound (the default).
    #[default]
    Shared,
    /// The device for this app alone: nothing else mixed in, nothing else changes its rate.
    Exclusive,
}

/// The output's settings, chosen in the app.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    /// Shared or exclusive.
    pub mode: Mode,
    /// The device's id (from [`devices`]); `None` is the system's default output.
    pub device: Option<String>,
}

/// The device's sample format, as the output writes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceSample {
    /// 16-bit integers.
    I16,
    /// 24-bit integers in 32-bit words, in the low bits.
    I24,
    /// 32-bit integers.
    I32,
    /// 32-bit floats, from -1 to 1.
    F32,
    /// 24-bit integers in 32-bit words, in the high bits (WASAPI's 24-in-32).
    I24High,
}

impl DeviceSample {
    /// Bytes a sample takes.
    pub fn bytes(self) -> usize {
        match self {
            DeviceSample::I16 => 2,
            _ => 4,
        }
    }

    /// Whether a sample of `bits` passes through it unchanged.
    pub fn carries(self, bits: u32) -> bool {
        match self {
            DeviceSample::I16 => bits <= 16,
            DeviceSample::I24 | DeviceSample::I24High | DeviceSample::F32 => bits <= 24,
            DeviceSample::I32 => bits <= 32,
        }
    }
}

/// How faithful the way to the device is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Fidelity {
    /// Exclusive, at the song's rate, in a format that carries its depth: the device gets the
    /// file's samples, bit for bit.
    BitPerfect,
    /// Shared, at the song's rate and depth on this side: untouched while nothing else sounds and
    /// the system's volume is at its top (or done by the device itself).
    Mixer,
    /// Resampled or reduced on the way (the device does not take the song's rate or depth).
    Converted,
}

/// Where a song is playing, and how.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Route {
    /// The device's name.
    pub device: String,
    /// Shared or exclusive.
    pub mode: Mode,
    /// The rate the device runs at.
    pub rate: u32,
    /// The device's sample format.
    pub sample: DeviceSample,
    /// How faithful it is.
    pub fidelity: Fidelity,
}

/// A device that can be chosen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceInfo {
    /// What [`Settings::device`] names it by.
    pub id: String,
    /// Its name, as the system gives it.
    pub name: String,
    /// Whether it is the system's default output.
    pub default: bool,
    /// The modes it can be used in.
    pub modes: Vec<Mode>,
}

/// Where the player sends its samples.
pub trait Output: Send {
    /// Opens the device for `format`; it takes its samples from `pipe` until closed.
    fn open(&mut self, format: PcmFormat, pipe: std::sync::Arc<Pipe>) -> Result<Route, String>;
    /// Stops taking samples and lets the device go.
    fn close(&mut self);
}

/// Makes the output for some settings (a device's, or the tests' capture).
pub type Outputs = Box<dyn Fn(&Settings) -> Box<dyn Output> + Send>;
