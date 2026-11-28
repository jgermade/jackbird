//! MPEG-4 audio (`.m4a`): the fields over `moov/udta/meta/ilst`'s items, the cover over `covr`.
//! A save rebuilds `moov` alone: its tags, and its chunk offsets when the audio moves
//! (RECORD/2026-11-28.aac-m4a.WIP.md, A1 and A2).

use std::ops::Range;

use jackbird_mp4::{self as mp4, Data, Item, Kind, Placed, data_type};

use crate::{Cover, CoverChange, Error, Field, Fields, Format, Refusal, Tags};

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

// ---------------------------------------------------------------- writing

/// The room left after `ilst` when `moov` has to change size anyway: the next save fits in it.
const PADDING: u64 = 2048;

/// The top-level boxes of a file or of its head, as far as their headers go.
fn top(bytes: &[u8]) -> Result<Vec<Placed>, Error> {
    Ok(mp4::top_level(bytes, u64::MAX).map_err(unreadable)?.0)
}

fn range(placed: &Placed) -> Range<usize> {
    placed.start as usize..placed.end() as usize
}

/// The parts of a file a save works on.
struct Parts {
    /// The top-level boxes.
    boxes: Vec<Placed>,
    /// `moov`'s index among them.
    moov: usize,
    /// Whether `moov` comes before the audio (`mdat`).
    moov_first: bool,
    /// Where the audio starts (`mdat`'s content).
    audio: u64,
}

fn parts(bytes: &[u8]) -> Result<Parts, Error> {
    let boxes = top(bytes)?;
    let position = |kind: &Kind| boxes.iter().position(|placed| placed.header.kind == *kind);
    let moov = position(b"moov").ok_or_else(|| Error::Unreadable("no moov".into()))?;
    let mdat = position(b"mdat").ok_or_else(|| Error::Unreadable("no mdat".into()))?;
    let audio = boxes[mdat].content().start;
    Ok(Parts {
        moov_first: moov < mdat,
        audio,
        boxes,
        moov,
    })
}

/// A number and its total as `trkn` (with two bytes after) or `disk` holds them: `n`, `n/total`.
fn encode_numbered(field: Field, value: &str) -> Result<Vec<u8>, Error> {
    let number = |text: &str| -> Result<u16, Error> {
        text.trim().parse().map_err(|_| {
            Error::Refused(Refusal::Fields(format!(
                "{field:?} {value:?} is not a number or n/total"
            )))
        })
    };
    let (n, total) = match value.split_once('/') {
        Some((n, total)) => (number(n)?, number(total)?),
        None => (number(value)?, 0),
    };
    let mut out = vec![0, 0];
    out.extend(n.to_be_bytes());
    out.extend(total.to_be_bytes());
    if field == Field::Track {
        out.extend([0, 0]);
    }
    Ok(out)
}

/// The item a field's new value makes; `None` for an empty value, which only takes it out.
fn encode(field: Field, value: &str) -> Result<Option<Vec<u8>>, Error> {
    if value.is_empty() {
        return Ok(None);
    }
    let data = match field {
        Field::Track | Field::Disc => mp4::data_atom(data_type::IMPLICIT, &encode_numbered(field, value)?),
        Field::Compilation => mp4::data_atom(data_type::INTEGER, &[1]),
        Field::Bpm => {
            let bpm: u16 = value
                .trim()
                .parse()
                .map_err(|_| Error::Refused(Refusal::Fields(format!("the BPM {value:?} is not a number"))))?;
            mp4::data_atom(data_type::INTEGER, &bpm.to_be_bytes())
        }
        _ => mp4::data_atom(data_type::UTF8, value.as_bytes()),
    };
    Ok(Some(match places(field)[0] {
        Place::Atom(kind) => mp4::item(kind, &[data]),
        Place::Freeform(name) => mp4::freeform(MEAN, name, &[data]),
    }))
}

/// A picture's `data` type by its MIME type.
fn picture_type(mime: &str) -> u32 {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => data_type::PNG,
        "image/bmp" => data_type::BMP,
        _ => data_type::JPEG,
    }
}

/// `covr`'s atoms, raw, and which of them is the picture shown (its first `data` with bytes).
fn cover_atoms(raw_item: &[u8]) -> Result<(Vec<Vec<u8>>, Option<usize>), Error> {
    let header = mp4::header(raw_item, raw_item.len() as u64, 0)
        .map_err(unreadable)?
        .ok_or_else(|| Error::Unreadable("covr".into()))?;
    let body = &raw_item[header.header_len as usize..];
    let atoms = mp4::children(body).map_err(unreadable)?;
    let shown = atoms
        .iter()
        .position(|atom| atom.kind == *b"data" && atom.body.len() > 8);
    Ok((
        atoms
            .iter()
            .map(|atom| body[atom.range.0..atom.range.1].to_vec())
            .collect(),
        shown,
    ))
}

/// `ilst`'s new content: the items no change touches, byte for byte and in order; each changed
/// field's new item where its first item was (or at the end); the cover changed in `covr`.
fn new_items(
    ilst: &[u8],
    items: &[Item],
    changes: &[(Field, String)],
    cover: Option<CoverChange<'_>>,
) -> Result<Vec<u8>, Error> {
    // Each entry: the source's item it is (none for a new one), and its bytes.
    let mut list: Vec<(Option<&Item>, Vec<u8>)> = items
        .iter()
        .map(|item| (Some(item), ilst[item.range.0..item.range.1].to_vec()))
        .collect();
    for (field, value) in changes {
        let at_field = |entry: &(Option<&Item>, Vec<u8>)| {
            entry
                .0
                .is_some_and(|item| places(*field).iter().any(|place| is_at(item, *place)))
        };
        let first = list.iter().position(at_field);
        list.retain(|entry| !at_field(entry));
        if let Some(new) = encode(*field, value)? {
            let at = first.unwrap_or(list.len()).min(list.len());
            list.insert(at, (None, new));
        }
    }
    if let Some(change) = cover {
        let covr = list.iter().position(|(item, _)| {
            item.is_some_and(|item| item.kind == *b"covr" && item.data.iter().any(|data| !data.value.is_empty()))
        });
        match (change, covr) {
            (CoverChange::Set(cover), Some(at)) => {
                let (mut atoms, shown) = cover_atoms(&list[at].1)?;
                let new = mp4::data_atom(picture_type(&cover.mime), &cover.data);
                match shown {
                    Some(shown) => atoms[shown] = new,
                    None => atoms.insert(0, new),
                }
                list[at].1 = mp4::item(b"covr", &atoms);
            }
            (CoverChange::Set(cover), None) => {
                list.push((
                    None,
                    mp4::item(b"covr", &[mp4::data_atom(picture_type(&cover.mime), &cover.data)]),
                ));
            }
            (CoverChange::Remove, Some(at)) => {
                let (mut atoms, shown) = cover_atoms(&list[at].1)?;
                if let Some(shown) = shown {
                    atoms.remove(shown);
                }
                if atoms.iter().any(|atom| atom.get(4..8) == Some(b"data")) {
                    list[at].1 = mp4::item(b"covr", &atoms);
                } else {
                    list.remove(at);
                }
            }
            (CoverChange::Remove, None) => {}
        }
    }
    Ok(list.into_iter().flat_map(|(_, bytes)| bytes).collect())
}

/// The bytes of `bytes`' boxes, each as it is or as `replace` gives it (`None`: left out).
fn rebuilt<'a>(
    bytes: &'a [u8],
    mut replace: impl FnMut(&mp4::Child<'a>) -> Option<Option<Vec<u8>>>,
) -> Result<Vec<u8>, Error> {
    let mut out = Vec::with_capacity(bytes.len());
    for child in mp4::children(bytes).map_err(unreadable)? {
        match replace(&child) {
            Some(Some(new)) => out.extend(new),
            Some(None) => {}
            None => out.extend(&bytes[child.range.0..child.range.1]),
        }
    }
    Ok(out)
}

/// iTunes' `meta` handler: `mdir`, by `appl`.
fn meta_handler() -> Vec<u8> {
    let mut body = vec![0, 0, 0, 0];
    body.extend(b"mdirappl");
    body.extend([0; 9]);
    mp4::full_boxed(b"hdlr", [0; 4], &body)
}

/// `moov`'s new content: `ilst` with `content`, and `room` bytes of `free` right after it (none
/// for `None`), in place of the old `ilst` and the `free` that followed it; `udta` and `meta` made
/// when there are none.
fn new_moov(moov: &[u8], content: &[u8], room: Option<u64>) -> Result<Vec<u8>, Error> {
    let ilst = mp4::boxed(b"ilst", content);
    let after = room.map(mp4::room).unwrap_or_default();
    let new_meta = |list: &[u8]| {
        let mut body = meta_handler();
        body.extend(list);
        body.extend(&after);
        mp4::full_boxed(b"meta", [0; 4], &body)
    };
    let meta_of = |meta: &mp4::Child<'_>| -> Result<Vec<u8>, Error> {
        let quicktime = mp4::meta_is_quicktime(meta.body);
        let (prefix, list) = meta.body.split_at(if quicktime { 0 } else { 4.min(meta.body.len()) });
        let kids = mp4::children(list).map_err(unreadable)?;
        let mut out = prefix.to_vec();
        let mut placed = false;
        let mut skip_free = false;
        for (index, kid) in kids.iter().enumerate() {
            let raw = &list[kid.range.0..kid.range.1];
            if kid.kind == *b"ilst" && !placed {
                out.extend(&ilst);
                out.extend(&after);
                placed = true;
                skip_free = true;
                continue;
            }
            if skip_free && matches!(&kid.kind, b"free" | b"skip") {
                skip_free = false;
                continue;
            }
            skip_free = false;
            out.extend(raw);
            // No ilst: after the handler, else at the end.
            if !placed && kid.kind == *b"hdlr" && !kids[index + 1..].iter().any(|later| later.kind == *b"ilst") {
                out.extend(&ilst);
                out.extend(&after);
                placed = true;
            }
        }
        if !placed {
            out.extend(&ilst);
            out.extend(&after);
        }
        Ok(mp4::boxed(b"meta", &out))
    };
    let mut has_udta = false;
    let mut moov_out = rebuilt(moov, |child| {
        (child.kind == *b"udta").then(|| {
            has_udta = true;
            let mut has_meta = false;
            let mut udta = rebuilt(child.body, |kid| {
                (kid.kind == *b"meta" && !has_meta).then(|| {
                    has_meta = true;
                    meta_of(kid).ok()
                })
            })
            .ok()?;
            if !has_meta {
                udta.extend(new_meta(&ilst));
            }
            Some(mp4::boxed(b"udta", &udta))
        })
    })?;
    if !has_udta {
        moov_out.extend(mp4::boxed(b"udta", &new_meta(&ilst)));
    }
    Ok(moov_out)
}

/// The `free` (or `skip`) right after `ilst` in `meta`: its size, 0 when there is none.
fn room_after_ilst(moov: &[u8]) -> Result<u64, Error> {
    let Some(meta) = mp4::path(moov, &[b"udta", b"meta"]).map_err(unreadable)? else {
        return Ok(0);
    };
    let kids = mp4::children(mp4::meta_children(meta.body)).map_err(unreadable)?;
    Ok(kids
        .iter()
        .position(|kid| kid.kind == *b"ilst")
        .and_then(|at| kids.get(at + 1))
        .filter(|kid| matches!(&kid.kind, b"free" | b"skip"))
        .map_or(0, |kid| (kid.range.1 - kid.range.0) as u64))
}

/// Writes the changes into a file's tags: `bytes` is its head up to the audio (with `moov` first)
/// or the whole file (with `moov` last), and so is what this gives.
pub(crate) fn write(
    bytes: &[u8],
    changes: &[(Field, String)],
    cover: Option<CoverChange<'_>>,
) -> Result<Vec<u8>, Error> {
    let parts = parts(bytes)?;
    let moov_box = parts.boxes[parts.moov];
    let moov = moov(bytes)?;
    let at = mp4::tags_at(moov).map_err(unreadable)?;
    let ilst_old = at.ilst.map_or(0, |(start, end)| (end - start) as u64);
    let content = match at.ilst {
        Some((start, end)) => {
            let header = mp4::header(&moov[start..end], (end - start) as u64, 0)
                .map_err(unreadable)?
                .ok_or_else(|| Error::Unreadable("ilst".into()))?;
            &moov[start + header.header_len as usize..end]
        }
        None => &[][..],
    };
    let items = mp4::items(content).map_err(unreadable)?;
    let ilst_content = new_items(content, &items, changes, cover)?;
    let ilst_new = 8 + ilst_content.len() as u64;
    let old_room = room_after_ilst(moov)?;
    // The free after moov, before the audio, which can take the difference instead.
    let next = parts
        .boxes
        .get(parts.moov + 1)
        .copied()
        .filter(|next| parts.moov_first && matches!(&next.header.kind, b"free" | b"skip"));

    // 1: the room after ilst takes the difference.
    let left = (old_room + ilst_old) as i64 - ilst_new as i64;
    let mut candidates = Vec::new();
    if at.meta.is_some() && (left == 0 || left >= 8) {
        candidates.push((left > 0).then_some(left as u64));
    }
    candidates.push(Some(PADDING));
    let old_size = moov_box.header.size as i64;
    for (index, room) in candidates.iter().enumerate() {
        let mut content = new_moov(moov, &ilst_content, *room)?;
        let new_box_len = mp4::boxed(b"moov", &content).len() as i64;
        let moved = new_box_len - old_size;
        let last = index + 1 == candidates.len();
        // 2: the free after moov takes it.
        let free_after = next.and_then(|free| {
            let size = free.header.size as i64 - moved;
            (moved != 0 && (size == 0 || size >= 8)).then_some(size as u64)
        });
        if !(moved == 0 || !parts.moov_first || free_after.is_some() || last) {
            continue;
        }
        // 3: the audio moves, and every offset into it with it.
        if parts.moov_first && moved != 0 && free_after.is_none() {
            if mp4::child(moov, b"mvex").map_err(unreadable)?.is_some() || contains(moov, b"saio") {
                return Err(Error::Unreadable(
                    "a fragmented file, or one with sample auxiliary offsets: its audio cannot move".into(),
                ));
            }
            mp4::shift_chunks(&mut content, moov_box.end(), moved).map_err(|_| Error::TooLarge)?;
        }
        let mut out = bytes[..moov_box.start as usize].to_vec();
        out.extend(mp4::boxed(b"moov", &content));
        let mut rest = moov_box.end() as usize;
        if let (Some(free), Some(size)) = (next, free_after) {
            if size > 0 {
                out.extend(mp4::room(size));
            }
            rest = free.end() as usize;
        }
        out.extend(&bytes[rest..]);
        return Ok(out);
    }
    unreachable!("the last candidate is always taken")
}

/// Whether a box of type `kind` is anywhere among `bytes`' boxes, at any depth of the boxes whose
/// content is boxes.
fn contains(bytes: &[u8], kind: &Kind) -> bool {
    mp4::children(bytes).is_ok_and(|kids| {
        kids.iter().any(|kid| {
            kid.kind == *kind
                || (matches!(&kid.kind, b"trak" | b"mdia" | b"minf" | b"stbl" | b"moof" | b"traf")
                    && contains(kid.body, kind))
        })
    })
}

// ---------------------------------------------------------------- safeguards

/// Where the audio starts by a head's own boxes: `mdat`'s content with `moov` first; the end of the
/// boxes with `moov` last, which must be the bytes' end.
pub(crate) fn declared_end(bytes: &[u8]) -> Option<usize> {
    let parts = parts(bytes).ok()?;
    if parts.moov_first {
        return usize::try_from(parts.audio).ok();
    }
    let (_, next) = mp4::top_level(bytes, u64::MAX).ok()?;
    (next == Some(bytes.len() as u64)).then_some(bytes.len())
}

/// A `moov` child's bytes with its chunk offsets made relative to the audio's start (`audio`), so
/// two files whose audio moved compare equal when every chunk still points at the same bytes.
fn relative(moov: &[u8], audio: u64) -> Result<Vec<u8>, Error> {
    let mut out = moov.to_vec();
    let by = -i64::try_from(audio).map_err(|_| Error::TooLarge)?;
    mp4::shift_chunks(&mut out, audio, by).map_err(|_| Error::Refused(Refusal::Kept("a chunk offset".into())))?;
    Ok(out)
}

/// The items of a file's tags, with their bytes, whatever their atoms say.
fn items_of(moov: &[u8]) -> Result<(Vec<Item>, Vec<u8>), Error> {
    let at = mp4::tags_at(moov).map_err(unreadable)?;
    let Some((start, end)) = at.ilst else {
        return Ok((Vec::new(), Vec::new()));
    };
    let header = mp4::header(&moov[start..end], (end - start) as u64, 0)
        .map_err(unreadable)?
        .ok_or_else(|| Error::Unreadable("ilst".into()))?;
    let content = moov[start + header.header_len as usize..end].to_vec();
    Ok((mp4::items(&content).map_err(unreadable)?, content))
}

/// `udta`'s children but `meta`, and `meta`'s version and handler (none when it has no `meta`).
type UdtaRest = (Vec<Vec<u8>>, Option<Vec<u8>>);

/// Safeguard 3 for MPEG-4: every top-level box but `moov` and the `free` after it; every child of
/// `moov` but `udta`, its chunk offsets pointing at the same bytes of the audio; `udta`'s other
/// children and `meta`'s version and handler; every item no change touches, in order; `covr`'s
/// other pictures.
pub(crate) fn check_kept(
    source: &[u8],
    out: &[u8],
    changes: &[(Field, String)],
    cover: Option<CoverChange<'_>>,
) -> Result<(), Error> {
    let kept = |what: &str| Error::Refused(Refusal::Kept(what.to_owned()));
    let (before, after) = (parts(source)?, parts(out).map_err(|_| kept("the boxes"))?);
    let outer = |file: &[u8], parts: &Parts| -> Vec<Vec<u8>> {
        parts
            .boxes
            .iter()
            .enumerate()
            .filter(|(index, placed)| {
                *index != parts.moov && !(*index == parts.moov + 1 && matches!(&placed.header.kind, b"free" | b"skip"))
            })
            .map(|(_, placed)| {
                let range = range(placed);
                file[range.start..range.end.min(file.len())].to_vec()
            })
            .collect()
    };
    if outer(source, &before) != outer(out, &after) {
        return Err(kept("a top-level box"));
    }
    let (old_moov, new_moov) = (moov(source)?, moov(out).map_err(|_| kept("moov"))?);
    let (old_rel, new_rel) = (relative(old_moov, before.audio)?, relative(new_moov, after.audio)?);
    let others = |moov: &[u8]| -> Result<Vec<Vec<u8>>, Error> {
        Ok(mp4::children(moov)
            .map_err(unreadable)?
            .iter()
            .filter(|kid| kid.kind != *b"udta")
            .map(|kid| moov[kid.range.0..kid.range.1].to_vec())
            .collect())
    };
    if others(&old_rel)? != others(&new_rel).map_err(|_| kept("moov"))? {
        return Err(kept("a track, or where its chunks point"));
    }
    // udta's other children, and meta's version and handler.
    let udta_rest = |moov: &[u8]| -> Result<UdtaRest, Error> {
        let Some(udta) = mp4::child(moov, b"udta").map_err(unreadable)? else {
            return Ok((Vec::new(), None));
        };
        let kids = mp4::children(udta.body).map_err(unreadable)?;
        let rest = kids
            .iter()
            .filter(|kid| kid.kind != *b"meta")
            .map(|kid| udta.body[kid.range.0..kid.range.1].to_vec())
            .collect();
        let meta = kids.iter().find(|kid| kid.kind == *b"meta").map(|meta| {
            let quicktime = mp4::meta_is_quicktime(meta.body);
            let list = mp4::meta_children(meta.body);
            let mut head = if quicktime {
                Vec::new()
            } else {
                meta.body[..4.min(meta.body.len())].to_vec()
            };
            for kid in mp4::children(list).unwrap_or_default() {
                if !matches!(&kid.kind, b"ilst" | b"free" | b"skip") {
                    head.extend(&list[kid.range.0..kid.range.1]);
                }
            }
            head
        });
        Ok((rest, meta))
    };
    let (old_udta, old_meta) = udta_rest(old_moov)?;
    let (new_udta, new_meta) = udta_rest(new_moov).map_err(|_| kept("udta"))?;
    if old_udta != new_udta {
        return Err(kept("a box of udta"));
    }
    if old_meta.is_some() && old_meta != new_meta {
        return Err(kept("meta's handler"));
    }
    // The items no change touches.
    let touched = |item: &Item| {
        changes
            .iter()
            .any(|(field, _)| places(*field).iter().any(|place| is_at(item, *place)))
            || (cover.is_some() && item.kind == *b"covr")
    };
    let (old_items, old_content) = items_of(old_moov)?;
    let (new_items, new_content) = items_of(new_moov).map_err(|_| kept("ilst"))?;
    let untouched = |items: &[Item], content: &[u8]| -> Vec<Vec<u8>> {
        items
            .iter()
            .filter(|item| !touched(item))
            .map(|item| content[item.range.0..item.range.1].to_vec())
            .collect()
    };
    if untouched(&old_items, &old_content) != untouched(&new_items, &new_content) {
        return Err(kept("an item of the tags"));
    }
    // covr's other pictures.
    if let Some(change) = cover {
        let pictures = |items: &[Item]| -> Vec<Vec<u8>> {
            items
                .iter()
                .filter(|item| item.kind == *b"covr")
                .flat_map(|item| item.data.iter().map(|data| data.value.clone()))
                .collect()
        };
        let mut expected = pictures(&old_items);
        if let Some(shown) = expected.iter().position(|value| !value.is_empty()) {
            expected.remove(shown);
        }
        let mut found = pictures(&new_items);
        if let CoverChange::Set(cover) = change
            && let Some(at) = found.iter().position(|value| *value == cover.data)
        {
            found.remove(at);
        }
        if expected != found {
            return Err(kept("a picture"));
        }
    }
    Ok(())
}
