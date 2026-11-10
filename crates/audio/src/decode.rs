//! A song decoded as it plays: `symphonia` reads the file from disk packet by packet; samples come
//! out interleaved, as integers at the file's own depth (right-aligned in an `i32`), so that what
//! reaches the device can be compared bit for bit with the file.

use std::fs::File;
use std::path::Path;

use symphonia::core::audio::GenericAudioBufferRef;
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions, VerificationCheck};
use symphonia::core::errors::Error as Failure;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::Time;

use crate::PcmFormat;

/// The depth MP3 (decoded to floats) is given at: far below its own precision's limit.
const LOSSY_BITS: u32 = 24;

/// A song being decoded.
pub struct Source {
    reader: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track: u32,
    format: PcmFormat,
    codec: &'static str,
    frames: Option<u64>,
    md5: Option<[u8; 16]>,
    /// Whether the decoder gives floats (MP3), to be turned into integers at [`LOSSY_BITS`].
    lossy: bool,
    block: Vec<i32>,
    floats: Vec<f32>,
    /// Frames to drop from the next blocks (after an accurate seek that landed before its time).
    skip: u64,
    done: bool,
}

fn failed(error: Failure) -> String {
    error.to_string()
}

impl Source {
    /// Opens a FLAC or MP3 file to decode it from its start.
    pub fn open(path: &Path) -> Result<Source, String> {
        let file = File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
        let stream = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(extension) = path.extension().and_then(|extension| extension.to_str()) {
            hint.with_extension(&extension.to_ascii_lowercase());
        }
        let reader = symphonia::default::get_probe()
            .probe(&hint, stream, FormatOptions::default(), MetadataOptions::default())
            .map_err(failed)?;
        let track = reader
            .default_track(TrackType::Audio)
            .ok_or_else(|| "no audio in the file".to_string())?;
        let id = track.id;
        let frames = track.num_frames;
        let params = track
            .codec_params
            .as_ref()
            .and_then(|params| params.audio())
            .ok_or_else(|| "no audio parameters in the file".to_string())?
            .clone();
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&params, &AudioDecoderOptions::default())
            .map_err(failed)?;
        let rate = params.sample_rate.ok_or("no sample rate in the file")?;
        let channels = params
            .channels
            .as_ref()
            .map(|channels| channels.count())
            .ok_or("no channels in the file")?;
        let lossy = params.bits_per_sample.is_none();
        let bits = params.bits_per_sample.unwrap_or(LOSSY_BITS);
        let codec = if lossy { "MP3" } else { "FLAC" };
        let md5 = match params.verification_check {
            Some(VerificationCheck::Md5(md5)) if md5 != [0; 16] => Some(md5),
            _ => None,
        };
        Ok(Source {
            reader,
            decoder,
            track: id,
            format: PcmFormat {
                rate,
                channels: channels as u16,
                bits,
            },
            codec,
            frames,
            md5,
            lossy,
            block: Vec::new(),
            floats: Vec::new(),
            skip: 0,
            done: false,
        })
    }

    /// The format of its samples.
    pub fn format(&self) -> PcmFormat {
        self.format
    }

    /// "FLAC" or "MP3".
    pub fn codec(&self) -> &'static str {
        self.codec
    }

    /// Its length in frames, when the file says.
    pub fn frames(&self) -> Option<u64> {
        self.frames
    }

    /// Its length in seconds, when the file says.
    pub fn duration(&self) -> Option<f64> {
        self.frames.map(|frames| frames as f64 / f64::from(self.format.rate))
    }

    /// The MD5 of its PCM, from a FLAC file's STREAMINFO (none when the encoder left it out).
    pub fn md5(&self) -> Option<[u8; 16]> {
        self.md5
    }

    /// The next block of samples, interleaved; `None` at the end.
    pub fn next_block(&mut self) -> Result<Option<&[i32]>, String> {
        loop {
            if self.done {
                return Ok(None);
            }
            let packet = match self.reader.next_packet() {
                Ok(Some(packet)) => packet,
                Ok(None) => {
                    self.done = true;
                    return Ok(None);
                }
                Err(Failure::IoError(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                    self.done = true;
                    return Ok(None);
                }
                Err(error) => return Err(failed(error)),
            };
            if packet.track_id != self.track {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                // A damaged packet is skipped, as players do.
                Err(Failure::DecodeError(_)) => continue,
                Err(error) => return Err(failed(error)),
            };
            if decoded.frames() == 0 {
                continue;
            }
            let count = decoded.samples_interleaved();
            self.block.resize(count, 0);
            if self.lossy {
                self.floats.resize(count, 0.0);
                decoded.copy_to_slice_interleaved(&mut self.floats);
                let scale = f64::from(1u32 << (LOSSY_BITS - 1));
                let top = (1i64 << (LOSSY_BITS - 1)) - 1;
                for (out, sample) in self.block.iter_mut().zip(&self.floats) {
                    let value = (f64::from(*sample) * scale).round() as i64;
                    *out = value.clamp(-top - 1, top) as i32;
                }
            } else {
                full_scale(&decoded, &mut self.block);
                let shift = 32 - self.format.bits;
                if shift > 0 {
                    for sample in &mut self.block {
                        *sample >>= shift;
                    }
                }
            }
            let channels = usize::from(self.format.channels);
            if self.skip > 0 {
                let frames = (self.block.len() / channels) as u64;
                let dropped = self.skip.min(frames);
                self.skip -= dropped;
                self.block.drain(..dropped as usize * channels);
                if self.block.is_empty() {
                    continue;
                }
            }
            return Ok(Some(&self.block));
        }
    }

    /// Moves to `seconds` into the song, to the frame; returns the frame it is at.
    pub fn seek(&mut self, seconds: f64) -> Result<u64, String> {
        let seconds = seconds.max(0.0);
        let rate = u64::from(self.format.rate);
        let mut wanted = (seconds * rate as f64).round() as u64;
        if let Some(frames) = self.frames {
            wanted = wanted.min(frames);
        }
        let time = Time::try_from_secs_f64(wanted as f64 / rate as f64).unwrap_or_default();
        let seeked = self
            .reader
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time,
                    track_id: Some(self.track),
                },
            )
            .map_err(failed)?;
        self.decoder.reset();
        self.done = false;
        let actual = u64::try_from(seeked.actual_ts.get()).unwrap_or(0);
        let required = u64::try_from(seeked.required_ts.get()).unwrap_or(actual);
        self.skip = required.saturating_sub(actual);
        Ok(required)
    }
}

/// Copies a decoded buffer into `out` as full-scale `i32`s (integers widened by shifting, exactly).
fn full_scale(decoded: &GenericAudioBufferRef<'_>, out: &mut [i32]) {
    decoded.copy_to_slice_interleaved(out);
}
