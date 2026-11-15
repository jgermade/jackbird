//! Album artwork on the iPod nano 6G and 7G: `iPod_Control/Artwork/ArtworkDB`
//! and its image files (`F1010_1.ithmb`, …), as read from the owner's nano 7G
//! (`RECORD/2026-11-14.ipod-sync.WIP.md`, artwork).
//!
//! ```text
//! mhfd                      the database; 0x1C: the next image ID
//!   mhsd type 1 → mhli      the images
//!     mhii                  one image: 0x10 its ID, 0x14 a song's pid, 0x38 how many songs share it
//!       mhod type 2 → mhni  one size: its format, where it is in which file, its bytes, height, width
//!         mhod type 3       the file's name (":F1010_1.ithmb")
//!       mhod type 6         (copied as Apple writes it)
//!   mhsd type 2 → mhla      photo albums (none)
//!   mhsd type 3 → mhlf      the files: mhif, a format and its bytes per image
//! ```
//!
//! A song points to its image with the `mhit`'s `0x160` and `item.artwork_cache_id`
//! (and has `0xA4` / `artwork_status` 1). The songs of an album share one image
//! ("sparse artwork"). Pixels are RGB565, little-endian, each row padded to 4
//! bytes; an image that is not square is scaled to fit, and keeps the slot of a
//! square one.

use crate::chunk::{self, Body, Chunk};
use crate::{Error, sysinfo};

/// A size the iPod shows covers at (`SysInfoExtended`'s `AlbumArt2`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Format {
    /// Its ID, which names its file (`F1010_1.ithmb`).
    pub id: u32,
    /// Width in pixels.
    pub width: u16,
    /// Height in pixels.
    pub height: u16,
}

impl Format {
    /// Bytes in a row: two a pixel, padded to 4.
    pub fn row_bytes(self, width: u16) -> usize {
        (usize::from(width) * 2).div_ceil(4) * 4
    }

    /// Bytes an image takes in its file: a full-size slot.
    pub fn slot(self) -> usize {
        self.row_bytes(self.width) * usize::from(self.height)
    }

    /// The name of its first file.
    pub fn file(self) -> String {
        format!("F{}_1.ithmb", self.id)
    }
}

/// The album-art formats a `SysInfoExtended` names, in its order, the ones
/// "associated" with another format (a variant of the same size) left out.
pub fn album_art_formats(sysinfo_extended: &str) -> Vec<Format> {
    let Some(list) = crate::library::element_after_key(sysinfo_extended, "AlbumArt2") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut rest = list;
    while let Some(start) = rest.find("<dict>") {
        let Some(end) = rest[start..].find("</dict>") else {
            break;
        };
        let values = sysinfo::extended_values(&rest[start..start + end]);
        let number = |k: &str| values.get(k).and_then(|v| v.parse::<u32>().ok());
        if let (Some(id), Some(w), Some(h)) = (number("FormatId"), number("RenderWidth"), number("RenderHeight"))
            && number("AssociatedFormat").unwrap_or(0) == 0
            && values.get("PixelFormat").map(String::as_str) == Some("4C353635")
        {
            out.push(Format {
                id,
                width: w as u16,
                height: h as u16,
            });
        }
        rest = &rest[start + end + "</dict>".len()..];
    }
    out
}

/// One size of an image: where its pixels are.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Thumb {
    /// Its format's ID.
    pub format: u32,
    /// Its file, as the database names it (`:F1010_1.ithmb`).
    pub file: String,
    /// Where it starts in the file.
    pub offset: u32,
    /// Its slot's bytes.
    pub size: u32,
    /// Its pixels' height, counting `top` (the image is in rows `top` to
    /// `height - 1`).
    pub height: u16,
    /// Blank rows above the image (`mhni` `0x1C`): Apple centres a large
    /// cover that is not square; jackbird writes 0, as Apple does for small ones.
    pub top: i16,
    /// Blank columns left of it (`0x1E`); 0 on the owner's nano.
    pub left: i16,
    /// Its pixels' width.
    pub width: u16,
}

/// An image.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Image {
    /// Its ID: the songs' `artwork_cache_id`.
    pub id: u32,
    /// A song that shows it.
    pub song: i64,
    /// How many songs share it.
    pub songs: u32,
    /// Its sizes.
    pub thumbs: Vec<Thumb>,
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    b.get(at..at + 2)
        .map_or(0, |s| u16::from_le_bytes(s.try_into().expect("two bytes")))
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    b.get(at..at + 4)
        .map_or(0, |s| u32::from_le_bytes(s.try_into().expect("four bytes")))
}

fn put(b: &mut [u8], at: usize, bytes: &[u8]) {
    b[at..at + bytes.len()].copy_from_slice(bytes);
}

/// A chunk with a header of `len` bytes, its name and header length set.
fn header(name: &[u8; 4], len: usize) -> Vec<u8> {
    let mut h = vec![0u8; len];
    put(&mut h, 0, name);
    put(&mut h, 4, &(len as u32).to_le_bytes());
    h
}

/// The thumbnail an `mhod` of type 2 holds.
fn thumb_of(mhod: &Chunk) -> Option<Thumb> {
    if u16_at(&mhod.header, 0x0c) != 2 {
        return None;
    }
    let Body::Raw(body) = &mhod.body else { return None };
    let mhni = chunk::parse_rooted(body, "mhni").ok()?;
    let h = &mhni.header;
    let file = mhni.children().iter().find_map(|m| {
        let Body::Raw(b) = &m.body else { return None };
        let len = u32_at(b, 0) as usize;
        let units: Vec<u16> = b
            .get(12..12 + len)?
            .as_chunks::<2>()
            .0
            .iter()
            .map(|p| u16::from_le_bytes(*p))
            .collect();
        Some(String::from_utf16_lossy(&units))
    })?;
    Some(Thumb {
        format: u32_at(h, 0x10),
        file,
        offset: u32_at(h, 0x14),
        size: u32_at(h, 0x18),
        top: u16_at(h, 0x1c) as i16,
        left: u16_at(h, 0x1e) as i16,
        height: u16_at(h, 0x20),
        width: u16_at(h, 0x22),
    })
}

/// An `mhod` of type 2 holding a thumbnail's `mhni`, as Apple writes it.
pub fn thumb_mhod(t: &Thumb) -> Chunk {
    let utf16: Vec<u8> = t.file.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut name_body = Vec::new();
    name_body.extend_from_slice(&(utf16.len() as u32).to_le_bytes());
    name_body.extend_from_slice(&2u32.to_le_bytes()); // UTF-16
    name_body.extend_from_slice(&0u32.to_le_bytes());
    name_body.extend(utf16);
    while name_body.len() % 4 != 0 {
        name_body.push(0);
    }
    let mut name = header(b"mhod", 0x18);
    put(&mut name, 0x0c, &3u16.to_le_bytes());
    let mut mhni = header(b"mhni", 0x4c);
    put(&mut mhni, 0x0c, &1u32.to_le_bytes());
    put(&mut mhni, 0x10, &t.format.to_le_bytes());
    put(&mut mhni, 0x14, &t.offset.to_le_bytes());
    put(&mut mhni, 0x18, &t.size.to_le_bytes());
    put(&mut mhni, 0x1c, &t.top.to_le_bytes());
    put(&mut mhni, 0x1e, &t.left.to_le_bytes());
    put(&mut mhni, 0x20, &t.height.to_le_bytes());
    put(&mut mhni, 0x22, &t.width.to_le_bytes());
    put(&mut mhni, 0x28, &t.size.to_le_bytes());
    let mhni = Chunk {
        header: mhni,
        body: Body::Children(vec![Chunk {
            header: name,
            body: Body::Raw(name_body),
        }]),
    };
    let mut mhod = header(b"mhod", 0x18);
    put(&mut mhod, 0x0c, &2u16.to_le_bytes());
    Chunk {
        header: mhod,
        body: Body::Raw(mhni.write().expect("a small chunk")),
    }
}

/// The `mhod` of type 6 every image of the owner's nano ends with: an `mhaf`
/// header and nothing in it.
pub fn mhaf_mhod() -> Chunk {
    let mut mhod = header(b"mhod", 0x18);
    put(&mut mhod, 0x0c, &6u16.to_le_bytes());
    let mut mhaf = header(b"mhaf", 0x60);
    put(&mut mhaf, 8, &0x3cu32.to_le_bytes());
    Chunk {
        header: mhod,
        body: Body::Raw(mhaf),
    }
}

/// An `ArtworkDB`, in memory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtworkDb {
    /// Its tree.
    pub tree: Chunk,
}

impl ArtworkDb {
    /// Reads an `ArtworkDB`.
    pub fn parse(data: &[u8]) -> Result<ArtworkDb, Error> {
        Ok(ArtworkDb {
            tree: chunk::parse_rooted(data, "mhfd")?,
        })
    }

    /// An `ArtworkDB` with no image, for an iPod that has none yet: the three
    /// sections, empty, and the next image ID at 100.
    pub fn empty() -> ArtworkDb {
        let section = |kind: u16, list: &[u8; 4]| {
            let mut h = header(b"mhsd", 0x60);
            put(&mut h, 0x0c, &kind.to_le_bytes());
            Chunk {
                header: h,
                body: Body::Children(vec![Chunk {
                    header: header(list, 0x5c),
                    body: Body::List(vec![]),
                }]),
            }
        };
        let mut h = header(b"mhfd", 0x84);
        put(&mut h, 0x1c, &100u32.to_le_bytes());
        ArtworkDb {
            tree: Chunk {
                header: h,
                body: Body::Children(vec![section(1, b"mhli"), section(2, b"mhla"), section(3, b"mhlf")]),
            },
        }
    }

    /// Writes it back.
    pub fn write(&self) -> Result<Vec<u8>, Error> {
        self.tree.write()
    }

    fn list(&self, kind: u16) -> &[Chunk] {
        self.tree
            .children()
            .iter()
            .find(|s| s.name() == *b"mhsd" && u16_at(&s.header, 0x0c) == kind)
            .and_then(|s| s.children().first())
            .map_or(&[], Chunk::children)
    }

    fn list_mut(&mut self, kind: u16) -> Option<&mut Vec<Chunk>> {
        self.tree
            .children_mut()?
            .iter_mut()
            .find(|s| s.name() == *b"mhsd" && u16_at(&s.header, 0x0c) == kind)?
            .children_mut()?
            .first_mut()?
            .children_mut()
    }

    /// Its images.
    pub fn images(&self) -> Vec<Image> {
        self.list(1)
            .iter()
            .map(|m| Image {
                id: u32_at(&m.header, 0x10),
                song: i64::from_le_bytes(m.header[0x14..0x1c].try_into().expect("eight bytes")),
                songs: u32_at(&m.header, 0x38),
                thumbs: m.children().iter().filter_map(thumb_of).collect(),
            })
            .collect()
    }

    /// The formats it has files for (`mhif`): ID and bytes an image.
    pub fn files(&self) -> Vec<(u32, u32)> {
        self.list(3)
            .iter()
            .map(|f| (u32_at(&f.header, 0x10), u32_at(&f.header, 0x14)))
            .collect()
    }

    /// The ID the next image gets (`mhfd` `0x1C`).
    pub fn next_id(&self) -> u32 {
        u32_at(&self.tree.header, 0x1c)
    }

    /// Adds an image shown by `song`, its sizes already in their files, and
    /// gives its ID. Formats the database has no `mhif` for get one.
    pub fn add(&mut self, song: i64, thumbs: &[Thumb]) -> Option<u32> {
        let id = self.next_id();
        let known: Vec<u32> = self.files().iter().map(|(f, _)| *f).collect();
        let files = self.list_mut(3)?;
        for t in thumbs.iter().filter(|t| !known.contains(&t.format)) {
            let mut h = header(b"mhif", 0x7c);
            put(&mut h, 8, &0x7cu32.to_le_bytes());
            put(&mut h, 0x10, &t.format.to_le_bytes());
            put(&mut h, 0x14, &t.size.to_le_bytes());
            files.push(Chunk {
                header: h,
                body: Body::Raw(Vec::new()),
            });
        }
        let mut h = header(b"mhii", 0x98);
        put(&mut h, 0x0c, &(thumbs.len() as u32 + 1).to_le_bytes());
        put(&mut h, 0x10, &id.to_le_bytes());
        put(&mut h, 0x14, &song.to_le_bytes());
        put(&mut h, 0x38, &1u32.to_le_bytes());
        put(&mut h, 0x3c, &1u32.to_le_bytes());
        put(&mut h, 0x48, &f64::NAN.to_bits().to_le_bytes());
        put(&mut h, 0x50, &f64::NAN.to_bits().to_le_bytes());
        let mut children: Vec<Chunk> = thumbs.iter().map(thumb_mhod).collect();
        children.push(mhaf_mhod());
        self.list_mut(1)?.push(Chunk {
            header: h,
            body: Body::Children(children),
        });
        put(&mut self.tree.header, 0x1c, &(id + 1).to_le_bytes());
        Some(id)
    }

    /// One more song shows image `id`.
    pub fn share(&mut self, id: u32) -> bool {
        let Some(m) = self
            .list_mut(1)
            .and_then(|l| l.iter_mut().find(|m| u32_at(&m.header, 0x10) == id))
        else {
            return false;
        };
        let n = u32_at(&m.header, 0x38) + 1;
        put(&mut m.header, 0x38, &n.to_le_bytes());
        true
    }

    /// One song fewer shows image `id`, which goes when none is left (its
    /// pixels stay in their files, unused, as Apple leaves gaps). `song`, the
    /// one leaving, is replaced by `other` as the image's song if it was it.
    pub fn unshare(&mut self, id: u32, song: i64, other: Option<i64>) {
        let Some(list) = self.list_mut(1) else { return };
        let Some(at) = list.iter().position(|m| u32_at(&m.header, 0x10) == id) else {
            return;
        };
        let n = u32_at(&list[at].header, 0x38).saturating_sub(1);
        match other {
            Some(other) if n > 0 => {
                let m = &mut list[at];
                put(&mut m.header, 0x38, &n.to_le_bytes());
                if i64::from_le_bytes(m.header[0x14..0x1c].try_into().expect("eight bytes")) == song {
                    put(&mut m.header, 0x14, &other.to_le_bytes());
                }
            }
            _ => {
                list.remove(at);
            }
        }
    }
}

fn item_value(ipod: &crate::add::Ipod, pid: i64, column: &str) -> Option<crate::library::Value> {
    let items = ipod.rows.iter().find(|r| r.file == "Library.itdb")?.table("item")?;
    let key = crate::library::Value::Integer(pid);
    let row = items.find("pid", &key).next()?;
    Some(items.get(row, column))
}

/// The image song `pid` shows, if any.
pub fn image_of(ipod: &crate::add::Ipod, pid: i64) -> Option<u32> {
    use crate::library::Value;
    match (
        item_value(ipod, pid, "artwork_status")?,
        item_value(ipod, pid, "artwork_cache_id")?,
    ) {
        (Value::Integer(1), Value::Integer(id)) if id > 0 => u32::try_from(id).ok(),
        _ => None,
    }
}

/// The image another song of `pid`'s album shows, so that `pid` can share it.
pub fn album_image(ipod: &crate::add::Ipod, pid: i64) -> Option<u32> {
    use crate::library::Value;
    let album = item_value(ipod, pid, "album_pid").filter(|a| *a != Value::Null)?;
    let items = ipod.rows.iter().find(|r| r.file == "Library.itdb")?.table("item")?;
    items
        .find("album_pid", &album)
        .filter(|r| items.get(r, "pid") != Value::Integer(pid))
        .find_map(|r| match items.get(r, "pid") {
            Value::Integer(other) => image_of(ipod, other),
            _ => None,
        })
}

/// A song other than `pid` that shows image `id`.
pub fn other_song_of(ipod: &crate::add::Ipod, id: u32, pid: i64) -> Option<i64> {
    use crate::library::Value;
    let items = ipod.rows.iter().find(|r| r.file == "Library.itdb")?.table("item")?;
    let key = Value::Integer(i64::from(id));
    items
        .find("artwork_cache_id", &key)
        .find_map(|r| match items.get(r, "pid") {
            Value::Integer(p) if p != pid => Some(p),
            _ => None,
        })
}

/// Makes song `pid` show image `id`: its `mhit` (`0xA4` = 1, `0x160`), its
/// `item` row (`artwork_status`, `artwork_cache_id`), and its album's
/// `artwork_item_pid` when the album has none. False when there is no such song.
pub fn set_image(ipod: &mut crate::add::Ipod, pid: i64, id: u32) -> bool {
    use crate::library::Value;
    let Ok(tracks) = crate::add::list_mut(&mut ipod.tree, crate::add::SECTION_TRACKS, "track list") else {
        return false;
    };
    let Some(mhit) = tracks.iter_mut().find(|t| crate::add::i64_at(&t.header, 0x70) == pid) else {
        return false;
    };
    mhit.header[0xa4] = 1;
    put(&mut mhit.header, 0x160, &id.to_le_bytes());
    let Some(library) = ipod.rows.iter_mut().find(|r| r.file == "Library.itdb") else {
        return false;
    };
    let mut album = Value::Null;
    if let Some(items) = library.table_mut("item")
        && let (Some(p), Some(status), Some(cache), Some(a)) = (
            items.column("pid"),
            items.column("artwork_status"),
            items.column("artwork_cache_id"),
            items.column("album_pid"),
        )
    {
        for row in items.rows.iter_mut().filter(|r| r[p] == Value::Integer(pid)) {
            row[status] = Value::Integer(1);
            row[cache] = Value::Integer(i64::from(id));
            album = row[a].clone();
        }
    }
    if album != Value::Null
        && let Some(albums) = library.table_mut("album")
        && let (Some(p), Some(art)) = (albums.column("pid"), albums.column("artwork_item_pid"))
    {
        for row in albums.rows.iter_mut().filter(|r| r[p] == album) {
            if matches!(row[art], Value::Null | Value::Integer(0)) {
                row[art] = Value::Integer(pid);
            }
        }
    }
    true
}

/// The RGB pixels (three bytes each, row by row) of a thumbnail's slot.
pub fn decode(slot: &[u8], width: u16, height: u16, row_bytes: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(usize::from(width) * usize::from(height) * 3);
    for y in 0..usize::from(height) {
        for x in 0..usize::from(width) {
            let v = u16_at(slot, y * row_bytes + x * 2);
            let (r, g, b) = ((v >> 11) & 31, (v >> 5) & 63, v & 31);
            out.extend([(r * 255 / 31) as u8, (g * 255 / 63) as u8, (b * 255 / 31) as u8]);
        }
    }
    out
}

/// A thumbnail's slot of `slot` bytes for RGB pixels, rounded to RGB565.
pub fn encode(rgb: &[u8], width: u16, height: u16, row_bytes: usize, slot: usize) -> Vec<u8> {
    let mut out = vec![0u8; slot];
    for y in 0..usize::from(height) {
        for x in 0..usize::from(width) {
            let p = (y * usize::from(width) + x) * 3;
            let [r, g, b] = [rgb[p], rgb[p + 1], rgb[p + 2]].map(u16::from);
            let v = ((r * 31 + 127) / 255) << 11 | ((g * 63 + 127) / 255) << 5 | ((b * 31 + 127) / 255);
            put(&mut out, y * row_bytes + x * 2, &v.to_le_bytes());
        }
    }
    out
}

/// The size an image of `width` × `height` takes in a `size` × `size` square,
/// keeping its shape (Apple's 50×49 for a cover a little wider than tall).
pub fn fit(width: u32, height: u32, size: u16) -> (u16, u16) {
    let s = u32::from(size);
    if width == 0 || height == 0 {
        return (0, 0);
    }
    if width >= height {
        (size, ((height * s + width / 2) / width).max(1) as u16)
    } else {
        (((width * s + height / 2) / height).max(1) as u16, size)
    }
}

/// RGB pixels scaled from `w` × `h` to `tw` × `th`, each target pixel the mean
/// of the source pixels it covers (a box filter: covers only ever shrink).
pub fn scale(rgb: &[u8], w: u32, h: u32, tw: u16, th: u16) -> Vec<u8> {
    let (tw, th) = (u32::from(tw), u32::from(th));
    let mut out = Vec::with_capacity((tw * th * 3) as usize);
    for ty in 0..th {
        let (y0, y1) = (ty * h / th, ((ty + 1) * h).div_ceil(th).max(ty * h / th + 1).min(h));
        for tx in 0..tw {
            let (x0, x1) = (tx * w / tw, ((tx + 1) * w).div_ceil(tw).max(tx * w / tw + 1).min(w));
            let mut sum = [0u64; 3];
            for y in y0..y1 {
                for x in x0..x1 {
                    let p = ((y * w + x) * 3) as usize;
                    for c in 0..3 {
                        sum[c] += u64::from(rgb[p + c]);
                    }
                }
            }
            let n = u64::from((y1 - y0) * (x1 - x0)).max(1);
            out.extend(sum.map(|s| ((s + n / 2) / n) as u8));
        }
    }
    out
}

impl Image {
    /// Its largest size, the one a cover is shown from.
    pub fn largest(&self) -> Option<&Thumb> {
        self.thumbs
            .iter()
            .max_by_key(|t| u32::from(t.width) * u32::from(t.height))
    }
}

/// A cover's pixels from its size's slot (the `size` bytes at `offset` in its file): its width,
/// the height shown and the RGB rows. The slot is a square of the larger side, its rows padded to
/// 4 bytes, so a 240×239 cover's rows are 480 bytes apart, not its bytes over its height. A cover
/// Apple centres keeps blank rows above it (`top`): they are left out. `None` for an empty size.
pub fn cover_rgb(slot: &[u8], thumb: &Thumb) -> Option<(u16, u16, Vec<u8>)> {
    let rows = usize::from(thumb.height);
    if rows == 0 || thumb.width == 0 {
        return None;
    }
    let side = usize::from(thumb.width.max(thumb.height));
    let row_bytes = (side * 2).div_ceil(4) * 4;
    let top = usize::try_from(thumb.top.max(0)).unwrap_or(0).min(rows);
    let height = thumb.height - top as u16;
    if height == 0 {
        return None;
    }
    let rest = slot.get(top * row_bytes..).unwrap_or(&[]);
    Some((thumb.width, height, decode(rest, thumb.width, height, row_bytes)))
}

/// A cover as a PNG, from its size's slot ([`cover_rgb`]): 8-bit RGB, written with `fdeflate`'s
/// fast mode (a cover a little larger, made many times faster).
#[cfg(feature = "png")]
pub fn cover_png(slot: &[u8], thumb: &Thumb) -> Option<Vec<u8>> {
    let (width, height, rgb) = cover_rgb(slot, thumb)?;
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, u32::from(width), u32::from(height));
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&rgb).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FORMATS: &str = r#"<plist><dict><key>AlbumArt2</key><array>
<dict><key>FormatId</key><integer>1010</integer><key>RenderWidth</key><integer>240</integer><key>RenderHeight</key><integer>240</integer><key>PixelFormat</key><string>4C353635</string><key>AssociatedFormat</key><integer>0</integer></dict>
<dict><key>FormatId</key><integer>1011</integer><key>RenderWidth</key><integer>240</integer><key>RenderHeight</key><integer>240</integer><key>PixelFormat</key><string>4C353635</string><key>AssociatedFormat</key><integer>1024</integer></dict>
<dict><key>FormatId</key><integer>1016</integer><key>RenderWidth</key><integer>57</integer><key>RenderHeight</key><integer>57</integer><key>PixelFormat</key><string>4C353635</string><key>AssociatedFormat</key><integer>0</integer></dict>
</array><key>ChapterImageSpecs2</key><array><dict><key>FormatId</key><integer>1019</integer></dict></array></dict></plist>"#;

    #[test]
    fn formats_from_sysinfo_extended() {
        let f = album_art_formats(FORMATS);
        assert_eq!(f.iter().map(|f| f.id).collect::<Vec<_>>(), [1010, 1016]);
        assert_eq!(f[1].row_bytes(57), 116);
        assert_eq!(f[1].slot(), 6612);
        assert_eq!(f[0].slot(), 115_200);
        assert_eq!(f[0].file(), "F1010_1.ithmb");
        assert!(album_art_formats("<plist/>").is_empty());
    }

    #[test]
    fn add_share_unshare_and_read_back() {
        let mut db = ArtworkDb::empty();
        let thumb = Thumb {
            format: 1016,
            file: ":F1016_1.ithmb".into(),
            offset: 6612,
            size: 6612,
            height: 56,
            width: 57,
            top: 0,
            left: 0,
        };
        let id = db.add(42, std::slice::from_ref(&thumb)).unwrap();
        assert_eq!(id, 100);
        assert_eq!(db.next_id(), 101);
        assert!(db.share(id));
        assert!(!db.share(7));
        let bytes = db.write().unwrap();
        let back = ArtworkDb::parse(&bytes).unwrap();
        assert_eq!(back.write().unwrap(), bytes);
        assert_eq!(
            back.images(),
            [Image {
                id: 100,
                song: 42,
                songs: 2,
                thumbs: vec![thumb]
            }]
        );
        assert_eq!(back.files(), [(1016, 6612)]);
        let mut db = back;
        db.unshare(id, 42, Some(43));
        assert_eq!(db.images()[0].songs, 1);
        assert_eq!(db.images()[0].song, 43);
        db.unshare(id, 43, None);
        assert!(db.images().is_empty());
    }

    #[test]
    fn songs_and_their_images() {
        use crate::add::tests::{NOW, counter, ipod, song};
        use crate::library::Value;
        let mut ipod = ipod();
        let mut random = counter();
        let a = crate::add::add(&mut ipod, song("A", "F01/A.mp3"), None, NOW, &mut random).unwrap();
        let b = crate::add::add(&mut ipod, song("B", "F01/B.mp3"), None, NOW, &mut random).unwrap();
        assert_eq!(image_of(&ipod, a.pid), None);
        assert_eq!(album_image(&ipod, b.pid), None);
        assert!(set_image(&mut ipod, a.pid, 7));
        assert!(!set_image(&mut ipod, 12345, 7));
        assert_eq!(image_of(&ipod, a.pid), Some(7));
        assert_eq!(album_image(&ipod, b.pid), Some(7));
        assert_eq!(other_song_of(&ipod, 7, b.pid), Some(a.pid));
        assert_eq!(other_song_of(&ipod, 7, a.pid), None);
        let library = ipod.rows.iter().find(|r| r.file == "Library.itdb").unwrap();
        let albums = library.table("album").unwrap();
        assert_eq!(albums.get(&albums.rows[0], "artwork_item_pid"), Value::Integer(a.pid));
        let db = ipod.tree.write().unwrap();
        let at = db.windows(8).position(|w| w == a.pid.to_le_bytes()).unwrap() - 0x70;
        assert_eq!(db[at + 0xa4], 1);
        assert_eq!(u32_at(&db, at + 0x160), 7);
    }

    #[test]
    fn pixels() {
        let rgb = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
        let slot = encode(&rgb, 2, 2, 4, 8);
        assert_eq!(slot.len(), 8);
        assert_eq!(decode(&slot, 2, 2, 4), rgb);
        // Rows padded: a 1-pixel-wide image uses 4 bytes a row.
        let one = encode(&[10, 20, 30, 40, 50, 60], 1, 2, 4, 8);
        assert_eq!(decode(&one, 1, 2, 4).len(), 6);
    }

    #[test]
    fn fit_and_scale() {
        assert_eq!(fit(600, 600, 240), (240, 240));
        assert_eq!(fit(612, 600, 50), (50, 49));
        assert_eq!(fit(300, 600, 58), (29, 58));
        assert_eq!(fit(0, 10, 50), (0, 0));
        // A 4×2 image of two colours, halved: each half averaged.
        let mut rgb = Vec::new();
        for _ in 0..2 {
            rgb.extend([0, 0, 0, 0, 0, 0, 200, 100, 50, 200, 100, 50]);
        }
        assert_eq!(scale(&rgb, 4, 2, 2, 1), [0, 0, 0, 200, 100, 50]);
        assert_eq!(scale(&rgb, 4, 2, 4, 2), rgb);
    }
}
