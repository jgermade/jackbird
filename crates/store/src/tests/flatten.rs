//! Uploads at the root of one's music (2026-11-19, plan E): `@<shelf>/Uploads/<name>/<path>` moved
//! to `@<shelf>/<path>` once, the small files and the playlists with them.

use std::collections::HashMap;

use super::*;
use crate::flatten::{out_of_uploads, rewrite_playlist};

fn add(library: &Library, fixture: &str, extra: usize, path: &str) {
    let source = scratch().join(fixture);
    distinct(fixture, &source, extra);
    let imported = library.import_file(&source, path, "test", Some(1), false).unwrap();
    assert!(matches!(imported, Imported::Added(_)), "{path}: {imported:?}");
}

fn paths(library: &Library) -> Vec<String> {
    library.songs().unwrap().into_iter().map(|song| song.path).collect()
}

#[test]
fn uploads_move_to_their_librarys_root_once() {
    let library = Library::open(&scratch()).unwrap();
    // The owner's music, uploaded under two names (renamed between); Luis's; and what is not an upload.
    add(&library, "flac-full.flac", 1, "@1/Uploads/Papi/Album/a.flac");
    add(&library, "flac-no-padding.flac", 2, "@1/Uploads/Owner/Album/a.flac");
    add(&library, "flac-no-padding.flac", 3, "@1/Uploads/Owner/Other/b.flac");
    add(&library, "mp3-v24-padded.mp3", 4, "@2/Uploads/Luis/x.mp3");
    add(&library, "mp3-v24-padded.mp3", 5, "@1/Music/keep.mp3");
    add(&library, "mp3-v24-padded.mp3", 6, "@1/Uploads/loose.mp3");
    // Small files: a folder's `.meta/` (one already at the root), a playlist beside the songs.
    library
        .write("@1/Uploads/Papi/Album/.meta/snapshot.json", b"papi")
        .unwrap();
    library
        .write("@1/Uploads/Papi/Album/.meta/covers/x.jpg", b"cover")
        .unwrap();
    library
        .write("@1/Uploads/Owner/Album/.meta/snapshot.json", b"owner")
        .unwrap();
    library
        .write(
            "@1/Uploads/Owner/mix.m3u",
            b"#EXTM3U\nAlbum/a.flac\r\nOther/b.flac\nhttp://radio/x\n",
        )
        .unwrap();
    // One's own playlist, in "My playlists".
    library
        .db()
        .execute(
            "insert into own_files (person, path, bytes, changed) values (1, 'My playlists/Mine.m3u', ?1, 0)",
            [b"#EXTM3U\n../Uploads/Papi/Album/a.flac\n../Music/keep.mp3\n../../out.mp3\n".to_vec()],
        )
        .unwrap();

    assert_eq!(library.uploads_to_root().unwrap(), 4);
    assert_eq!(
        paths(&library),
        [
            "@1/Album/a (2).flac",
            "@1/Album/a.flac",
            "@1/Music/keep.mp3",
            "@1/Other/b.flac",
            "@1/Uploads/loose.mp3",
            "@2/x.mp3"
        ]
    );
    // The first by path ("Owner" before "Papi") kept the name; the other got " (2)", and the
    // first `.meta/` to arrive is kept, the second dropped; a picture moved.
    assert_eq!(library.read("@1/Album/.meta/snapshot.json").unwrap(), b"owner");
    assert_eq!(library.read("@1/Album/.meta/covers/x.jpg").unwrap(), b"cover");
    assert_eq!(
        String::from_utf8(library.read("@1/mix.m3u").unwrap()).unwrap(),
        "#EXTM3U\nAlbum/a.flac\r\nOther/b.flac\nhttp://radio/x\n"
    );
    assert!(!library.dir().join("files/@1/Uploads/Owner").exists());
    let own: Vec<u8> = library
        .db()
        .query_row("select bytes from own_files where person = 1", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        String::from_utf8(own).unwrap(),
        "#EXTM3U\n../Album/a (2).flac\n../Music/keep.mp3\n../../out.mp3\n"
    );

    // Once: an `Uploads/<name>/` made later stays.
    add(&library, "mp3-v24-padded.mp3", 7, "@1/Uploads/Later/c.mp3");
    assert_eq!(library.uploads_to_root().unwrap(), 0);
    assert!(library.song("@1/Uploads/Later/c.mp3").is_some());
}

#[test]
fn uploads_wait_for_shelves() {
    let library = Library::open(&scratch()).unwrap();
    add(&library, "mp3-v24-padded.mp3", 1, "Uploads/Ana/a.mp3");
    // No owner yet, so no shelves: nothing moves, and it is not done.
    assert_eq!(library.uploads_to_root().unwrap(), 0);
    library.into_shelves(1).unwrap();
    assert_eq!(library.uploads_to_root().unwrap(), 1);
    assert_eq!(paths(&library), ["@1/a.mp3"]);
}

#[test]
fn playlists_follow_their_songs() {
    assert_eq!(out_of_uploads("Uploads/Ana/x.mp3"), Some("x.mp3"));
    assert_eq!(out_of_uploads("Uploads/x.mp3"), None);
    assert_eq!(out_of_uploads("Music/Uploads/Ana/x.mp3"), None);
    let moved = HashMap::from([("Uploads/Ana/A/x.mp3".to_owned(), "A/x (2).mp3".to_owned())]);
    // From a folder that moves too, and from one that stays.
    assert_eq!(
        rewrite_playlist("x.mp3\n", "Uploads/Ana/A/list.m3u", "A/list.m3u", &moved).as_deref(),
        Some("x (2).mp3\n")
    );
    assert_eq!(
        rewrite_playlist("../Uploads/Ana/A/x.mp3", "Lists/l.m3u", "Lists/l.m3u", &moved).as_deref(),
        Some("../A/x (2).mp3")
    );
    // Nothing to change.
    assert_eq!(
        rewrite_playlist("#EXTM3U\n../B/y.mp3\n", "Lists/l.m3u", "Lists/l.m3u", &moved),
        None
    );
}
