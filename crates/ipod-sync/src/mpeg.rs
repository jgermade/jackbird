//! An MP3's audio, as the iPod's databases need it: from its first MPEG frame,
//! its bit rate and sample rate, and whether a Xing or VBRI header says the bit
//! rate varies (LAME's `Info` header marks a constant one); and its length, from
//! the frame count such a header gives, or by walking every frame.
//!
//! Apple's own numbers, on the owner's nano 7G: the length is the frames
//! times their samples (no gapless trim; a Xing header's count, else every
//! frame, LAME's `Info` one included), and a variable bit rate is the audio's
//! bytes over that length (`RECORD/2026-11-14.ipod-sync.WIP.md`, N4c).
//!
//! The header's layout is MPEG-1 and MPEG-2's (ISO/IEC 11172-3, 13818-3), and
//! the Xing and VBRI headers' are as LAME and Fraunhofer write them.

/// What the first frame says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Frame {
    /// Samples in each frame: 1152 for MPEG-1, 576 for MPEG-2 and 2.5.
    pub samples_per_frame: u32,
    /// Where it starts in the file.
    pub offset: usize,
    /// Its bit rate, kbit/s.
    pub bitrate: u32,
    /// Its sample rate, Hz.
    pub sample_rate: u32,
    /// The Xing or VBRI header of a variable bit rate file.
    pub vbr: Option<Vbr>,
}

/// A Xing or VBRI header's counts (0 when it leaves one out).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Vbr {
    /// Frames in the file.
    pub frames: u32,
    /// Bytes of audio in the file.
    pub bytes: u32,
}

/// The parts of a frame header.
struct Header {
    mpeg1: bool,
    mono: bool,
    bitrate: u32,
    sample_rate: u32,
    length: usize,
}

const BITRATES_V1_L3: [u32; 15] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3: [u32; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/// The header at the start of `b`, if it is a valid Layer III one.
fn header(b: &[u8]) -> Option<Header> {
    let h = u32::from_be_bytes(b.get(..4)?.try_into().ok()?);
    if h >> 21 != 0x7ff {
        return None;
    }
    let version = (h >> 19) & 3; // 0: 2.5, 2: 2, 3: 1
    let layer = (h >> 17) & 3; // 1: III
    let bitrate_index = ((h >> 12) & 0xf) as usize;
    let rate_index = ((h >> 10) & 3) as usize;
    if version == 1 || layer != 1 || bitrate_index == 0 || bitrate_index == 15 || rate_index == 3 {
        return None;
    }
    let mpeg1 = version == 3;
    let bitrate = if mpeg1 { BITRATES_V1_L3 } else { BITRATES_V2_L3 }[bitrate_index];
    let base = [44_100, 48_000, 32_000][rate_index];
    let sample_rate = match version {
        3 => base,
        2 => base / 2,
        _ => base / 4,
    };
    let padding = ((h >> 9) & 1) as usize;
    let mono = (h >> 6) & 3 == 3;
    let per_frame = if mpeg1 { 144 } else { 72 };
    let length = (per_frame * bitrate * 1000 / sample_rate) as usize + padding;
    Some(Header {
        mpeg1,
        mono,
        bitrate,
        sample_rate,
        length,
    })
}

/// Where the audio starts: after an ID3v2 tag (and its footer), if any.
fn audio_start(bytes: &[u8]) -> usize {
    if bytes.len() >= 10 && &bytes[..3] == b"ID3" {
        let size = bytes[6..10]
            .iter()
            .fold(0usize, |s, b| (s << 7) | usize::from(b & 0x7f));
        let footer = if bytes[5] & 0x10 != 0 { 10 } else { 0 };
        10 + size + footer
    } else {
        0
    }
}

fn be32(b: &[u8], at: usize) -> u32 {
    b.get(at..at + 4)
        .map_or(0, |s| u32::from_be_bytes(s.try_into().expect("four bytes")))
}

/// The first frame: the first valid header after the tags whose next frame
/// starts with a valid header too (so a stray sync in junk is skipped).
pub fn first_frame(bytes: &[u8]) -> Option<Frame> {
    let mut at = audio_start(bytes);
    while at + 4 <= bytes.len() {
        let Some(h) = header(&bytes[at..]) else {
            at += 1;
            continue;
        };
        let next = at + h.length;
        if next + 4 <= bytes.len() && header(&bytes[next..]).is_none() {
            at += 1;
            continue;
        }
        let frame = &bytes[at..(at + h.length).min(bytes.len())];
        let side = match (h.mpeg1, h.mono) {
            (true, false) => 32,
            (true, true) => 17,
            (false, false) => 17,
            (false, true) => 9,
        };
        let xing = 4 + side;
        let vbr = match frame.get(xing..xing + 4) {
            Some(b"Xing") => {
                let flags = be32(frame, xing + 4);
                let mut field = xing + 8;
                let mut take = |present: bool| {
                    if present {
                        let v = be32(frame, field);
                        field += 4;
                        v
                    } else {
                        0
                    }
                };
                let frames = take(flags & 1 != 0);
                let bytes = take(flags & 2 != 0);
                Some(Vbr { frames, bytes })
            }
            _ if frame.get(36..40) == Some(b"VBRI") => Some(Vbr {
                bytes: be32(frame, 36 + 10),
                frames: be32(frame, 36 + 14),
            }),
            _ => None,
        };
        return Some(Frame {
            samples_per_frame: if h.mpeg1 { 1152 } else { 576 },
            offset: at,
            bitrate: h.bitrate,
            sample_rate: h.sample_rate,
            vbr,
        });
    }
    None
}

/// An MP3's audio as a whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Audio {
    /// Its first frame.
    pub first: Frame,
    /// Its frames: the Xing or VBRI header's count, else every whole frame
    /// walked (LAME's `Info` frame included, junk between frames skipped).
    pub frames: u64,
    /// Its samples: the frames times their samples.
    pub samples: u64,
    /// Its length in milliseconds, rounded down.
    pub length_ms: u32,
    /// Its bit rate, kbit/s: the first frame's, or for a variable one its
    /// bytes over its length, rounded down.
    pub bitrate: u32,
}

/// The whole of an MP3's audio.
pub fn audio(bytes: &[u8]) -> Option<Audio> {
    let first = first_frame(bytes)?;
    let frames = match first.vbr {
        Some(v) if v.frames > 0 => u64::from(v.frames),
        _ => {
            let mut count = 0u64;
            let mut at = first.offset;
            // A Xing header's frame holds no audio; LAME's Info frame counts,
            // as it does in Apple's lengths.
            if first.vbr.is_some() {
                at += header(&bytes[at..])?.length;
            }
            // Whole frames only, before an ID3v1 tag; past anything that is not
            // a frame, to the next one.
            let id3v1 = bytes.len() >= 128 && &bytes[bytes.len() - 128..bytes.len() - 125] == b"TAG";
            let end = bytes.len() - if id3v1 { 128 } else { 0 };
            while at + 4 <= end {
                match header(&bytes[at..end]) {
                    Some(h) if at + h.length <= end => {
                        count += 1;
                        at += h.length;
                    }
                    _ => at += 1,
                }
            }
            count
        }
    };
    let samples = frames * u64::from(first.samples_per_frame);
    let length_ms = samples * 1000 / u64::from(first.sample_rate);
    let length_ms = u32::try_from(length_ms).ok()?;
    let bitrate = match first.vbr {
        Some(v) if v.bytes > 0 && length_ms > 0 => (u64::from(v.bytes) * 8 / u64::from(length_ms)) as u32,
        _ => first.bitrate,
    };
    Some(Audio {
        first,
        frames,
        samples,
        length_ms,
        bitrate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame header: MPEG-1 Layer III, the bit rate index, 44.1 kHz, stereo.
    fn frame(bitrate_index: u8, body: &[u8]) -> Vec<u8> {
        let h = [0xff, 0xfb, bitrate_index << 4, 0x00];
        let length = 144 * BITRATES_V1_L3[bitrate_index as usize] as usize * 1000 / 44_100;
        let mut f = h.to_vec();
        f.extend_from_slice(body);
        f.resize(length, 0);
        f
    }

    #[test]
    fn constant_and_variable() {
        let mut cbr = b"ID3\x03\x00\x00\x00\x00\x00\x05abcde".to_vec();
        for _ in 0..3 {
            cbr.extend(frame(9, &[]));
        }
        assert_eq!(
            first_frame(&cbr),
            Some(Frame {
                samples_per_frame: 1152,
                offset: 15,
                bitrate: 128,
                sample_rate: 44_100,
                vbr: None
            })
        );
        let whole = audio(&cbr).unwrap();
        assert_eq!(whole.frames, 3);
        assert_eq!(whole.samples, 3456);
        assert_eq!(whole.length_ms, 78);
        assert_eq!(whole.bitrate, 128);

        let mut xing = vec![0u8; 32];
        xing.extend_from_slice(b"Xing");
        xing.extend_from_slice(&3u32.to_be_bytes());
        xing.extend_from_slice(&1000u32.to_be_bytes());
        xing.extend_from_slice(&4_000_000u32.to_be_bytes());
        let mut vbr = frame(9, &xing);
        vbr.extend(frame(11, &[]));
        assert_eq!(
            first_frame(&vbr).unwrap().vbr,
            Some(Vbr {
                frames: 1000,
                bytes: 4_000_000
            })
        );
        let whole = audio(&vbr).unwrap();
        assert_eq!(whole.samples, 1_152_000);
        assert_eq!(whole.length_ms, 26_122);
        assert_eq!(whole.bitrate, 1225); // 4,000,000 bytes over 26.122 s

        // LAME's Info header: constant.
        let mut info = vec![0u8; 32];
        info.extend_from_slice(b"Info");
        let mut lame_cbr = frame(9, &info);
        lame_cbr.extend(frame(9, &[]));
        lame_cbr.extend(frame(9, &[]));
        assert_eq!(first_frame(&lame_cbr).unwrap().vbr, None);
        // The Info frame counts, as in Apple's lengths.
        assert_eq!(audio(&lame_cbr).unwrap().frames, 3);
        // Junk between frames, a cut last frame and an ID3v1 tag are not frames.
        let mut odd = frame(9, &[]);
        odd.extend(frame(9, &[]));
        odd.extend([1, 2, 3, 4, 5]);
        odd.extend(frame(9, &[]));
        odd.extend(&frame(9, &[])[..100]);
        let mut tail = b"TAG".to_vec();
        tail.resize(128, b' ');
        odd.extend(tail);
        assert_eq!(audio(&odd).unwrap().frames, 3);
    }

    #[test]
    fn junk_and_nothing() {
        // A stray sync before the real frames is skipped.
        let mut junk = vec![0xff, 0xfb, 0x90, 0x00, 1, 2, 3];
        junk.extend(frame(9, &[]));
        junk.extend(frame(9, &[]));
        assert_eq!(first_frame(&junk).unwrap().bitrate, 128);
        assert_eq!(first_frame(b"not audio at all"), None);
        assert_eq!(first_frame(&[]), None);
    }
}
