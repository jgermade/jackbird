//! MP3: the six fields and the cover over an ID3v2 tag's frames.

use jackbird_id3::{self as id3, Frame, Picture, Version, decode_picture, decode_text, encode_picture, encode_text};

use crate::year::{self, Timestamp};
use crate::{Cover, CoverChange, Error, Field, Fields, Format, Refusal, Tags};

/// The padding a tag gets when it no longer fits in the old one's room.
const PADDING: usize = 1024;

/// The frames the reader looks at for a field, in order of preference.
fn reader_ids(version: Version, field: Field) -> &'static [&'static str] {
    match (version, field) {
        (Version::V22, Field::Title) => &["TT2"],
        (Version::V22, Field::Artist) => &["TP1"],
        (Version::V22, Field::Album) => &["TAL"],
        (Version::V22, Field::Year) => &["TYE"],
        (Version::V22, Field::Genre) => &["TCO"],
        (Version::V22, Field::Track) => &["TRK"],
        (Version::V23, Field::Year) => &["TYER", "TDRC"],
        (Version::V24, Field::Year) => &["TDRC", "TYER"],
        (_, field) => &managed(field)[..1],
    }
}

/// The frames a change of a field replaces or removes: its own, and for the
/// year every frame of a date (an old `TDAT` would date the new year wrongly).
fn managed(field: Field) -> &'static [&'static str] {
    match field {
        Field::Title => &["TIT2"],
        Field::Artist => &["TPE1"],
        Field::Album => &["TALB"],
        Field::Year => &["TDRC", "TYER", "TDAT", "TIME"],
        Field::Genre => &["TCON"],
        Field::Track => &["TRCK"],
    }
}

fn picture_id(version: Version) -> &'static str {
    if version == Version::V22 { "PIC" } else { "APIC" }
}

/// A frame's text values joined by `/`; `None` when its content cannot be read.
fn text_of(version: Version, unsynchronised: bool, frame: &Frame) -> Option<String> {
    let content = frame.content(version, unsynchronised).ok()?;
    Some(decode_text(&content).join("/"))
}

/// The frame a field is read from (the first readable one of its ids, in
/// order of preference) and its text.
fn shown(version: Version, unsynchronised: bool, frames: &[Frame], field: Field) -> Option<(usize, String)> {
    reader_ids(version, field).iter().find_map(|id| {
        frames
            .iter()
            .enumerate()
            .filter(|(_, frame)| frame.id == *id)
            .find_map(|(index, frame)| text_of(version, unsynchronised, frame).map(|text| (index, text)))
    })
}

/// The picture shown: the first readable front cover, else the first readable picture.
fn shown_picture(version: Version, unsynchronised: bool, frames: &[Frame]) -> Option<(usize, Picture)> {
    let pictures: Vec<(usize, Picture)> = frames
        .iter()
        .enumerate()
        .filter(|(_, frame)| frame.id == picture_id(version))
        .filter_map(|(index, frame)| {
            let content = frame.content(version, unsynchronised).ok()?;
            decode_picture(&content, version).ok().map(|picture| (index, picture))
        })
        .collect();
    let front = pictures.iter().position(|(_, picture)| picture.kind == 3).unwrap_or(0);
    pictures.into_iter().nth(front)
}

fn fields_of(version: Version, unsynchronised: bool, frames: &[Frame]) -> Fields {
    let text = |field| {
        shown(version, unsynchronised, frames, field)
            .map(|(_, text)| text)
            .unwrap_or_default()
    };
    let mut year = shown(version, unsynchronised, frames, Field::Year);
    // v2.3 keeps a date's day and month apart, in TDAT (ddMM).
    if let Some((index, value)) = &mut year
        && frames[*index].id == "TYER"
        && let Some(date) = frames
            .iter()
            .filter(|frame| frame.id == "TDAT")
            .find_map(|frame| text_of(version, unsynchronised, frame))
        && date.len() == 4
        && date.is_ascii()
    {
        let full = format!("{value}-{}-{}", &date[2..4], &date[..2]);
        if year::parse(&full).is_some_and(|timestamp| timestamp.day.is_some()) {
            *value = full;
        }
    }
    Fields {
        title: text(Field::Title),
        artist: text(Field::Artist),
        album: text(Field::Album),
        year: year.map(|(_, text)| text).unwrap_or_default(),
        genre: text(Field::Genre),
        track: text(Field::Track),
    }
}

pub(crate) fn read(bytes: &[u8]) -> Tags {
    let empty = Tags {
        format: Format::Mp3,
        fields: Fields::default(),
        cover: None,
    };
    let Ok(Some(tag)) = id3::read(bytes) else {
        return empty;
    };
    let unsynchronised = tag.unsynchronised_v24();
    Tags {
        format: Format::Mp3,
        fields: fields_of(tag.version, unsynchronised, &tag.frames),
        cover: shown_picture(tag.version, unsynchronised, &tag.frames).map(|(_, picture)| Cover {
            data: picture.data,
            mime: picture.mime,
        }),
    }
}

/// A year as the tag's version can hold it, or why not.
fn year_frames(version: Version, value: &str) -> Result<Vec<(&'static str, String)>, Error> {
    let invalid = || Error::InvalidYear(value.to_owned());
    let Timestamp {
        year,
        month,
        day,
        has_time,
    } = year::parse(value).ok_or_else(invalid)?;
    if version == Version::V24 {
        return Ok(vec![("TDRC", value.to_owned())]);
    }
    // v2.3: a year (TYER), and a day and month (TDAT); no month alone, no time.
    match (month, day, has_time) {
        (None, None, false) => Ok(vec![("TYER", format!("{year:04}"))]),
        (Some(month), Some(day), false) => Ok(vec![
            ("TYER", format!("{year:04}")),
            ("TDAT", format!("{day:02}{month:02}")),
        ]),
        _ => Err(invalid()),
    }
}

pub(crate) fn write(
    bytes: &[u8],
    changes: &[(Field, String)],
    cover: Option<CoverChange<'_>>,
) -> Result<Vec<u8>, Error> {
    let source = id3::read(bytes).map_err(|error| Error::Unreadable(error.to_string()))?;
    if let Some(tag) = &source {
        if tag.version == Version::V22 {
            return Err(Error::Id3v22);
        }
        if !tag.clean {
            return Err(Error::Unreadable(
                "bytes after its frames are neither frames nor padding".into(),
            ));
        }
    }
    let version = source.as_ref().map_or(Version::V23, |tag| tag.version);
    let unsynchronised = source.as_ref().is_some_and(|tag| tag.unsynchronised_v24());
    let make = |id: &str, content: Vec<u8>| {
        let frame = Frame::new(id, content);
        if unsynchronised { frame.unsynchronised() } else { frame }
    };

    // The tag is altered: frames that ask to go with an altered tag go.
    let mut frames: Vec<Frame> = source.as_ref().map_or_else(Vec::new, |tag| tag.frames.clone());
    frames.retain(|frame| !frame.discard_on_tag_change(version));

    for (field, value) in changes {
        let family = managed(*field);
        if value.is_empty() {
            frames.retain(|frame| !family.contains(&frame.id.as_str()));
            continue;
        }
        let new: Vec<Frame> = if *field == Field::Year {
            year_frames(version, value)?
                .into_iter()
                .map(|(id, text)| make(id, encode_text(&text, version)))
                .collect()
        } else {
            vec![make(family[0], encode_text(value, version))]
        };
        let at = shown(version, unsynchronised, &frames, *field)
            .map(|(index, _)| index)
            .or_else(|| frames.iter().position(|frame| family.contains(&frame.id.as_str())));
        if *field == Field::Year {
            // The new date where the old one was read from; every other frame of a date goes.
            let mut out = Vec::with_capacity(frames.len() + 1);
            for (index, frame) in frames.into_iter().enumerate() {
                if Some(index) == at {
                    out.extend(new.iter().cloned());
                }
                if !family.contains(&frame.id.as_str()) {
                    out.push(frame);
                }
            }
            if at.is_none() {
                out.extend(new);
            }
            frames = out;
        } else {
            let frame = new.into_iter().next().expect("one frame");
            match at {
                Some(index) => frames[index] = frame,
                None => frames.push(frame),
            }
        }
    }

    match cover {
        Some(CoverChange::Set(cover)) => {
            let picture = Picture {
                mime: cover.mime.clone(),
                kind: 3,
                description: String::new(),
                data: cover.data.clone(),
            };
            let frame = make("APIC", encode_picture(&picture, version));
            match shown_picture(version, unsynchronised, &frames) {
                Some((index, _)) => frames[index] = frame,
                None => frames.push(frame),
            }
        }
        Some(CoverChange::Remove) => {
            if let Some((index, _)) = shown_picture(version, unsynchronised, &frames) {
                frames.remove(index);
            }
        }
        None => {}
    }

    let room = source.as_ref().map_or(0, |tag| tag.len);
    let used = 10 + frames.iter().map(|frame| 10 + frame.body.len()).sum::<usize>();
    let padding = if source.is_some() && used <= room {
        room - used
    } else {
        PADDING
    };
    let flags = source.as_ref().map_or(0, |tag| tag.flags);
    let tag = id3::write(version, flags, &frames, padding).map_err(|error| match error {
        id3::Error::TooLarge => Error::TooLarge,
        other => Error::Unreadable(other.to_string()),
    })?;
    let mut out = tag;
    out.extend_from_slice(&bytes[room..]);
    Ok(out)
}

/// Safeguard 3: every frame of the source that the changes do not touch is
/// in the result, byte for byte and in order. The touched ones: the frames of
/// a changed field (its family, for the year), the picture a new cover
/// replaces or removes, and those that ask to go with an altered tag.
pub(crate) fn check_kept(
    source: &[u8],
    out: &[u8],
    changes: &[(Field, String)],
    cover: Option<CoverChange<'_>>,
) -> Result<(), Error> {
    let kept = |what: String| Error::Refused(Refusal::Kept(what));
    let Ok(Some(before)) = id3::read(source) else {
        return Ok(());
    };
    let after = match id3::read(out) {
        Ok(Some(tag)) if tag.clean => tag,
        _ => return Err(kept("the tag".into())),
    };
    let version = before.version;
    let changed: Vec<&str> = changes
        .iter()
        .flat_map(|(field, _)| managed(*field).iter().copied())
        .collect();
    let others = |frames: &[Frame], discard: bool| -> Vec<Frame> {
        frames
            .iter()
            .filter(|frame| frame.id != "APIC" && !changed.contains(&frame.id.as_str()))
            .filter(|frame| !(discard && frame.discard_on_tag_change(version)))
            .cloned()
            .collect()
    };
    let (expected, found) = (others(&before.frames, true), others(&after.frames, false));
    if expected != found {
        let at = expected
            .iter()
            .zip(&found)
            .position(|(a, b)| a != b)
            .unwrap_or(expected.len().min(found.len()));
        let id = expected
            .get(at)
            .or(found.get(at))
            .map_or_else(|| "a frame".to_owned(), |frame| format!("the {} frame", frame.id));
        return Err(kept(id));
    }

    let pictures = |frames: &[Frame], discard: bool| -> Vec<Frame> {
        frames
            .iter()
            .filter(|frame| frame.id == "APIC" && !(discard && frame.discard_on_tag_change(version)))
            .cloned()
            .collect()
    };
    let mut expected = pictures(&before.frames, true);
    let mut found = pictures(&after.frames, false);
    if let Some(cover) = cover {
        let unsynchronised = before.unsynchronised_v24();
        if let Some((index, _)) = shown_picture(version, unsynchronised, &before.frames) {
            let replaced = &before.frames[index];
            if let Some(at) = expected.iter().position(|frame| frame == replaced) {
                expected.remove(at);
            }
        }
        if let CoverChange::Set(cover) = cover {
            let is_new = |frame: &Frame| {
                frame
                    .content(version, after.unsynchronised_v24())
                    .ok()
                    .and_then(|content| decode_picture(&content, version).ok())
                    .is_some_and(|picture| {
                        picture.kind == 3 && picture.data == cover.data && picture.mime == cover.mime
                    })
            };
            if let Some(at) = found.iter().position(is_new) {
                found.remove(at);
            }
        }
    }
    if expected != found {
        return Err(kept("a picture".into()));
    }
    Ok(())
}
