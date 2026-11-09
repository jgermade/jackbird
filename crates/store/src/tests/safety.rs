//! Safety (F4): stale saves and writes refused, the trash, snapshots and their rotation, the
//! scrub, the export.

use jackbird_tags::Edit;

use super::*;
use crate::safety::{civil, days_of, today};

const SONG: &str = "Music/flac-full.flac";

fn library() -> (Library, PathBuf) {
    let dir = scratch();
    let library = Library::open(&dir).unwrap();
    library
        .import_folder(&music(), "Music", "Owner", Some(1), |_, _| {})
        .unwrap();
    (library, dir)
}

fn retitle(title: &str) -> Edit {
    Edit {
        title: Some(title.into()),
        ..Edit::default()
    }
}

#[test]
fn a_save_against_an_old_version_is_refused_and_shows_the_new_one() {
    let (library, _) = library();
    let family = Viewer::default();
    let read = library.inspect_as(SONG, None, family).unwrap().full_checksum;
    let Saved::Done(first) = library
        .save_checked(SONG, &retitle("Luis's"), Scope::Family, family, Some(&read), "Luis")
        .unwrap()
    else {
        panic!("refused")
    };
    // Ana read before Luis saved: refused, with the song as it is now and who changed it.
    let Saved::Stale(stale) = library
        .save_checked(SONG, &retitle("Ana's"), Scope::Family, family, Some(&read), "Ana")
        .unwrap()
    else {
        panic!("saved over Luis's")
    };
    assert_eq!(stale.by, "Luis");
    assert_eq!(stale.current.full_checksum, first.full_checksum);
    assert_eq!(stale.current.tags.unwrap().0.title, "Luis's");
    assert_eq!(library.song(SONG).unwrap().family.title.as_deref(), Some("Luis's"));
    // With what she has now, it saves.
    assert!(matches!(
        library
            .save_checked(
                SONG,
                &retitle("Ana's"),
                Scope::Family,
                family,
                Some(&first.full_checksum),
                "Ana"
            )
            .unwrap(),
        Saved::Done(_)
    ));
    // One's own version from two devices.
    let mine = Viewer::mine(2);
    let read = library.inspect_as(SONG, None, mine).unwrap().full_checksum;
    library
        .save_checked(SONG, &retitle("Phone"), Scope::Mine(2), mine, Some(&read), "Luis")
        .unwrap();
    assert!(matches!(
        library
            .save_checked(SONG, &retitle("Laptop"), Scope::Mine(2), mine, Some(&read), "Luis")
            .unwrap(),
        Saved::Stale(_)
    ));
    // An editor with their own version saving for everyone: their view is what they read.
    let read = library.inspect_as(SONG, None, mine).unwrap().full_checksum;
    assert!(matches!(
        library
            .save_checked(SONG, &retitle("For all"), Scope::Family, mine, Some(&read), "Luis")
            .unwrap(),
        Saved::Done(_)
    ));
    // Without a version (an older interface): saved as before.
    assert!(matches!(
        library
            .save_checked(SONG, &retitle("Any"), Scope::Family, family, None, "Luis")
            .unwrap(),
        Saved::Done(_)
    ));
}

#[test]
fn a_shared_playlist_changed_since_it_was_read_is_not_written_over() {
    let (library, _) = library();
    library.write("Music/Shared.m3u", b"#EXTM3U\n").unwrap();
    let read = library.stat("Music/Shared.m3u").unwrap().unwrap();
    let viewer = Viewer::mine(2);
    assert!(
        library
            .write_checked(
                "Music/Shared.m3u",
                b"#EXTM3U\n../a.mp3\n",
                viewer,
                Some((read.size, read.mtime))
            )
            .unwrap()
    );
    assert!(
        !library
            .write_checked(
                "Music/Shared.m3u",
                b"#EXTM3U\n../b.mp3\n../c.mp3\n",
                viewer,
                Some((read.size, read.mtime))
            )
            .unwrap()
    );
    assert_eq!(library.read("Music/Shared.m3u").unwrap(), b"#EXTM3U\n../a.mp3\n");
    // A new file, and one's own: written.
    assert!(
        library
            .write_checked("Music/New.m3u", b"#EXTM3U\n", viewer, Some((1, 1)))
            .unwrap()
    );
    assert!(
        library
            .write_checked("My playlists/Mine.m3u", b"#EXTM3U\n", viewer, Some((1, 1)))
            .unwrap()
    );
}

#[test]
fn deleted_songs_wait_in_the_trash_and_go_with_their_blobs() {
    let (library, dir) = library();
    let blob = library.song(SONG).unwrap().blob;
    let blob_file = dir
        .join("blobs")
        .join(&blob[..2])
        .join(&blob[2..4])
        .join(format!("{blob}.flac"));
    library.set_favourite(2, SONG, true).unwrap();
    library.delete_by(SONG, "Luis").unwrap();
    assert!(library.song(SONG).is_none());
    assert!(!library.walk().unwrap().iter().any(|entry| entry.path == SONG));
    assert!(library.favourites(2).unwrap().is_empty());
    let trash = library.trash().unwrap();
    assert_eq!(
        (trash.len(), trash[0].path.as_str(), trash[0].by.as_str()),
        (1, SONG, "Luis")
    );
    // Its place stays its own while it waits.
    assert!(library.rename("Music/mp3-v24-padded.mp3", SONG).is_err());
    // Restored, with its favourite.
    assert_eq!(library.restore(trash[0].id).unwrap(), SONG);
    assert_eq!(library.favourites(2).unwrap(), [SONG]);
    assert!(matches!(library.restore(trash[0].id), Err(Error::NotFound(_))));
    // Not yet 30 days: nothing expires.
    library.delete(SONG).unwrap();
    assert_eq!(library.expire_trash().unwrap(), 0);
    assert!(blob_file.exists());
    // Brought again while in the trash: it comes back.
    let again = library
        .import_file(&fixtures().join("flac-full.flac"), "Again/x.flac", "Ana", None, false)
        .unwrap();
    assert_eq!(again, Imported::Existing(SONG.into()));
    // Emptied: gone from the catalogue, its blob deleted; importing it again adds it anew.
    library.delete(SONG).unwrap();
    assert_eq!(library.empty_trash(None).unwrap(), 1);
    assert!(!blob_file.exists());
    assert!(library.trash().unwrap().is_empty());
    let back = library
        .import_file(&fixtures().join("flac-full.flac"), "Again/x.flac", "Ana", None, false)
        .unwrap();
    assert_eq!(back, Imported::Added("Again/x.flac".into()));
}

#[test]
fn snapshots_are_taken_and_rotated() {
    let (library, _) = library();
    let folder = library.snapshot().unwrap();
    let copy = rusqlite::Connection::open(folder.join("catalogue.db")).unwrap();
    let songs: i64 = copy
        .query_row("select count(*) from songs", [], |row| row.get(0))
        .unwrap();
    assert_eq!(songs, 4);
    assert_eq!(library.backups(), [today()]);
    // Old ones beside it: rotated.
    for name in ["2020-01-01", "2020-01-02", "not-a-date"] {
        fs::create_dir_all(library.backups_dir().join(name)).unwrap();
    }
    let removed = library.rotate_backups().unwrap();
    assert!(removed.is_empty(), "{removed:?}");
    assert_eq!(library.backups().len(), 3);
}

#[test]
fn which_snapshots_are_kept() {
    // Every day of 2025 and the first half of 2026.
    let mut names = Vec::new();
    let mut day = days_of(2025, 1, 1);
    while day <= days_of(2026, 6, 30) {
        let (year, month, date) = civil(day);
        names.push(format!("{year:04}-{month:02}-{date:02}"));
        day += 1;
    }
    let keep = keep_backups(&names);
    // The 7 newest days.
    for name in ["2026-06-30", "2026-06-24"] {
        assert!(keep.contains(&name.to_owned()), "{name}");
    }
    assert!(!keep.contains(&"2026-06-23".to_owned()) || keep.contains(&"2026-06-21".to_owned()));
    // The newest of each of 12 months: the last day of each month back to July 2025.
    for name in ["2026-05-31", "2026-01-31", "2025-07-31"] {
        assert!(keep.contains(&name.to_owned()), "{name}");
    }
    assert!(!keep.contains(&"2025-06-30".to_owned()));
    assert!(keep.len() <= 7 + 4 + 12);
    assert!(keep.len() >= 12);
    assert_eq!(civil(days_of(2024, 2, 29)), (2024, 2, 29));
    assert!(keep_backups(&[]).is_empty());
}

#[test]
fn the_scrub_finds_a_blob_that_changed() {
    let (library, dir) = library();
    assert!(library.scrub(|_, _| {}).unwrap().is_empty());
    let blob = library.song(SONG).unwrap().blob;
    let blob_file = dir
        .join("blobs")
        .join(&blob[..2])
        .join(&blob[2..4])
        .join(format!("{blob}.flac"));
    let mut bytes = fs::read(&blob_file).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    fs::write(&blob_file, bytes).unwrap();
    let mut steps = Vec::new();
    let bad = library.scrub(|done, total| steps.push((done, total))).unwrap();
    assert_eq!(bad, [(blob, vec![SONG.to_owned()])]);
    assert_eq!(steps.last(), Some(&(4, 4)));
}

#[test]
fn the_library_exports_to_a_plain_folder_with_the_familys_tags() {
    let (library, _) = library();
    library.save(SONG, &retitle("A/B: the family's?")).unwrap();
    let to = scratch();
    let mut steps = Vec::new();
    let exported = library.export(&to, |done, total| steps.push((done, total))).unwrap();
    assert_eq!((exported.written, exported.failed.len()), (4, 0));
    assert_eq!(steps.last(), Some(&(4, 4)));
    let song = library.song(SONG).unwrap().fields();
    let number: String = song.track.chars().take_while(char::is_ascii_digit).collect();
    let file = to
        .join(&song.artist)
        .join(&song.album)
        .join(format!("{number:0>2} - A_B_ the family's_.flac"));
    let (tags, _) = read_back(&fs::read(&file).unwrap_or_else(|_| panic!("{} missing", file.display())));
    assert_eq!(tags.fields.title, "A/B: the family's?");
    // The same names twice: the second numbered.
    let all: Vec<PathBuf> = walk_files(&to);
    assert_eq!(all.len(), 4);
}

fn walk_files(folder: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in fs::read_dir(folder).unwrap().flatten() {
        if entry.path().is_dir() {
            out.extend(walk_files(&entry.path()));
        } else {
            out.push(entry.path());
        }
    }
    out
}
