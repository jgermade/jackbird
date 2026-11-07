//! jackbird's tag engine: the six fields it edits (title, artist, album,
//! year, genre, track) and the cover, over MP3 (ID3v2) and FLAC (Vorbis
//! comments), the audio region its checksums hash, and writes that keep
//! everything they do not edit.
//!
//! Every write is checked before its bytes are given back, or refused:
//!
//! 1. the result is read again, and gives the fields and cover asked for;
//! 2. its audio region (and whatever follows it: ID3v1, APEv2) is
//!    byte-identical to the source's;
//! 3. every frame (ID3v2), block and comment entry (FLAC) of the source that
//!    the edit does not touch is in the result, byte for byte, in order.
//!
//! No I/O, no dependencies but jackbird's own `jackbird-id3` and
//! `jackbird-flac`. See `RECORD/2026-08-11.musikmatch-rust-migration.WIP.md`
//! (21:45 to 22:20).

mod flac;
mod mp3;
mod region;
mod year;

use std::fmt;

pub use region::{audio_region, format_of};

/// The formats the engine reads and writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    /// MPEG audio with ID3v2 tags.
    Mp3,
    /// FLAC with Vorbis comments.
    Flac,
}

/// One of the six fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    /// The track's title.
    Title,
    /// The track's artist.
    Artist,
    /// The album.
    Album,
    /// The year, or a date.
    Year,
    /// The genre.
    Genre,
    /// The track number, `n` or `n/total`.
    Track,
}

impl Field {
    /// The six, in the order the editor shows them.
    pub const ALL: [Field; 6] = [
        Field::Title,
        Field::Artist,
        Field::Album,
        Field::Year,
        Field::Genre,
        Field::Track,
    ];
}

/// The six fields as text, as jackbird's `TrackMetadata` holds them. An
/// empty string is a field the file does not have.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Fields {
    /// The track's title.
    pub title: String,
    /// The track's artist (several values joined by `/`).
    pub artist: String,
    /// The album.
    pub album: String,
    /// The year, or a date, as the file holds it.
    pub year: String,
    /// The genre, as the file holds it (`(17)` included).
    pub genre: String,
    /// The track number, `n` or `n/total`.
    pub track: String,
}

impl Fields {
    /// One field's value.
    pub fn get(&self, field: Field) -> &str {
        match field {
            Field::Title => &self.title,
            Field::Artist => &self.artist,
            Field::Album => &self.album,
            Field::Year => &self.year,
            Field::Genre => &self.genre,
            Field::Track => &self.track,
        }
    }

    fn set(&mut self, field: Field, value: String) {
        match field {
            Field::Title => self.title = value,
            Field::Artist => self.artist = value,
            Field::Album => self.album = value,
            Field::Year => self.year = value,
            Field::Genre => self.genre = value,
            Field::Track => self.track = value,
        }
    }
}

/// A cover: the image's bytes and its MIME type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cover {
    /// The image's bytes.
    pub data: Vec<u8>,
    /// Its MIME type (`image/jpeg`).
    pub mime: String,
}

/// What a file's tags say.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tags {
    /// The file's format.
    pub format: Format,
    /// The six fields.
    pub fields: Fields,
    /// The cover shown: the front cover, else the first picture.
    pub cover: Option<Cover>,
}

/// What a write does to the cover.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum CoverEdit {
    /// Leaves the pictures as they are.
    #[default]
    Keep,
    /// Replaces the picture shown (in place) with this front cover, or adds it.
    /// The cover already shown leaves the pictures as they are.
    Set(Cover),
    /// Removes the picture shown; every other picture stays. Nothing to remove
    /// leaves the pictures as they are.
    Remove,
}

/// What a write changes: `None` leaves a field as it is, an empty string
/// removes it; a field given its current value is left alone too. The cover
/// changes as its [`CoverEdit`] says.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Edit {
    /// The new title.
    pub title: Option<String>,
    /// The new artist.
    pub artist: Option<String>,
    /// The new album.
    pub album: Option<String>,
    /// The new year: `yyyy`, `yyyy-MM` or `yyyy-MM-dd` (and v2.4's times) for MP3; any text for FLAC.
    pub year: Option<String>,
    /// The new genre.
    pub genre: Option<String>,
    /// The new track number.
    pub track: Option<String>,
    /// What happens to the cover.
    pub cover: CoverEdit,
}

impl Edit {
    /// An edit setting every field to `fields` (those equal to the file's are left alone).
    pub fn all(fields: &Fields) -> Self {
        Edit {
            title: Some(fields.title.clone()),
            artist: Some(fields.artist.clone()),
            album: Some(fields.album.clone()),
            year: Some(fields.year.clone()),
            genre: Some(fields.genre.clone()),
            track: Some(fields.track.clone()),
            cover: CoverEdit::Keep,
        }
    }

    /// One field's new value, if the edit sets it.
    pub fn get(&self, field: Field) -> Option<&str> {
        match field {
            Field::Title => self.title.as_deref(),
            Field::Artist => self.artist.as_deref(),
            Field::Album => self.album.as_deref(),
            Field::Year => self.year.as_deref(),
            Field::Genre => self.genre.as_deref(),
            Field::Track => self.track.as_deref(),
        }
    }
}

/// Which of the safeguards a write failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Reading the result does not give the fields or the cover asked for.
    Fields(String),
    /// The audio region, or what follows it, would change.
    Audio,
    /// Something the edit does not touch would be lost or changed.
    Kept(String),
}

/// Why a file could not be read or written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// Neither MP3 nor FLAC.
    NotSupported,
    /// Its tag or metadata cannot be read cleanly, so a write could lose what
    /// it could not read.
    Unreadable(String),
    /// A year that is not a date the file's tag can hold.
    InvalidYear(String),
    /// An ID3v2.2 tag: read, but not written.
    Id3v22,
    /// The tag or a block would be larger than the format allows.
    TooLarge,
    /// A safeguard failed: nothing is written.
    Refused(Refusal),
}

impl Error {
    /// A stable code for the error, for the interface's translations.
    pub fn code(&self) -> &'static str {
        match self {
            Error::NotSupported => "not-supported",
            Error::Unreadable(_) => "unreadable",
            Error::InvalidYear(_) => "invalid-year",
            Error::Id3v22 => "id3v22",
            Error::TooLarge => "too-large",
            Error::Refused(Refusal::Fields(_)) => "refused-fields",
            Error::Refused(Refusal::Audio) => "refused-audio",
            Error::Refused(Refusal::Kept(_)) => "refused-kept",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotSupported => write!(f, "not an MP3 or FLAC file"),
            Error::Unreadable(why) => write!(f, "its tags cannot be read cleanly: {why}"),
            Error::InvalidYear(year) => write!(f, "the year {year:?} is not a date this file's tag can hold"),
            Error::Id3v22 => write!(f, "ID3v2.2 tags are read but not written"),
            Error::TooLarge => write!(f, "the tags would be larger than the format allows"),
            Error::Refused(Refusal::Fields(why)) => {
                write!(f, "refused: the result would not read back as asked ({why})")
            }
            Error::Refused(Refusal::Audio) => write!(f, "refused: the audio would change"),
            Error::Refused(Refusal::Kept(what)) => write!(f, "refused: {what} would be lost or changed"),
        }
    }
}

impl std::error::Error for Error {}

/// Reads a file's fields and cover. Lenient: what cannot be read reads as
/// empty, so an MP3 with a broken tag reads as untagged.
pub fn read(bytes: &[u8]) -> Result<Tags, Error> {
    match format_of(bytes).ok_or(Error::NotSupported)? {
        Format::Mp3 => Ok(mp3::read(bytes)),
        Format::Flac => flac::read(bytes),
    }
}

/// Writes `edit` into a file's bytes and gives the new file, checked by the
/// three safeguards. An edit that changes nothing gives the same bytes.
pub fn write(bytes: &[u8], edit: &Edit) -> Result<Vec<u8>, Error> {
    let format = format_of(bytes).ok_or(Error::NotSupported)?;
    let current = read(bytes)?;
    let mut wanted = current.fields.clone();
    let mut changes = Vec::new();
    for field in Field::ALL {
        if let Some(value) = edit.get(field).filter(|value| *value != current.fields.get(field)) {
            changes.push((field, value.to_owned()));
            wanted.set(field, value.to_owned());
        }
    }
    let cover = match &edit.cover {
        CoverEdit::Keep => None,
        CoverEdit::Set(cover) => (current.cover.as_ref() != Some(cover)).then_some(CoverChange::Set(cover)),
        CoverEdit::Remove => current.cover.is_some().then_some(CoverChange::Remove),
    };
    if changes.is_empty() && cover.is_none() {
        return Ok(bytes.to_vec());
    }
    let out = match format {
        Format::Mp3 => mp3::write(bytes, &changes, cover)?,
        Format::Flac => flac::write(bytes, &changes, cover)?,
    };
    let change = Change {
        changes: &changes,
        cover,
        fields: &wanted,
        shown_cover: match cover {
            Some(CoverChange::Set(cover)) => Some(cover),
            _ => current.cover.as_ref(),
        },
    };
    verify(format, bytes, &out, &change)?;
    Ok(out)
}

/// A change of the cover that a write makes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CoverChange<'a> {
    /// The picture shown replaced with this front cover, or this one added.
    Set(&'a Cover),
    /// The picture shown removed.
    Remove,
}

/// What a write was asked to do, as the safeguards check it.
pub(crate) struct Change<'a> {
    /// The fields that change, and their new values.
    pub changes: &'a [(Field, String)],
    /// The change of the cover, if it changes.
    pub cover: Option<CoverChange<'a>>,
    /// Every field as the result must read.
    pub fields: &'a Fields,
    /// The cover the result must show. Not checked when the cover is
    /// removed: safeguard 3 checks that every other picture stays, so the one
    /// shown next is the source's.
    pub shown_cover: Option<&'a Cover>,
}

/// The three safeguards, on a write's result.
pub(crate) fn verify(format: Format, source: &[u8], out: &[u8], change: &Change<'_>) -> Result<(), Error> {
    // 1. Read back as asked.
    let back = read(out).map_err(|error| Error::Refused(Refusal::Fields(error.to_string())))?;
    if back.fields != *change.fields {
        return Err(Error::Refused(Refusal::Fields(format!(
            "{:?} instead of {:?}",
            back.fields, change.fields
        ))));
    }
    if change.cover != Some(CoverChange::Remove) && back.cover.as_ref() != change.shown_cover {
        return Err(Error::Refused(Refusal::Fields("the cover".into())));
    }
    // 2. The audio, and what follows it, unchanged.
    let (before, after) = (audio_region(source), audio_region(out));
    if source[before.start..] != out[after.start..] || before.len() != after.len() {
        return Err(Error::Refused(Refusal::Audio));
    }
    // 3. Everything untouched kept: checked by each format, on the result.
    match format {
        Format::Mp3 => mp3::check_kept(source, out, change.changes, change.cover),
        Format::Flac => flac::check_kept(source, out, change.changes, change.cover),
    }
}

#[cfg(test)]
mod tests;
