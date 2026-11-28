//! MPEG-4 audio (`.m4a`): the fields over `moov/udta/meta/ilst`'s items, the cover over `covr`.
//! Reading only, until A2 (RECORD/2026-11-28.aac-m4a.WIP.md).

use jackbird_mp4::{self as mp4, Data, Item, Kind, data_type};

use crate::{Cover, Error, Field, Fields, Format, Tags};

/// The namespace of the freeform items jackbird reads (`----:com.apple.iTunes:<name>`).
pub(crate) const MEAN: &str = "com.apple.iTunes";

/// Where a field lives: an item of its own type, or a freeform item by its name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Place {
    /// An item of this type.
    Atom(&'static Kind),
    /// `----:com.apple.iTunes:<name>`, the name compared without case.
    Freeform(&'static str),
}

/// Where each field is read from; the first place is the one a new value goes to.
pub(crate) fn places(field: Field) -> &'static [Place] {
    use Place::{Atom, Freeform};
    match field {
        Field::Title => &[Atom(b"\xa9nam")],
        Field::Artist => &[Atom(b"\xa9ART")],
        Field::Album => &[Atom(b"\xa9alb")],
        Field::Year => &[Atom(b"\xa9day")],
        Field::Genre => &[Atom(b"\xa9gen"), Atom(b"gnre")],
        Field::Track => &[Atom(b"trkn")],
        Field::Disc => &[Atom(b"disk")],
        Field::AlbumArtist => &[Atom(b"aART")],
        Field::Compilation => &[Atom(b"cpil")],
        Field::Composer => &[Atom(b"\xa9wrt")],
        Field::Comment => &[Atom(b"\xa9cmt")],
        Field::Lyrics => &[Atom(b"\xa9lyr")],
        Field::Bpm => &[Atom(b"tmpo")],
        // As Picard writes them, and jackbird's own as ID3's TXXX names them.
        Field::MbAlbumId => &[Freeform("MusicBrainz Album Id")],
        Field::MbReleaseGroupId => &[Freeform("MusicBrainz Release Group Id")],
        Field::MbAlbumArtistId => &[Freeform("MusicBrainz Album Artist Id")],
        Field::MbReleaseTrackId => &[Freeform("MusicBrainz Release Track Id")],
        Field::MbRecordingId => &[Freeform("MusicBrainz Track Id")],
        Field::DiscogsReleaseId => &[Freeform("DISCOGS_RELEASE_ID")],
        Field::JackbirdTrackId => &[Freeform("jackbird track_id")],
    }
}

/// Whether an item is at `place`.
pub(crate) fn is_at(item: &Item, place: Place) -> bool {
    match place {
        Place::Atom(kind) => item.kind == *kind,
        Place::Freeform(name) => {
            item.kind == *b"----"
                && item.mean.as_deref() == Some(MEAN)
                && item
                    .name
                    .as_deref()
                    .is_some_and(|found| found.eq_ignore_ascii_case(name))
        }
    }
}

fn unreadable(error: mp4::Error) -> Error {
    Error::Unreadable(error.to_string())
}

/// `moov`'s content, from a file or its first bytes up to where its audio starts (or the whole
/// file, when `moov` follows the audio). The boxes after `moov` need not be whole.
pub(crate) fn moov(bytes: &[u8]) -> Result<&[u8], Error> {
    let (boxes, _) = mp4::top_level(bytes, u64::MAX).map_err(unreadable)?;
    let moov = boxes
        .iter()
        .find(|placed| placed.header.kind == *b"moov")
        .ok_or_else(|| Error::Unreadable("no moov".into()))?;
    let range = moov.content();
    usize::try_from(range.start)
        .ok()
        .zip(usize::try_from(range.end).ok())
        .and_then(|(start, end)| bytes.get(start..end))
        .ok_or_else(|| Error::Unreadable("moov is cut short".into()))
}

/// A number and its total (`trkn`, `disk`: two bytes, the number, the total): `n/total`, `n` when
/// the total is 0; empty when the number is.
fn numbered(data: &Data) -> String {
    let at = |index: usize| {
        data.value
            .get(index..index + 2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .unwrap_or_default()
    };
    match (at(2), at(4)) {
        (0, _) => String::new(),
        (number, 0) => number.to_string(),
        (number, total) => format!("{number}/{total}"),
    }
}

/// A field's value from the item at its place: its text (several values joined by `/`), or what
/// the item's own form says.
fn value_of(field: Field, item: &Item) -> String {
    let Some(first) = item.data.first() else {
        return String::new();
    };
    match (field, &item.kind) {
        (Field::Track | Field::Disc, _) => numbered(first),
        (Field::Genre, b"gnre") => first
            .integer()
            .and_then(|number| usize::try_from(number).ok()?.checked_sub(1))
            .and_then(jackbird_id3::genre_name)
            .unwrap_or_default()
            .to_owned(),
        (Field::Compilation, _) => match first.integer() {
            Some(0) | None => String::new(),
            Some(_) => "1".into(),
        },
        (Field::Bpm, _) => match first.integer() {
            Some(0) | None => String::new(),
            Some(bpm) => bpm.to_string(),
        },
        _ => item
            .data
            .iter()
            .map(Data::text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("/"),
    }
}

pub(crate) fn fields_of(items: &[Item]) -> Fields {
    let mut fields = Fields::default();
    for field in Field::ALL {
        let value = places(field)
            .iter()
            .find_map(|&place| items.iter().find(|item| is_at(item, place)))
            .map(|item| value_of(field, item))
            .unwrap_or_default();
        fields.set(field, value);
    }
    fields
}

/// A cover's MIME type from its `data` type, or from its bytes when the type says none.
fn mime_of(data: &Data) -> &'static str {
    match data.kind {
        data_type::PNG => "image/png",
        data_type::BMP => "image/bmp",
        data_type::JPEG => "image/jpeg",
        _ if data.value.starts_with(b"\x89PNG") => "image/png",
        _ if data.value.starts_with(b"BM") => "image/bmp",
        _ => "image/jpeg",
    }
}

/// The cover shown: `covr`'s first picture.
pub(crate) fn cover_of(items: &[Item]) -> Option<Cover> {
    let data = items
        .iter()
        .filter(|item| item.kind == *b"covr")
        .flat_map(|item| item.data.iter())
        .find(|data| !data.value.is_empty())?;
    Some(Cover {
        data: data.value.clone(),
        mime: mime_of(data).into(),
    })
}

pub(crate) fn read(bytes: &[u8]) -> Result<Tags, Error> {
    let items = mp4::tags(moov(bytes)?).map_err(unreadable)?;
    Ok(Tags {
        format: Format::Mp4,
        fields: fields_of(&items),
        cover: cover_of(&items),
    })
}
