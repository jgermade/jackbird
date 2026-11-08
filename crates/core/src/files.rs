//! Tags and checksums on files, reading only what they need: the tags from a
//! file's head and tail (`jackbird_tags::layout`), the checksums streamed from
//! disk, a save written as a splice. The audio is never held in memory.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::ops::Range;
use std::path::Path;

use jackbird_tags::{Cover, Edit, FIRST_HEAD, FileLayout, Layout, Refusal, TAIL_LEN, Tags};
use sha1::{Digest, Sha1};

use crate::root::{Error, Root, Stat, beside, io};

/// How much of a file is read at a time to hash it.
const CHUNK: usize = 1 << 20;

/// A file as `inspect` finds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inspection {
    /// Its size and date.
    pub stat: Stat,
    /// The SHA-1 of the whole file, in hex.
    pub full_checksum: String,
    /// The SHA-1 of its audio region, in hex.
    pub audio_checksum: String,
    /// Its tags, unless its full checksum was the one the caller knew; a
    /// file the engine cannot read reads as untagged, as in the browser.
    pub tags: Option<(jackbird_tags::Fields, Option<Cover>)>,
}

/// A file's layout, and its first bytes: at least up to the end of its tags.
fn layout_of(file: &mut File, len: u64, shown: &str) -> Result<(FileLayout, Vec<u8>), Error> {
    let tail_len = len.min(TAIL_LEN as u64);
    let mut tail = vec![0; tail_len as usize];
    file.seek(SeekFrom::Start(len - tail_len)).map_err(io(shown))?;
    file.read_exact(&mut tail).map_err(io(shown))?;
    let mut head = Vec::new();
    let mut want = len.min(FIRST_HEAD as u64);
    loop {
        if (head.len() as u64) < want {
            let have = head.len();
            head.resize(want as usize, 0);
            file.seek(SeekFrom::Start(have as u64)).map_err(io(shown))?;
            file.read_exact(&mut head[have..]).map_err(io(shown))?;
        }
        match jackbird_tags::layout(&head, &tail, len)? {
            Layout::Known(layout) => return Ok((layout, head)),
            // At least twice as much each time: a FLAC file with many large pictures takes few reads.
            Layout::NeedHead(n) if n > head.len() as u64 => want = len.min(n.max(2 * head.len() as u64)),
            Layout::NeedHead(_) => {
                return Err(Error::Tags(jackbird_tags::Error::Unreadable(
                    "the layout asks for no more".into(),
                )));
            }
        }
    }
}

/// The SHA-1s of a whole file and of its audio region, in one pass over it.
fn hashes(file: &mut File, audio: &Range<u64>, shown: &str) -> Result<(String, String), Error> {
    let (mut full, mut region) = (Sha1::new(), Sha1::new());
    let mut buffer = vec![0; CHUNK];
    let mut at = 0u64;
    file.seek(SeekFrom::Start(0)).map_err(io(shown))?;
    loop {
        let read = file.read(&mut buffer).map_err(io(shown))?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        full.update(chunk);
        let (start, end) = (audio.start.max(at), audio.end.min(at + read as u64));
        if start < end {
            region.update(&chunk[(start - at) as usize..(end - at) as usize]);
        }
        at += read as u64;
    }
    Ok((hex(&full.finalize()), hex(&region.finalize())))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn found(head: &[u8], layout: &FileLayout) -> (jackbird_tags::Fields, Option<Cover>) {
    match jackbird_tags::read_head(head, layout) {
        Ok(Tags { fields, cover, .. }) => (fields, cover),
        Err(_) => (jackbird_tags::Fields::default(), None),
    }
}

/// A file's size, date and checksums; its tags too, unless its full checksum
/// is `known`.
pub fn inspect(root: &Root, relative: &str, known: Option<&str>) -> Result<Inspection, Error> {
    let path = root.resolve(relative)?;
    inspect_path(&path, relative, known)
}

fn inspect_path(path: &Path, shown: &str, known: Option<&str>) -> Result<Inspection, Error> {
    let mut file = File::open(path).map_err(io(shown))?;
    let metadata = file.metadata().map_err(io(shown))?;
    let (layout, head) = layout_of(&mut file, metadata.len(), shown)?;
    let (full_checksum, audio_checksum) = hashes(&mut file, &layout.audio, shown)?;
    let tags = (known != Some(full_checksum.as_str())).then(|| found(&head, &layout));
    Ok(Inspection {
        stat: Stat::of(&metadata),
        full_checksum,
        audio_checksum,
        tags,
    })
}

/// Writes `edit` into a file's tags and gives the file as it is after.
///
/// The new tags come from `jackbird_tags::write_head`, checked by its
/// safeguards. When they are as long as the old ones (the engine reuses the
/// padding, so most edits), they are written in place and the audio is not
/// touched. When they are not, a new file is written beside the old one (the
/// new tags, then the old file's bytes after its tags, copied from disk), its
/// audio checked, and renamed over the old one: a crash or a full disk leaves
/// the old file whole. Either way, the file's audio region is hashed after
/// and must be the source's.
pub fn save(root: &Root, relative: &str, edit: &Edit) -> Result<Inspection, Error> {
    let path = root.resolve(relative)?;
    let (layout, splice, before) = {
        let mut file = File::open(&path).map_err(io(relative))?;
        let len = file.metadata().map_err(io(relative))?.len();
        let (layout, head) = layout_of(&mut file, len, relative)?;
        let (_, before) = hashes(&mut file, &layout.audio, relative)?;
        let splice = jackbird_tags::write_head(&head, &layout, edit)?;
        if splice.with[..] == head[..layout.tags_end as usize] {
            return inspect_path(&path, relative, None);
        }
        (layout, splice, before)
    };
    if splice.with.len() as u64 == layout.tags_end {
        let mut file = OpenOptions::new().write(true).open(&path).map_err(io(relative))?;
        file.write_all(&splice.with).map_err(io(relative))?;
        file.sync_all().map_err(io(relative))?;
    } else {
        let temporary = beside(&path);
        let written = write_beside(&path, &temporary, &layout, &splice.with, &before, relative);
        if written.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        written?;
    }
    let after = inspect_path(&path, relative, None)?;
    if after.audio_checksum != before {
        return Err(Error::Tags(jackbird_tags::Error::Refused(Refusal::Audio)));
    }
    Ok(after)
}

/// The new file beside the old one, checked, then renamed over it.
fn write_beside(
    path: &Path,
    temporary: &Path,
    layout: &FileLayout,
    tags: &[u8],
    before: &str,
    shown: &str,
) -> Result<(), Error> {
    {
        let mut source = File::open(path).map_err(io(shown))?;
        let mut target = File::create(temporary).map_err(io(shown))?;
        target.write_all(tags).map_err(io(shown))?;
        source.seek(SeekFrom::Start(layout.tags_end)).map_err(io(shown))?;
        io::copy(&mut source, &mut target).map_err(io(shown))?;
        target.sync_all().map_err(io(shown))?;
        let permissions = source.metadata().map_err(io(shown))?.permissions();
        fs::set_permissions(temporary, permissions).map_err(io(shown))?;
    }
    if inspect_path(temporary, shown, Some(""))?.audio_checksum != before {
        return Err(Error::Tags(jackbird_tags::Error::Refused(Refusal::Audio)));
    }
    fs::rename(temporary, path).map_err(io(shown))
}
