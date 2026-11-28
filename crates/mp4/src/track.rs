//! The audio track: the first `trak` whose handler is `soun`. Its codec and rates from its sample
//! description (`stsd`), its length from its media header (`mdhd`).

use crate::{Error, Kind, child, children, path, u16_at, u32_at, u64_at};

/// The codec of the audio.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    /// AAC (`mp4a` with an MPEG-4 audio object type).
    Aac,
    /// Apple Lossless (`alac`).
    Alac,
    /// Another sample entry: its type (`mp4a` of another object type, `enca`, `drms`, `ac-3`…).
    Other(Kind),
}

/// The audio track as its boxes describe it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Track {
    /// Its codec.
    pub codec: Codec,
    /// Samples per second.
    pub sample_rate: u32,
    /// Channels.
    pub channels: u16,
    /// Bits per sample: ALAC's; 0 for AAC, which has none.
    pub bits: u8,
    /// Its length, in `timescale` units.
    pub duration: u64,
    /// Units per second of `duration`.
    pub timescale: u32,
    /// The bit rate its description gives, in bits per second (AAC's `esds`, ALAC's cookie); 0 when
    /// none.
    pub avg_bitrate: u32,
    /// The highest bit rate its description gives (AAC's `esds`); 0 when none.
    pub max_bitrate: u32,
}

/// An MPEG-4 descriptor's length: one to four bytes of seven bits, each but the last with 0x80.
fn descriptor_len(bytes: &[u8], at: &mut usize) -> Option<usize> {
    let mut len = 0usize;
    for _ in 0..4 {
        let byte = *bytes.get(*at)?;
        *at += 1;
        len = len << 7 | usize::from(byte & 0x7f);
        if byte & 0x80 == 0 {
            return Some(len);
        }
    }
    Some(len)
}

/// AAC's sample rates by their index in its decoder configuration.
const AAC_RATES: [u32; 13] = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350,
];

/// The rate and channels of an MPEG-4 audio decoder configuration (`AudioSpecificConfig`, ISO/IEC
/// 14496-3): its object type (5 bits, or 6 more after 31), its rate (an index, or 24 bits after
/// 15), its channel configuration (4 bits: 1–6 channels, 7 for eight, 0 for "as the stream says").
pub(crate) fn audio_config(bytes: &[u8]) -> Option<(u32, u16)> {
    let bits =
        bytes.iter().take(8).fold(0u64, |all, &byte| all << 8 | u64::from(byte)) << (8 * (8 - bytes.len().min(8)));
    let mut at = 0;
    let mut take = |count: u32| {
        let value = (bits << at) >> (64 - count);
        at += count;
        value
    };
    if take(5) == 31 {
        take(6);
    }
    let rate = match take(4) {
        15 => u32::try_from(take(24)).ok()?,
        index => *AAC_RATES.get(usize::try_from(index).ok()?)?,
    };
    let channels = match take(4) {
        0 => return Some((rate, 0)),
        7 => 8,
        count => u16::try_from(count).ok()?,
    };
    Some((rate, channels))
}

/// What `esds` says of the audio.
struct DecoderConfig {
    /// Its object type (0x40: MPEG-4 audio).
    object: u8,
    /// Its highest bit rate.
    max: u32,
    /// Its average bit rate.
    avg: u32,
    /// The decoder's own rate and channels, when it gives a configuration (tag 5).
    audio: Option<(u32, u16)>,
}

/// What `esds` says: see [`DecoderConfig`].
fn decoder_config(esds: &[u8]) -> Option<DecoderConfig> {
    // Past the full box's version and flags: an ES descriptor (tag 3).
    let mut at = 4;
    if *esds.get(at)? != 3 {
        return None;
    }
    at += 1;
    descriptor_len(esds, &mut at)?;
    let flags = *esds.get(at + 2)?;
    at += 3;
    if flags & 0x80 != 0 {
        at += 2;
    }
    if flags & 0x40 != 0 {
        at += 1 + usize::from(*esds.get(at)?);
    }
    if flags & 0x20 != 0 {
        at += 2;
    }
    // The decoder configuration (tag 4).
    if *esds.get(at)? != 4 {
        return None;
    }
    at += 1;
    descriptor_len(esds, &mut at)?;
    let object = *esds.get(at)?;
    let (max, avg) = (u32_at(esds, at + 5)?, u32_at(esds, at + 9)?);
    // The decoder's own configuration (tag 5), after the 13 bytes above.
    at += 13;
    let config = (esds.get(at) == Some(&5))
        .then(|| {
            at += 1;
            let len = descriptor_len(esds, &mut at)?;
            audio_config(esds.get(at..at + len)?)
        })
        .flatten();
    Some(DecoderConfig {
        object,
        max,
        avg,
        audio: config,
    })
}

/// The audio track of `moov`'s content; `None` when it has no sound track.
pub fn audio_track(moov: &[u8]) -> Result<Option<Track>, Error> {
    for trak in children(moov)?.into_iter().filter(|child| child.kind == *b"trak") {
        let Some(mdia) = child(trak.body, b"mdia")? else {
            continue;
        };
        let handler = child(mdia.body, b"hdlr")?.and_then(|hdlr| hdlr.body.get(8..12));
        if handler != Some(b"soun") {
            continue;
        }
        let mdhd = child(mdia.body, b"mdhd")?.ok_or(Error::Missing("mdhd"))?.body;
        let (timescale, duration) = match mdhd.first() {
            Some(1) => (u32_at(mdhd, 20), u64_at(mdhd, 24)),
            _ => (u32_at(mdhd, 12), u32_at(mdhd, 16).map(u64::from)),
        };
        let (timescale, duration) = (
            timescale.ok_or(Error::Truncated("mdhd"))?,
            duration.ok_or(Error::Truncated("mdhd"))?,
        );
        let stsd = path(mdia.body, &[b"minf", b"stbl", b"stsd"])?
            .ok_or(Error::Missing("stsd"))?
            .body;
        let entry = children(stsd.get(8..).ok_or(Error::Truncated("stsd"))?)?
            .into_iter()
            .next()
            .ok_or(Error::Missing("a sample entry"))?;
        let body = entry.body;
        // The audio sample entry: 8 bytes of the sample entry, then version, revision, vendor,
        // channels, sample size, compression id, packet size, and the rate as 16.16.
        let version = u16_at(body, 8).ok_or(Error::Truncated("the sample entry"))?;
        let channels = u16_at(body, 16).ok_or(Error::Truncated("the sample entry"))?;
        let rate = u32_at(body, 24).ok_or(Error::Truncated("the sample entry"))? >> 16;
        let boxes_at = 28
            + match version {
                1 => 16,
                2 => 36,
                _ => 0,
            };
        let inner = body.get(boxes_at..).unwrap_or_default();
        let mut track = Track {
            codec: Codec::Other(entry.kind),
            sample_rate: rate,
            channels,
            bits: 0,
            duration,
            timescale,
            avg_bitrate: 0,
            max_bitrate: 0,
        };
        match &entry.kind {
            b"mp4a" => {
                if let Some(DecoderConfig {
                    object,
                    max,
                    avg,
                    audio: config,
                }) = child(inner, b"esds")
                    .ok()
                    .flatten()
                    .and_then(|esds| decoder_config(esds.body))
                {
                    // 0x40: MPEG-4 audio (AAC and its kin); 0x66–0x68: MPEG-2 AAC.
                    if matches!(object, 0x40 | 0x66..=0x68) {
                        track.codec = Codec::Aac;
                        // The decoder's configuration over the entry's, which QuickTime's writers
                        // often leave at 2 channels whatever the audio has.
                        if let Some((rate, channels)) = config {
                            track.sample_rate = rate;
                            if channels > 0 {
                                track.channels = channels;
                            }
                        }
                    }
                    track.max_bitrate = max;
                    track.avg_bitrate = avg;
                }
            }
            b"alac" => {
                track.codec = Codec::Alac;
                // The magic cookie, past the full box's version and flags: frame length (4),
                // compatible version (1), bit depth (1), pb, mb, kb (3), channels (1), max run (2),
                // max frame bytes (4), average bit rate (4), sample rate (4).
                if let Some(cookie) = child(inner, b"alac").ok().flatten().and_then(|alac| alac.body.get(4..)) {
                    track.bits = cookie.get(5).copied().unwrap_or_default();
                    if let Some(&channels) = cookie.get(9) {
                        track.channels = u16::from(channels);
                    }
                    track.avg_bitrate = u32_at(cookie, 16).unwrap_or_default();
                    if let Some(rate) = u32_at(cookie, 20).filter(|rate| *rate > 0) {
                        track.sample_rate = rate;
                    }
                }
            }
            _ => {}
        }
        return Ok(Some(track));
    }
    Ok(None)
}
