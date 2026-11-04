//! E0 spike: lofty over bytes, as jackbird would use it. Two ways to write:
//! lofty's generic `Tag` (format-agnostic) and its concrete tags (`Id3v2Tag`,
//! `VorbisComments`). `wasm` exposes both to JavaScript.

use std::io::{Cursor, Seek};

use lofty::config::{ParseOptions, WriteOptions};
use lofty::file::{AudioFile, FileType, TaggedFileExt};
use lofty::flac::FlacFile;
use lofty::id3::v2::{Frame, FrameId, Id3v2Tag, Id3v2Version, TextInformationFrame};
use lofty::mpeg::MpegFile;
use lofty::ogg::OggPictureStorage;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, Tag};
use lofty::TextEncoding;

#[cfg(feature = "bindings")]
pub mod wasm;

/// The six fields jackbird edits, as strings, as `EditableMetadata` holds them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Fields {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub year: String,
    pub genre: String,
    pub track: String,
}

#[derive(Clone, Debug)]
pub struct Cover {
    pub data: Vec<u8>,
    pub mime: String,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn parse_options() -> ParseOptions {
    // jackbird needs no duration or bitrate from the engine: skip the audio properties.
    ParseOptions::new().read_properties(false)
}

/// The ID3v2 version of a tag at the start of `bytes`, if any.
fn id3_version(bytes: &[u8]) -> Option<u8> {
    (bytes.len() >= 10 && &bytes[..3] == b"ID3").then(|| bytes[3])
}

fn write_options(v23: bool) -> WriteOptions {
    WriteOptions::new().use_id3v23(v23)
}

fn front_cover(pictures: &[Picture]) -> Option<Cover> {
    let picture = pictures
        .iter()
        .find(|p| p.pic_type() == PictureType::CoverFront)
        .or_else(|| pictures.first())?;
    Some(Cover {
        data: picture.data().to_vec(),
        mime: picture.mime_type().map(|m| m.as_str().to_owned()).unwrap_or_default(),
    })
}

fn picture_of(cover: &Cover) -> Picture {
    Picture::unchecked(cover.data.clone())
        .pic_type(PictureType::CoverFront)
        .mime_type(MimeType::from_str(&cover.mime))
        .description("Cover")
        .build()
}

/// Reads the six fields and the front cover (or the first picture) of a file's bytes.
pub fn read(bytes: &[u8]) -> Result<(Fields, Option<Cover>), String> {
    let tagged = Probe::new(Cursor::new(bytes))
        .options(parse_options())
        .guess_file_type()
        .map_err(err)?
        .read()
        .map_err(err)?;
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok((Fields::default(), None));
    };
    let text = |key: ItemKey| tag.get_string(key).unwrap_or_default().to_owned();
    let mut track = text(ItemKey::TrackNumber);
    let total = text(ItemKey::TrackTotal);
    if !total.is_empty() {
        track = format!("{track}/{total}");
    }
    let fields = Fields {
        title: text(ItemKey::TrackTitle),
        artist: text(ItemKey::TrackArtist),
        album: text(ItemKey::AlbumTitle),
        year: {
            let date = text(ItemKey::RecordingDate);
            if date.is_empty() { text(ItemKey::Year) } else { date }
        },
        genre: text(ItemKey::Genre),
        track,
    };
    Ok((fields, front_cover(tag.pictures())))
}

/// Writes through lofty's generic `Tag`: the way its documentation leads.
pub fn write_generic(bytes: Vec<u8>, fields: &Fields, cover: Option<&Cover>) -> Result<Vec<u8>, String> {
    let v23 = id3_version(&bytes) == Some(3);
    let mut cursor = Cursor::new(bytes);
    let mut tagged = Probe::new(&mut cursor)
        .options(parse_options())
        .guess_file_type()
        .map_err(err)?
        .read()
        .map_err(err)?;
    if tagged.primary_tag().is_none() {
        let kind = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(kind));
    }
    let tag = tagged.primary_tag_mut().ok_or("no tag")?;
    tag.insert_text(ItemKey::TrackTitle, fields.title.clone());
    tag.insert_text(ItemKey::TrackArtist, fields.artist.clone());
    tag.insert_text(ItemKey::AlbumTitle, fields.album.clone());
    if !fields.year.is_empty() {
        tag.insert_text(ItemKey::RecordingDate, fields.year.clone());
    }
    if !fields.genre.is_empty() {
        tag.insert_text(ItemKey::Genre, fields.genre.clone());
    }
    if !fields.track.is_empty() {
        let (number, total) = fields.track.split_once('/').unwrap_or((&fields.track, ""));
        tag.insert_text(ItemKey::TrackNumber, number.to_owned());
        if !total.is_empty() {
            tag.insert_text(ItemKey::TrackTotal, total.to_owned());
        }
    }
    if let Some(cover) = cover {
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(picture_of(cover));
    }
    cursor.rewind().map_err(err)?;
    tag.save_to(&mut cursor, write_options(v23)).map_err(err)?;
    Ok(cursor.into_inner())
}

/// Writes through the concrete tag of the format: `Id3v2Tag` for MP3, `VorbisComments` for FLAC.
pub fn write_concrete(bytes: Vec<u8>, fields: &Fields, cover: Option<&Cover>) -> Result<Vec<u8>, String> {
    let mut cursor = Cursor::new(bytes);
    let kind = Probe::new(&mut cursor)
        .guess_file_type()
        .map_err(err)?
        .file_type()
        .ok_or("unknown format")?;
    cursor.rewind().map_err(err)?;
    match kind {
        FileType::Mpeg => {
            let mut file = MpegFile::read_from(&mut cursor, parse_options()).map_err(err)?;
            let mut tag = file.id3v2().cloned().unwrap_or_else(Id3v2Tag::new);
            let v23 = file.id3v2().is_some_and(|t| t.original_version() == Id3v2Version::V3);
            tag.set_title(fields.title.clone());
            tag.set_artist(fields.artist.clone());
            tag.set_album(fields.album.clone());
            if !fields.year.is_empty() {
                tag.set_date(fields.year.parse().map_err(err)?);
            }
            if !fields.genre.is_empty() {
                tag.set_genre(fields.genre.clone());
            }
            if !fields.track.is_empty() {
                let frame = TextInformationFrame::new(FrameId::Valid("TRCK".into()), TextEncoding::UTF8, fields.track.clone());
                tag.insert(Frame::Text(frame));
            }
            if let Some(cover) = cover {
                tag.remove_picture_type(PictureType::CoverFront);
                tag.insert_picture(picture_of(cover));
            }
            cursor.rewind().map_err(err)?;
            tag.save_to(&mut cursor, write_options(v23)).map_err(err)?;
            file.set_id3v2(tag);
        }
        FileType::Flac => {
            let mut file = FlacFile::read_from(&mut cursor, parse_options()).map_err(err)?;
            let mut comments = file.vorbis_comments().cloned().unwrap_or_default();
            let mut set = |key: &str, value: &str| {
                if !value.is_empty() {
                    comments.insert(key.to_owned(), value.to_owned());
                }
            };
            set("TITLE", &fields.title);
            set("ARTIST", &fields.artist);
            set("ALBUM", &fields.album);
            set("DATE", &fields.year);
            set("GENRE", &fields.genre);
            set("TRACKNUMBER", &fields.track);
            file.set_vorbis_comments(comments);
            if let Some(cover) = cover {
                file.remove_picture_type(PictureType::CoverFront);
                file.insert_picture(picture_of(cover), None).map_err(err)?;
            }
            cursor.rewind().map_err(err)?;
            file.save_to(&mut cursor, write_options(false)).map_err(err)?;
        }
        other => return Err(format!("{other:?} is not handled by the spike")),
    }
    Ok(cursor.into_inner())
}

// ------------------------------------------------------------------ merged
//
// lofty's concrete tags plus what jackbird needs on top: only the fields that
// changed are touched, and in place; the tag keeps its size when it fits (so
// the audio does not move); v2.4 tags written with plain frame sizes are
// normalised before lofty reads them; FLAC's padding is reused; a FLAC with
// an ID3v2 tag in front is written; and the result is refused unless the
// audio bytes are identical (E-D3).

use lofty::config::ParsingMode;
use lofty::id3::v2::{AttachedPictureFrame, TimestampFrame};
use lofty::ogg::tag::VorbisComments;
use lofty::picture::PictureInformation;

fn syncsafe_at(b: &[u8], at: usize) -> usize {
    ((b[at] as usize & 0x7f) << 21) | ((b[at + 1] as usize & 0x7f) << 14) | ((b[at + 2] as usize & 0x7f) << 7) | (b[at + 3] as usize & 0x7f)
}

fn plain_at(b: &[u8], at: usize) -> usize {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) as usize
}

/// The total length of an ID3v2 tag at the start of `bytes` (header, body, footer).
pub fn id3_len(bytes: &[u8]) -> Option<usize> {
    id3_version(bytes)?;
    Some(10 + syncsafe_at(bytes, 6) + if bytes[3] == 4 && bytes[5] & 0x10 != 0 { 10 } else { 0 })
}

/// Whether frames from `start` read with `size` end cleanly: at the end, or in zeros.
fn frames_end_cleanly(body: &[u8], size: fn(&[u8], usize) -> usize) -> bool {
    let mut at = 0;
    while at + 10 <= body.len() && body[at..at + 4].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) {
        let n = size(body, at + 4);
        if at + 10 + n > body.len() {
            return false;
        }
        at += 10 + n;
    }
    body[at..].iter().all(|&b| b == 0)
}

/// A v2.4 tag whose frame sizes only read as plain integers (old iTunes), with
/// its sizes rewritten as syncsafe; `None` when the tag needs no change.
pub fn normalise_v24_sizes(bytes: &[u8]) -> Option<Vec<u8>> {
    if id3_version(bytes) != Some(4) || bytes[5] & 0x40 != 0 {
        return None;
    }
    let size = syncsafe_at(bytes, 6);
    let body = &bytes[10..10 + size];
    if frames_end_cleanly(body, syncsafe_at) || !frames_end_cleanly(body, plain_at) {
        return None;
    }
    let mut out = bytes.to_vec();
    let mut at = 0;
    while at + 10 <= body.len() && body[at..at + 4].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) {
        let n = plain_at(body, at + 4);
        let s = [((n >> 21) & 0x7f) as u8, ((n >> 14) & 0x7f) as u8, ((n >> 7) & 0x7f) as u8, (n & 0x7f) as u8];
        out[10 + at + 4..10 + at + 8].copy_from_slice(&s);
        at += 10 + n;
    }
    Some(out)
}

/// MP3 audio: after the ID3v2 tag, before an ID3v1 tag and an APEv2 footer.
pub fn mp3_audio(bytes: &[u8]) -> &[u8] {
    let start = id3_len(bytes).unwrap_or(0).min(bytes.len());
    let mut end = bytes.len();
    if end - start > 128 && &bytes[end - 128..end - 125] == b"TAG" {
        end -= 128;
    }
    if end - start > 32 && &bytes[end - 32..end - 24] == b"APETAGEX" {
        end -= 32;
    }
    &bytes[start..end]
}

/// FLAC: the metadata blocks (type, body) and where the audio starts.
pub fn flac_layout(bytes: &[u8]) -> Option<(usize, Vec<(u8, Vec<u8>)>, usize)> {
    let start = id3_len(bytes).unwrap_or(0);
    if bytes.get(start..start + 4)? != b"fLaC" {
        return None;
    }
    let mut at = start + 4;
    let mut blocks = Vec::new();
    loop {
        let header = *bytes.get(at)?;
        let n = ((*bytes.get(at + 1)? as usize) << 16) | ((bytes[at + 2] as usize) << 8) | bytes[at + 3] as usize;
        blocks.push((header & 0x7f, bytes.get(at + 4..at + 4 + n)?.to_vec()));
        at += 4 + n;
        if header & 0x80 != 0 {
            return Some((start, blocks, at));
        }
    }
}

/// lofty keeps a FLAC's PADDING where it was and writes the comments and
/// pictures after it, so the audio moves on every save (lofty issue #445).
/// This puts the padding last, sized so the audio starts where it did, when
/// the new metadata fits; otherwise lofty's result stands.
fn reuse_flac_padding(source: &[u8], written: Vec<u8>) -> Vec<u8> {
    let (Some((_, _, old_audio)), Some((start, blocks, new_audio))) = (flac_layout(source), flac_layout(&written)) else {
        return written;
    };
    let others: Vec<&(u8, Vec<u8>)> = blocks.iter().filter(|(kind, _)| *kind != 1).collect();
    let used = start + 4 + others.iter().map(|(_, b)| 4 + b.len()).sum::<usize>();
    if used + 4 > old_audio || old_audio - used - 4 > 0xff_ffff {
        return written;
    }
    let mut out = written[..start + 4].to_vec();
    for (kind, body) in &others {
        out.push(*kind);
        out.extend([(body.len() >> 16) as u8, (body.len() >> 8) as u8, body.len() as u8]);
        out.extend(body);
    }
    let pad = old_audio - used - 4;
    out.push(0x80 | 1);
    out.extend([(pad >> 16) as u8, (pad >> 8) as u8, pad as u8]);
    out.extend(std::iter::repeat_n(0u8, pad));
    out.extend(&written[new_audio..]);
    out
}

/// Replaces the first frame with `id` in place, or adds the frame at the end.
fn replace_frame(tag: &mut Id3v2Tag, id: &str, frame: Frame<'static>) {
    let mut frame = Some(frame);
    tag.retain_mut(|f| {
        if f.id_str() == id {
            if let Some(new) = frame.take() {
                *f = new;
            }
        }
        true
    });
    if let Some(new) = frame {
        tag.insert(new);
    }
}

fn mp3_merged(bytes: Vec<u8>, fields: &Fields, cover: Option<&Cover>) -> Result<Vec<u8>, String> {
    let bytes = normalise_v24_sizes(&bytes).unwrap_or(bytes);
    let old_len = id3_len(&bytes);
    let mut cursor = Cursor::new(bytes);
    let file = MpegFile::read_from(&mut cursor, parse_options()).map_err(err)?;
    let mut tag = file.id3v2().cloned().unwrap_or_else(Id3v2Tag::new);
    let v23 = old_len.is_some() && tag.original_version() == Id3v2Version::V3;
    let text = |id: &'static str, value: &str| {
        Frame::Text(TextInformationFrame::new(FrameId::Valid(id.into()), TextEncoding::UTF8, value.to_owned()))
    };
    let current = |tag: &Id3v2Tag, id: &'static str| tag.get_text(&FrameId::Valid(id.into())).unwrap_or_default().to_owned();
    for (id, value) in [("TIT2", &fields.title), ("TPE1", &fields.artist), ("TALB", &fields.album), ("TCON", &fields.genre), ("TRCK", &fields.track)] {
        if current(&tag, id) != *value {
            replace_frame(&mut tag, id, text(id, value));
        }
    }
    let year_now = tag.date().map(|d| d.to_string()).unwrap_or_default();
    if !fields.year.is_empty() && year_now != fields.year {
        let ts = fields.year.parse().map_err(|_| format!("the year {:?} is not a date ID3v2 can hold", fields.year))?;
        replace_frame(&mut tag, "TDRC", Frame::Timestamp(TimestampFrame::new(FrameId::Valid("TDRC".into()), TextEncoding::UTF8, ts)));
    }
    if let Some(cover) = cover {
        let picture = Frame::Picture(AttachedPictureFrame::new(TextEncoding::Latin1, picture_of(cover)));
        let mut picture = Some(picture);
        tag.retain_mut(|f| {
            if matches!(f, Frame::Picture(p) if p.picture.pic_type() == PictureType::CoverFront) {
                if let Some(new) = picture.take() {
                    *f = new;
                }
            }
            true
        });
        if let Some(new) = picture {
            tag.insert(new);
        }
    }
    let mut options = write_options(v23);
    if let Some(old_len) = old_len {
        let mut probe = Vec::new();
        tag.dump_to(&mut probe, options.preferred_padding(0)).map_err(err)?;
        if probe.len() <= old_len {
            options = options.preferred_padding((old_len - probe.len()) as u32);
        }
    }
    cursor.rewind().map_err(err)?;
    tag.save_to(&mut cursor, options).map_err(err)?;
    Ok(cursor.into_inner())
}

fn flac_merged(bytes: Vec<u8>, fields: &Fields, cover: Option<&Cover>) -> Result<Vec<u8>, String> {
    let source = bytes.clone();
    let mut cursor = Cursor::new(bytes);
    let mut file = FlacFile::read_from(&mut cursor, parse_options()).map_err(err)?;
    // lofty can only remove an ID3v2 tag from a FLAC file; not writing it leaves it as it is.
    file.remove_id3v2();
    let old = file.vorbis_comments().cloned().unwrap_or_default();
    let wanted = [("TITLE", &fields.title), ("ARTIST", &fields.artist), ("ALBUM", &fields.album), ("DATE", &fields.year), ("GENRE", &fields.genre), ("TRACKNUMBER", &fields.track)];
    let mut comments = VorbisComments::new();
    comments.set_vendor(old.vendor().to_owned());
    let mut done = Vec::new();
    for (key, value) in old.items() {
        let edit = wanted.iter().find(|(k, _)| k.eq_ignore_ascii_case(key));
        match edit {
            // The first value of an edited key changes in place; the others stay.
            Some((k, new)) if !done.contains(k) => {
                done.push(*k);
                if !new.is_empty() {
                    comments.push(key.to_owned(), new.to_string());
                }
            }
            _ => comments.push(key.to_owned(), value.to_owned()),
        }
    }
    for (k, new) in wanted {
        if !done.contains(&k) && !new.is_empty() {
            comments.push(k.to_owned(), new.clone());
        }
    }
    file.set_vorbis_comments(comments);
    if let Some(cover) = cover {
        let picture = picture_of(cover);
        let info = PictureInformation::from_picture(&picture).unwrap_or_default();
        let index = file.pictures().iter().position(|(p, _)| p.pic_type() == PictureType::CoverFront).unwrap_or(usize::MAX);
        file.set_picture(index, picture, info);
    }
    cursor.rewind().map_err(err)?;
    file.save_to(&mut cursor, write_options(false)).map_err(err)?;
    Ok(reuse_flac_padding(&source, cursor.into_inner()))
}

/// The merged writer, then E-D3's check: the result must parse, and its audio
/// bytes must be the source's, or nothing is written.
pub fn write_merged(bytes: Vec<u8>, fields: &Fields, cover: Option<&Cover>) -> Result<Vec<u8>, String> {
    let source = bytes.clone();
    let kind = Probe::new(Cursor::new(&bytes)).guess_file_type().map_err(err)?.file_type();
    let out = match kind {
        Some(FileType::Mpeg) => mp3_merged(bytes, fields, cover)?,
        Some(FileType::Flac) => flac_merged(bytes, fields, cover)?,
        other => return Err(format!("{other:?} is not handled by the spike")),
    };
    let same_audio = match kind {
        Some(FileType::Flac) => match (flac_layout(&source), flac_layout(&out)) {
            (Some((_, _, a)), Some((_, _, b))) => source[a..] == out[b..],
            _ => false,
        },
        _ => mp3_audio(&source) == mp3_audio(&out),
    };
    if !same_audio {
        return Err("refused: the audio bytes would change".into());
    }
    let strict = parse_options().parsing_mode(ParsingMode::Strict);
    Probe::new(Cursor::new(&out)).options(strict).guess_file_type().map_err(err)?.read().map_err(|e| format!("refused: the result does not parse: {e}"))?;
    Ok(out)
}

// ------------------------------------------------------------------ slim
//
// The same read and merged write without lofty's `Probe` (which reaches every
// format lofty knows): the format comes from the first bytes, so the linker
// can leave out MP4, APE, WavPack, Ogg, AIFF, WAV, Musepack and AAC.

#[derive(Clone, Copy, PartialEq)]
pub enum Kind { Mp3, Flac }

pub fn kind_of(bytes: &[u8]) -> Option<Kind> {
    let start = id3_len(bytes).unwrap_or(0);
    let head = bytes.get(start..start + 4)?;
    if head == b"fLaC" {
        Some(Kind::Flac)
    } else if head[0] == 0xff && head[1] & 0xe0 == 0xe0 {
        Some(Kind::Mp3)
    } else {
        None
    }
}

/// `read` over the concrete files.
pub fn read_slim(bytes: &[u8]) -> Result<(Fields, Option<Cover>), String> {
    let mut cursor = Cursor::new(bytes);
    let tag: Option<Tag> = match kind_of(bytes).ok_or("not an MP3 or FLAC file")? {
        Kind::Mp3 => MpegFile::read_from(&mut cursor, parse_options()).map_err(err)?.id3v2().cloned().map(Into::into),
        Kind::Flac => {
            let file = FlacFile::read_from(&mut cursor, parse_options()).map_err(err)?;
            let pictures: Vec<Picture> = file.pictures().iter().map(|(p, _)| p.clone()).collect();
            file.vorbis_comments().cloned().map(|c| {
                let mut tag: Tag = c.into();
                for p in pictures {
                    tag.push_picture(p);
                }
                tag
            })
        }
    };
    let Some(tag) = tag else { return Ok((Fields::default(), None)) };
    let text = |key: ItemKey| tag.get_string(key).unwrap_or_default().to_owned();
    let mut track = text(ItemKey::TrackNumber);
    let total = text(ItemKey::TrackTotal);
    if !total.is_empty() {
        track = format!("{track}/{total}");
    }
    let date = text(ItemKey::RecordingDate);
    let fields = Fields {
        title: text(ItemKey::TrackTitle),
        artist: text(ItemKey::TrackArtist),
        album: text(ItemKey::AlbumTitle),
        year: if date.is_empty() { text(ItemKey::Year) } else { date },
        genre: text(ItemKey::Genre),
        track,
    };
    Ok((fields, front_cover(tag.pictures())))
}

/// `write_merged` without `Probe`.
pub fn write_merged_slim(bytes: Vec<u8>, fields: &Fields, cover: Option<&Cover>) -> Result<Vec<u8>, String> {
    let source = bytes.clone();
    let kind = kind_of(&bytes).ok_or("not an MP3 or FLAC file")?;
    let out = match kind {
        Kind::Mp3 => mp3_merged(bytes, fields, cover)?,
        Kind::Flac => flac_merged(bytes, fields, cover)?,
    };
    let same_audio = match kind {
        Kind::Flac => matches!((flac_layout(&source), flac_layout(&out)), (Some((_, _, a)), Some((_, _, b))) if source[a..] == out[b..]),
        Kind::Mp3 => mp3_audio(&source) == mp3_audio(&out),
    };
    if !same_audio {
        return Err("refused: the audio bytes would change".into());
    }
    let strict = parse_options().parsing_mode(ParsingMode::Strict);
    let mut cursor = Cursor::new(&out);
    match kind {
        Kind::Mp3 => MpegFile::read_from(&mut cursor, strict).map(|_| ()),
        Kind::Flac => FlacFile::read_from(&mut cursor, strict).map(|_| ()),
    }
    .map_err(|e| format!("refused: the result does not parse: {e}"))?;
    Ok(out)
}
