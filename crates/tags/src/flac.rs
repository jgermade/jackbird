//! FLAC: the fields over the first `VORBIS_COMMENT` block, the cover over
//! the `PICTURE` blocks.

use jackbird_flac::{
    self as meta, Block, Comments, Metadata, PADDING, PICTURE, Picture, VORBIS_COMMENT, decode_picture, encode_picture,
    entry, image_size,
};

use crate::{Cover, CoverChange, Error, Field, Fields, Format, Refusal, Tags};

/// The padding the metadata gets when it no longer fits in the old room.
const PADDING_BYTES: usize = 1024;

/// The vendor string of a comment block jackbird has to create.
const VENDOR: &str = "jackbird";

/// The keys a field is read from and written to; the first is the one a new entry takes.
fn keys(field: Field) -> &'static [&'static str] {
    match field {
        Field::Title => &["TITLE"],
        Field::Artist => &["ARTIST"],
        Field::Album => &["ALBUM"],
        Field::Year => &["DATE", "YEAR"],
        Field::Genre => &["GENRE"],
        Field::Track => &["TRACKNUMBER", "TRACKTOTAL", "TOTALTRACKS"],
        Field::Disc => &["DISCNUMBER", "DISCTOTAL", "TOTALDISCS"],
        Field::AlbumArtist => &["ALBUMARTIST", "ALBUM ARTIST"],
        Field::Compilation => &["COMPILATION"],
    }
}

fn unreadable(error: meta::Error) -> Error {
    Error::Unreadable(error.to_string())
}

fn first_comments(metadata: &Metadata) -> Option<(usize, Result<Comments, meta::Error>)> {
    let index = metadata.blocks.iter().position(|block| block.kind == VORBIS_COMMENT)?;
    Some((index, Comments::parse(&metadata.blocks[index].body)))
}

/// A number and its total (`TRACKNUMBER` and `TRACKTOTAL`, or `TOTALTRACKS`), as `n/total`.
fn numbered(comments: &Comments, [number, total, other]: [&str; 3]) -> String {
    let number = comments.get(number).unwrap_or_default();
    let total = comments
        .get(total)
        .filter(|total| !total.is_empty())
        .or_else(|| comments.get(other));
    match total {
        Some(total) if !total.is_empty() && !number.is_empty() && !number.contains('/') => format!("{number}/{total}"),
        _ => number,
    }
}

fn fields_of(comments: &Comments) -> Fields {
    let get = |key: &str| comments.get(key).unwrap_or_default();
    Fields {
        title: get("TITLE"),
        artist: get("ARTIST"),
        album: get("ALBUM"),
        year: comments.get("DATE").unwrap_or_else(|| get("YEAR")),
        genre: get("GENRE"),
        track: numbered(comments, ["TRACKNUMBER", "TRACKTOTAL", "TOTALTRACKS"]),
        disc: numbered(comments, ["DISCNUMBER", "DISCTOTAL", "TOTALDISCS"]),
        album_artist: comments.get("ALBUMARTIST").unwrap_or_else(|| get("ALBUM ARTIST")),
        compilation: get("COMPILATION"),
    }
}

/// The picture shown: the first readable front cover, else the first readable picture.
fn shown_picture(blocks: &[Block]) -> Option<(usize, Picture)> {
    let pictures: Vec<(usize, Picture)> = blocks
        .iter()
        .enumerate()
        .filter(|(_, block)| block.kind == PICTURE)
        .filter_map(|(index, block)| decode_picture(&block.body).ok().map(|picture| (index, picture)))
        .collect();
    let front = pictures.iter().position(|(_, picture)| picture.kind == 3).unwrap_or(0);
    pictures.into_iter().nth(front)
}

pub(crate) fn read(bytes: &[u8]) -> Result<Tags, Error> {
    let metadata = meta::read(bytes).map_err(unreadable)?;
    let fields = match first_comments(&metadata) {
        Some((_, Ok(comments))) => fields_of(&comments),
        _ => Fields::default(),
    };
    let cover = shown_picture(&metadata.blocks).map(|(_, picture)| Cover {
        data: picture.data,
        mime: picture.mime,
    });
    Ok(Tags {
        format: Format::Flac,
        fields,
        cover,
    })
}

/// Sets the first entry of `key` to `value`, keeping the key as it is written
/// there, or adds `KEY=value`.
fn set_first(comments: &mut Comments, key: &str, value: &str) {
    match comments.positions(key).first() {
        Some(&index) => {
            let written =
                String::from_utf8_lossy(meta::key(&comments.entries[index]).unwrap_or(key.as_bytes())).into_owned();
            comments.entries[index] = entry(&written, value);
        }
        None => comments.entries.push(entry(key, value)),
    }
}

fn remove_all(comments: &mut Comments, keys: &[&str]) {
    comments.entries.retain(|raw| {
        !meta::key(raw).is_some_and(|found| keys.iter().any(|key| found.eq_ignore_ascii_case(key.as_bytes())))
    });
}

fn apply(comments: &mut Comments, field: Field, value: &str) {
    let all = keys(field);
    if value.is_empty() {
        remove_all(comments, all);
        return;
    }
    match field {
        Field::Year => {
            // The entry the year was read from: DATE, else YEAR, else a new DATE.
            let key = if comments.positions("DATE").is_empty() && !comments.positions("YEAR").is_empty() {
                "YEAR"
            } else {
                "DATE"
            };
            set_first(comments, key, value);
        }
        Field::Track | Field::Disc => {
            let [number_key, total_key, other_key] = [all[0], all[1], all[2]];
            let (number, total) = match value.split_once('/') {
                Some((number, total)) => (number, Some(total)),
                None => (value, None),
            };
            set_first(comments, number_key, number);
            match total {
                Some(total) => {
                    let key = if comments.positions(total_key).is_empty() && !comments.positions(other_key).is_empty() {
                        other_key
                    } else {
                        total_key
                    };
                    set_first(comments, key, total);
                }
                None => remove_all(comments, &[total_key, other_key]),
            }
        }
        Field::AlbumArtist => {
            // The entry it was read from: ALBUMARTIST, else ALBUM ARTIST, else a new ALBUMARTIST.
            let key = if comments.positions("ALBUMARTIST").is_empty() && !comments.positions("ALBUM ARTIST").is_empty()
            {
                "ALBUM ARTIST"
            } else {
                "ALBUMARTIST"
            };
            set_first(comments, key, value);
        }
        _ => set_first(comments, all[0], value),
    }
}

pub(crate) fn write(
    bytes: &[u8],
    changes: &[(Field, String)],
    cover: Option<CoverChange<'_>>,
) -> Result<Vec<u8>, Error> {
    let metadata = meta::read(bytes).map_err(unreadable)?;
    let mut blocks = metadata.blocks.clone();
    if !changes.is_empty() {
        let (index, mut comments) = match first_comments(&metadata) {
            Some((index, parsed)) => (index, parsed.map_err(unreadable)?),
            None => {
                // A new comment block, right after STREAMINFO.
                blocks.insert(
                    1,
                    Block {
                        kind: VORBIS_COMMENT,
                        body: Vec::new(),
                    },
                );
                (1, Comments::new(VENDOR))
            }
        };
        for (field, value) in changes {
            apply(&mut comments, *field, value);
        }
        blocks[index].body = comments.to_bytes();
    }
    match cover {
        Some(CoverChange::Set(cover)) => {
            let (width, height, depth) = image_size(&cover.data).unwrap_or((0, 0, 0));
            let picture = Picture {
                kind: 3,
                mime: cover.mime.clone(),
                description: String::new(),
                width,
                height,
                depth,
                colors: 0,
                data: cover.data.clone(),
            };
            let block = Block {
                kind: PICTURE,
                body: encode_picture(&picture),
            };
            match shown_picture(&blocks) {
                Some((index, _)) => blocks[index] = block,
                None => blocks.push(block),
            }
        }
        Some(CoverChange::Remove) => {
            if let Some((index, _)) = shown_picture(&blocks) {
                blocks.remove(index);
            }
        }
        None => {}
    }
    let blocks = blocks.into_iter().filter(|block| block.kind != PADDING).collect();
    let arranged = meta::with_padding(blocks, metadata.len(), PADDING_BYTES);
    let written = meta::write(&arranged).map_err(|_| Error::TooLarge)?;
    let mut out = bytes[..metadata.start].to_vec();
    out.extend_from_slice(&written);
    out.extend_from_slice(&bytes[metadata.audio..]);
    Ok(out)
}

/// The blocks a comparison looks at: not the padding, not the first comment
/// block when the comments changed, not the pictures when the cover did.
fn compared(blocks: &[Block], comments_changed: bool, pictures_changed: bool) -> Vec<&Block> {
    let first_comments = blocks.iter().position(|block| block.kind == VORBIS_COMMENT);
    blocks
        .iter()
        .enumerate()
        .filter(|(index, block)| {
            block.kind != PADDING
                && !(comments_changed && Some(*index) == first_comments)
                && !(pictures_changed && block.kind == PICTURE)
        })
        .map(|(_, block)| block)
        .collect()
}

/// Safeguard 3: the ID3v2 tag before `fLaC`, every block, and every comment
/// entry of a key the changes do not touch, byte for byte and in order; and
/// every picture but the one a new cover replaces, or the one removed.
pub(crate) fn check_kept(
    source: &[u8],
    out: &[u8],
    changes: &[(Field, String)],
    cover: Option<CoverChange<'_>>,
) -> Result<(), Error> {
    let kept = |what: &str| Error::Refused(Refusal::Kept(what.to_owned()));
    let before = meta::read(source).map_err(unreadable)?;
    let after = meta::read(out).map_err(|_| kept("the metadata"))?;
    if source[..before.start] != out[..after.start] {
        return Err(kept("the ID3v2 tag before fLaC"));
    }
    let comments_changed = !changes.is_empty();
    if compared(&before.blocks, comments_changed, cover.is_some())
        != compared(&after.blocks, comments_changed, cover.is_some())
    {
        return Err(kept("a metadata block"));
    }

    if comments_changed {
        let touched: Vec<&str> = changes
            .iter()
            .flat_map(|(field, _)| keys(*field).iter().copied())
            .collect();
        let untouched = |comments: &Comments| -> Vec<Vec<u8>> {
            comments
                .entries
                .iter()
                .filter(|raw| {
                    !meta::key(raw)
                        .is_some_and(|found| touched.iter().any(|key| found.eq_ignore_ascii_case(key.as_bytes())))
                })
                .cloned()
                .collect()
        };
        let old = match first_comments(&before) {
            Some((_, parsed)) => Some(parsed.map_err(unreadable)?),
            None => None,
        };
        let new = match first_comments(&after) {
            Some((_, Ok(comments))) => comments,
            _ => return Err(kept("the comments")),
        };
        if let Some(old) = &old
            && (old.vendor != new.vendor || old.trailing != new.trailing)
        {
            return Err(kept("the comments' vendor string"));
        }
        if old.as_ref().map_or_else(Vec::new, untouched) != untouched(&new) {
            return Err(kept("a comment"));
        }
    }

    if let Some(cover) = cover {
        let pictures =
            |blocks: &[Block]| -> Vec<Block> { blocks.iter().filter(|block| block.kind == PICTURE).cloned().collect() };
        let mut expected = pictures(&before.blocks);
        if let Some((index, _)) = shown_picture(&before.blocks)
            && let Some(at) = expected.iter().position(|block| *block == before.blocks[index])
        {
            expected.remove(at);
        }
        let mut found = pictures(&after.blocks);
        if let CoverChange::Set(cover) = cover {
            let is_new = |block: &Block| {
                decode_picture(&block.body)
                    .is_ok_and(|picture| picture.kind == 3 && picture.data == cover.data && picture.mime == cover.mime)
            };
            if let Some(at) = found.iter().position(is_new) {
                found.remove(at);
            }
        }
        if expected != found {
            return Err(kept("a picture"));
        }
    }
    Ok(())
}
