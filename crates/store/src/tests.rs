//! The library on the shared fixtures: importing a folder and the same audio again, with the same
//! tags and with others; layers saved, refused, and written into what leaves (read back by the
//! engine, the audio unchanged, ranges across the head and the blob); the library as a root:
//! walk, list, stat, rename, delete, small files; uploads moved in.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use jackbird_tags::{Cover, CoverEdit, Edit, FIRST_HEAD, Layout, TAIL_LEN};

use super::*;

pub(super) fn scratch() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let path = std::env::temp_dir().join(format!(
        "jackbird-store-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

pub(super) fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tags")
}

/// A fixture with its audio made its own: the fixtures of one format share their audio, and the
/// library keeps one audio once. `n` bytes more at its end are more audio.
fn distinct(name: &str, to: &std::path::Path, n: usize) {
    let mut bytes = fs::read(fixtures().join(name)).unwrap();
    bytes.extend(std::iter::repeat_n(0x55, n));
    fs::write(to, bytes).unwrap();
}

/// A folder of the machine with four songs of different audio, one in a subfolder.
pub(super) fn music() -> PathBuf {
    let folder = scratch();
    fs::create_dir_all(folder.join("Disc 2")).unwrap();
    for name in ["mp3-v24-padded.mp3", "flac-full.flac"] {
        fs::copy(fixtures().join(name), folder.join(name)).unwrap();
    }
    distinct("mp3-v23-utf16.mp3", &folder.join("mp3-v23-utf16.mp3"), 32);
    distinct("flac-no-padding.flac", &folder.join("Disc 2/flac-no-padding.flac"), 32);
    fs::write(folder.join("notes.txt"), "not a song").unwrap();
    folder
}

/// A file's tags and audio region, read whole.
pub(super) fn read_back(bytes: &[u8]) -> (jackbird_tags::Tags, Vec<u8>) {
    let tail = &bytes[bytes.len().saturating_sub(TAIL_LEN)..];
    let head = &bytes[..bytes.len().min(FIRST_HEAD.max(bytes.len()))];
    let Layout::Known(layout) = jackbird_tags::layout(head, tail, bytes.len() as u64).unwrap() else {
        panic!("no layout")
    };
    let tags = jackbird_tags::read_head(bytes, &layout).unwrap();
    (
        tags,
        bytes[layout.audio.start as usize..layout.audio.end as usize].to_vec(),
    )
}

pub(super) fn whole(out: &Outgoing) -> Vec<u8> {
    out.read(0, out.len()).unwrap()
}

#[test]
fn a_folder_is_imported_and_the_same_audio_is_not_stored_twice() {
    let library = Library::open(&scratch()).unwrap();
    let folder = music();
    let mut steps = Vec::new();
    let report = library
        .import_folder(&folder, "Music", "Owner", None, |done, total| steps.push((done, total)))
        .unwrap();
    assert_eq!(report.added, 4);
    assert_eq!(steps.last(), Some(&(4, 4)));
    let paths: Vec<String> = library.songs().unwrap().into_iter().map(|song| song.path).collect();
    assert!(
        paths.contains(&"Music/Disc 2/flac-no-padding.flac".to_owned()),
        "{paths:?}"
    );
    assert!(!paths.iter().any(|path| path.ends_with(".txt")));
    // The same folder again: nothing new.
    let again = library
        .import_folder(&folder, "Music", "Owner", None, |_, _| {})
        .unwrap();
    assert_eq!((again.added, again.existing), (0, 4));
    // The same audio with another title: a suggestion beside the song, no new song or blob.
    let other = scratch();
    fs::copy(folder.join("mp3-v24-padded.mp3"), other.join("copy.mp3")).unwrap();
    let root = Root::open(&other).unwrap();
    jackbird_core::save(
        &root,
        "copy.mp3",
        &Edit {
            title: Some("Another title".into()),
            ..Edit::default()
        },
    )
    .unwrap();
    let imported = library
        .import_file(&other.join("copy.mp3"), "Elsewhere/copy.mp3", "Luis", None, false)
        .unwrap();
    assert_eq!(imported, Imported::Suggested("Music/mp3-v24-padded.mp3".into()));
    let suggestions = library.suggestions("Music/mp3-v24-padded.mp3").unwrap();
    assert_eq!(suggestions.len(), 1);
    assert_eq!(
        (suggestions[0].fields.title.as_str(), suggestions[0].by.as_str()),
        ("Another title", "Luis")
    );
    // Brought again: one suggestion still.
    library
        .import_file(&other.join("copy.mp3"), "Elsewhere/copy.mp3", "Luis", None, false)
        .unwrap();
    assert_eq!(library.suggestions("Music/mp3-v24-padded.mp3").unwrap().len(), 1);
    assert_eq!(library.songs().unwrap().len(), 4);
    // The source folder is untouched.
    assert_eq!(
        fs::read(folder.join("flac-full.flac")).unwrap(),
        fs::read(fixtures().join("flac-full.flac")).unwrap()
    );
    // Not a song: reported.
    let unreadable = library
        .import_file(&folder.join("notes.txt"), "Music/notes.mp3", "Owner", None, false)
        .unwrap();
    assert!(matches!(unreadable, Imported::Unreadable(_)), "{unreadable:?}");
    assert!(matches!(
        library
            .import_file(&folder.join("notes.txt"), "Music/notes.txt", "Owner", None, false)
            .unwrap(),
        Imported::Unreadable(_)
    ));
}

#[test]
fn a_blob_is_the_file_whole_named_by_its_audio() {
    let dir = scratch();
    let library = Library::open(&dir).unwrap();
    let folder = music();
    library
        .import_folder(&folder, "Music", "Owner", None, |_, _| {})
        .unwrap();
    let song = library.song("Music/flac-full.flac").unwrap();
    let examined = examine(&folder.join("flac-full.flac")).unwrap();
    assert_eq!(song.blob, examined.audio_sha256);
    let blob = dir
        .join("blobs")
        .join(&song.blob[..2])
        .join(&song.blob[2..4])
        .join(format!("{}.flac", song.blob));
    assert_eq!(
        fs::read(blob).unwrap(),
        fs::read(folder.join("flac-full.flac")).unwrap()
    );
    // Untouched, a song leaves as it came.
    let out = library.outgoing("Music/flac-full.flac").unwrap();
    assert_eq!(whole(&out), fs::read(folder.join("flac-full.flac")).unwrap());
    assert_eq!((out.name.as_str(), out.mime), ("flac-full.flac", "audio/flac"));
}

#[test]
fn edits_go_to_the_family_layer_and_leave_with_the_song() {
    let library = Library::open(&scratch()).unwrap();
    let folder = music();
    library
        .import_folder(&folder, "Music", "Owner", None, |_, _| {})
        .unwrap();
    for path in [
        "Music/mp3-v24-padded.mp3",
        "Music/flac-full.flac",
        "Music/mp3-v23-utf16.mp3",
    ] {
        let before = library.inspect(path, None).unwrap();
        let file = library.song(path).unwrap().file;
        let cover = Cover {
            data: vec![0x89, b'P', b'N', b'G', 1, 2, 3],
            mime: "image/png".into(),
        };
        let after = library
            .save(
                path,
                &Edit {
                    title: Some("Family title".into()),
                    album: Some(file.album.clone()),
                    cover: CoverEdit::Set(cover.clone()),
                    ..Edit::default()
                },
            )
            .unwrap();
        let song = library.song(path).unwrap();
        // The album was the file's own: not in the layer.
        assert_eq!(song.family.title.as_deref(), Some("Family title"));
        assert_eq!(song.family.album, None);
        assert_ne!(after.full_checksum, before.full_checksum, "{path}");
        assert_eq!(after.audio_checksum, before.audio_checksum);
        let (fields, shown_cover) = after.tags.clone().unwrap();
        assert_eq!(fields.title, "Family title");
        assert_eq!(fields.artist, file.artist);
        assert_eq!(shown_cover, Some(cover.clone()));
        // Known: no tags read.
        assert!(
            library
                .inspect(path, Some(&after.full_checksum))
                .unwrap()
                .tags
                .is_none()
        );
        // It leaves with them, its audio as it was.
        let out = whole(&library.outgoing(path).unwrap());
        let source = fs::read(folder.join(name_of(path))).unwrap();
        let (tags, audio) = read_back(&out);
        let (_, source_audio) = read_back(&source);
        assert_eq!(tags.fields.title, "Family title", "{path}");
        assert_eq!(tags.fields.album, file.album);
        assert_eq!(tags.cover, Some(cover));
        assert_eq!(audio, source_audio, "{path}");
        // The file's own title back: the layer forgets it; the cover removed.
        library
            .save(
                path,
                &Edit {
                    title: Some(file.title.clone()),
                    cover: CoverEdit::Remove,
                    ..Edit::default()
                },
            )
            .unwrap();
        let song = library.song(path).unwrap();
        assert_eq!(song.family.title, None);
        let (tags, _) = read_back(&whole(&library.outgoing(path).unwrap()));
        assert_eq!(tags.fields.title, file.title);
        // The cover shown is gone; a file with more pictures shows its next one, and the
        // interface sees what leaves.
        assert_ne!(
            tags.cover.as_ref().map(|cover| cover.data.clone()),
            Some(vec![0x89, b'P', b'N', b'G', 1, 2, 3])
        );
        assert_eq!(library.inspect(path, None).unwrap().tags.unwrap().1, tags.cover);
    }
    // What the engine refuses for a file it refuses here, and nothing is saved.
    let before = library.song("Music/mp3-v24-padded.mp3").unwrap();
    let refused = library.save(
        "Music/mp3-v24-padded.mp3",
        &Edit {
            year: Some("not a year".into()),
            ..Edit::default()
        },
    );
    assert!(matches!(refused, Err(Error::Tags(_))), "{refused:?}");
    assert_eq!(library.song("Music/mp3-v24-padded.mp3").unwrap(), before);
    // The source files were never written.
    for name in ["mp3-v24-padded.mp3", "flac-full.flac"] {
        assert_eq!(
            fs::read(folder.join(name)).unwrap(),
            fs::read(fixtures().join(name)).unwrap()
        );
    }
}

#[test]
fn ranges_cross_the_head_and_the_blob() {
    let library = Library::open(&scratch()).unwrap();
    library
        .import_folder(&music(), "Music", "Owner", None, |_, _| {})
        .unwrap();
    library
        .save(
            "Music/flac-full.flac",
            &Edit {
                title: Some("A much longer title than the file had, so the head grows".into()),
                ..Edit::default()
            },
        )
        .unwrap();
    let out = library.outgoing("Music/flac-full.flac").unwrap();
    let all = whole(&out);
    assert_eq!(all.len() as u64, out.len());
    let head = out.head.len() as u64;
    for (start, end) in [
        (0, 10),
        (head - 5, head + 5),
        (head, head + 100),
        (out.len() - 7, out.len()),
        (3, out.len() + 50),
    ] {
        assert_eq!(
            out.read(start, end).unwrap(),
            all[start as usize..end.min(out.len()) as usize],
            "{start}..{end}"
        );
    }
}

#[test]
fn the_library_is_a_root() {
    let library = Library::open(&scratch()).unwrap();
    let folder = music();
    library
        .import_folder(&folder, "Music", "Owner", None, |_, _| {})
        .unwrap();
    // Small files beside the songs.
    library.write(".meta/mp3-manager.json", b"{}").unwrap();
    library.write("Music/mix.m3u", b"#EXTM3U\n").unwrap();
    assert_eq!(library.read("Music/mix.m3u").unwrap(), b"#EXTM3U\n");
    assert!(matches!(library.write("Music/new.mp3", b"x"), Err(Error::Outside(_))));
    assert!(matches!(library.read("Music/flac-full.flac"), Err(Error::Outside(_))));
    assert!(matches!(library.read("../outside"), Err(Error::Outside(_))));
    let walked: Vec<String> = library.walk().unwrap().into_iter().map(|entry| entry.path).collect();
    assert!(walked.contains(&".meta/mp3-manager.json".to_owned()));
    assert!(walked.contains(&"Music/mix.m3u".to_owned()));
    assert!(walked.contains(&"Music/Disc 2/flac-no-padding.flac".to_owned()));
    let top: Vec<(String, bool)> = library
        .list("")
        .unwrap()
        .into_iter()
        .map(|entry| (entry.name, entry.stat.folder))
        .collect();
    assert_eq!(top, [(".meta".to_owned(), true), ("Music".to_owned(), true)]);
    let music: Vec<String> = library
        .list("Music")
        .unwrap()
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    assert!(
        music.contains(&"Disc 2".to_owned())
            && music.contains(&"mix.m3u".to_owned())
            && music.contains(&"flac-full.flac".to_owned())
    );
    assert!(library.stat("Music/Disc 2").unwrap().unwrap().folder);
    assert!(!library.stat("Music/flac-full.flac").unwrap().unwrap().folder);
    assert_eq!(library.stat("Music/nothing.mp3").unwrap(), None);
    // Renaming moves songs in the catalogue, folders included.
    library.rename("Music/flac-full.flac", "Music/Full.flac").unwrap();
    library.rename("Music/Disc 2", "Music/Second disc").unwrap();
    assert!(library.song("Music/Full.flac").is_some());
    assert!(library.song("Music/Second disc/flac-no-padding.flac").is_some());
    assert!(matches!(
        library.rename("Music/Full.flac", "Music/mp3-v24-padded.mp3"),
        Err(Error::Outside(_))
    ));
    // Deleting moves songs to the trash; importing the file again brings it back.
    library.delete("Music/Second disc").unwrap();
    assert!(library.song("Music/Second disc/flac-no-padding.flac").is_none());
    let back = library
        .import_file(
            &folder.join("Disc 2/flac-no-padding.flac"),
            "Again/flac-no-padding.flac",
            "Owner",
            None,
            false,
        )
        .unwrap();
    // In the trash since F4: brought again, it comes back where it was.
    assert_eq!(
        back,
        Imported::Existing("Music/Second disc/flac-no-padding.flac".into())
    );
    assert!(matches!(library.delete("Music/nothing.mp3"), Err(Error::NotFound(_))));
}

#[test]
fn an_upload_is_moved_in() {
    let library = Library::open(&scratch()).unwrap();
    let upload = library.upload_path();
    fs::copy(fixtures().join("mp3-v23-utf16.mp3"), &upload).unwrap();
    assert_eq!(
        library
            .import_file(&upload, "Uploads/Luis/song.mp3", "Luis", None, true)
            .unwrap(),
        Imported::Added("Uploads/Luis/song.mp3".into())
    );
    assert!(!upload.exists());
    // The same again, under the same name: already there, and the upload gone.
    let upload = library.upload_path();
    fs::copy(fixtures().join("mp3-v23-utf16.mp3"), &upload).unwrap();
    assert_eq!(
        library
            .import_file(&upload, "Uploads/Luis/song.mp3", "Luis", None, true)
            .unwrap(),
        Imported::Existing("Uploads/Luis/song.mp3".into())
    );
    assert!(!upload.exists());
    // Another song under a taken name: the next free one.
    let upload = library.upload_path();
    distinct("mp3-v23-utf16.mp3", &upload, 64);
    assert_eq!(
        library
            .import_file(&upload, "Uploads/Luis/song.mp3", "Luis", None, true)
            .unwrap(),
        Imported::Added("Uploads/Luis/song (2).mp3".into())
    );
    assert!(matches!(clean("/abs"), Err(Error::Outside(_))));
    assert_eq!(clean("a//b/./c").unwrap(), "a/b/c");
}

mod own;
mod safety;
