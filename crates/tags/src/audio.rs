//! A file's audio, as Info and the duplicates' "best quality" show it: its length, bit rate, sample
//! rate, channels and depth, read from its first bytes alone. An MP3's from its first frame (a Xing
//! or VBRI header's frame count for a variable bit rate; else its audio's bytes over its constant
//! bit rate); a FLAC's from its STREAMINFO block (its samples over its rate; its bit rate, its
//! audio's bytes over that length). See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-16).

use crate::{FileLayout, Format, mpeg};

/// How many bytes after the audio region's start the first bytes must hold for an MP3's first
/// frame and its Xing or VBRI header: [`audio`] reads no further.
pub const AUDIO_PROBE: u64 = 4096;

/// A file's audio.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Audio {
    /// Its length, in milliseconds.
    pub duration_ms: u32,
    /// Its bit rate, kbit/s (its average, for a variable one).
    pub bitrate: u32,
    /// Its sample rate, Hz.
    pub sample_rate: u32,
    /// Its channels.
    pub channels: u8,
    /// Its bits per sample (FLAC); 0 for MP3, which has none.
    pub bits: u8,
    /// Whether its bit rate varies (an MP3 with a Xing or VBRI header; every FLAC).
    pub vbr: bool,
}

/// A file's audio from `head` (its first bytes: to [`AUDIO_PROBE`] past the audio region's start
/// for an MP3) and its layout; `None` when it cannot be told.
pub fn audio(head: &[u8], layout: &FileLayout) -> Option<Audio> {
    let bytes = layout.audio.end.saturating_sub(layout.audio.start);
    match layout.format? {
        Format::Mp3 => {
            let start = usize::try_from(layout.audio.start).ok()?;
            let frame = mpeg::first_frame(head.get(start..)?)?;
            let channels = if frame.mono { 1 } else { 2 };
            match frame.vbr {
                Some(vbr) if vbr.frames > 0 => {
                    let samples = u64::from(vbr.frames) * u64::from(frame.samples_per_frame);
                    let ms = samples * 1000 / u64::from(frame.sample_rate);
                    let audio_bytes = if vbr.bytes > 0 { u64::from(vbr.bytes) } else { bytes };
                    let bitrate = (audio_bytes * 8).checked_div(ms).unwrap_or(u64::from(frame.bitrate));
                    Some(Audio {
                        duration_ms: u32::try_from(ms).ok()?,
                        bitrate: u32::try_from(bitrate).ok()?,
                        sample_rate: frame.sample_rate,
                        channels,
                        bits: 0,
                        vbr: true,
                    })
                }
                // A constant bit rate: the audio's bytes (from the first frame) over it.
                _ => {
                    let audio_bytes = bytes.saturating_sub(frame.offset as u64);
                    Some(Audio {
                        duration_ms: u32::try_from(audio_bytes * 8 / u64::from(frame.bitrate.max(1))).ok()?,
                        bitrate: frame.bitrate,
                        sample_rate: frame.sample_rate,
                        channels,
                        bits: 0,
                        vbr: false,
                    })
                }
            }
        }
        Format::Flac => {
            // STREAMINFO: the first block after the marker (which may follow an ID3v2 tag).
            // After an ID3v2 tag, if any (whose text could hold the marker's letters).
            let after = jackbird_id3::tag_len(head).unwrap_or(0);
            let marker = after + head.get(after..)?.windows(4).position(|window| window == b"fLaC")?;
            let block = head.get(marker + 4..marker + 8)?;
            if block[0] & 0x7f != 0 {
                return None;
            }
            let info = head.get(marker + 8..marker + 8 + 34)?;
            let packed = u64::from_be_bytes(info[10..18].try_into().ok()?);
            let sample_rate = (packed >> 44) as u32;
            let channels = ((packed >> 41) & 7) as u8 + 1;
            let bits = ((packed >> 36) & 0x1f) as u8 + 1;
            let samples = packed & 0xf_ffff_ffff;
            if sample_rate == 0 {
                return None;
            }
            let ms = samples * 1000 / u64::from(sample_rate);
            let bitrate = (bytes * 8).checked_div(ms).unwrap_or(0);
            Some(Audio {
                duration_ms: u32::try_from(ms).ok()?,
                bitrate: u32::try_from(bitrate).ok()?,
                sample_rate,
                channels,
                bits,
                vbr: true,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// MPEG-1 Layer III frames at 128 kbit/s, 44.1 kHz, stereo: 417 bytes each.
    fn cbr(frames: usize) -> Vec<u8> {
        let mut out = Vec::new();
        for _ in 0..frames {
            let mut frame = vec![0xff, 0xfb, 0x90, 0x00];
            frame.resize(417, 0);
            out.extend(frame);
        }
        out
    }

    fn layout(format: Format, start: u64, end: u64) -> FileLayout {
        FileLayout { format: Some(format), tags_end: start, audio: start..end }
    }

    #[test]
    fn a_constant_mp3s_length_is_its_bytes_over_its_bit_rate() {
        let bytes = cbr(100);
        let found = audio(&bytes, &layout(Format::Mp3, 0, bytes.len() as u64)).unwrap();
        // 41,700 bytes at 128 kbit/s: 2,606 ms.
        assert_eq!((found.duration_ms, found.bitrate, found.sample_rate, found.channels, found.vbr), (2606, 128, 44_100, 2, false));
    }

    #[test]
    fn a_variable_mp3s_length_is_its_xing_frames() {
        let mut first = vec![0xff, 0xfb, 0x90, 0x00];
        first.resize(4 + 32, 0);
        first.extend(b"Xing");
        first.extend(3u32.to_be_bytes());
        first.extend(1000u32.to_be_bytes()); // frames
        first.extend(500_000u32.to_be_bytes()); // bytes
        first.resize(417, 0);
        let mut bytes = first;
        bytes.extend(cbr(3));
        let found = audio(&bytes, &layout(Format::Mp3, 0, 600_000)).unwrap();
        // 1000 frames of 1152 samples at 44.1 kHz: 26,122 ms; 500,000 bytes over it: 153 kbit/s.
        assert_eq!((found.duration_ms, found.bitrate, found.vbr), (26_122, 153, true));
    }

    #[test]
    fn a_flacs_comes_from_its_streaminfo() {
        let mut bytes = b"fLaC".to_vec();
        bytes.extend([0x80, 0, 0, 34]);
        let mut info = vec![0u8; 34];
        // 44,100 Hz, 2 channels, 16 bits, 441,000 samples (10 s).
        let packed: u64 = (44_100 << 44) | (1 << 41) | (15 << 36) | 441_000;
        info[10..18].copy_from_slice(&packed.to_be_bytes());
        bytes.extend(info);
        let found = audio(&bytes, &layout(Format::Flac, 42, 42 + 1_000_000)).unwrap();
        assert_eq!((found.duration_ms, found.sample_rate, found.channels, found.bits, found.bitrate), (10_000, 44_100, 2, 16, 800));
    }

    #[test]
    fn nothing_without_the_first_frame_or_a_streaminfo() {
        assert_eq!(audio(&[0; 64], &layout(Format::Mp3, 0, 64)), None);
        assert_eq!(audio(b"fLaC\x01\x00\x00\x00", &layout(Format::Flac, 8, 100)), None);
        assert_eq!(audio(&cbr(2), &FileLayout { format: None, tags_end: 0, audio: 0..834 }), None);
    }
}
