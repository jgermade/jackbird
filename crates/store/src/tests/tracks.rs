//! Every song in one answer (`tracks_as`): each as `inspect_as` finds it for the same person (its
//! checksum, tags, audio and cover, by name), one's own layer seen by them alone, and a cover set
//! in a layer named as the picture itself.

use jackbird_tags::{Cover, CoverEdit, Edit};

use super::*;

const LUIS: i64 = 2;
const SONG: &str = "Music/flac-full.flac";

fn library() -> Library {
    let library = Library::open(&scratch()).unwrap();
    library
        .import_folder(&music(), "Music", "Owner", Some(1), |_, _| {})
        .unwrap();
    library
}

fn listed(library: &Library, viewer: Viewer, path: &str) -> Listed {
    library
        .tracks_as(viewer)
        .unwrap()
        .into_iter()
        .find(|song| song.path == path)
        .unwrap()
}

#[test]
fn every_song_is_listed_as_inspect_finds_it() {
    let library = library();
    let songs = library.tracks_as(Viewer::default()).unwrap();
    assert!(!songs.is_empty());
    assert_eq!(songs.len(), library.songs().unwrap().len());
    let mut covered = 0;
    for song in &songs {
        let found = library.inspect_as(&song.path, None, Viewer::default()).unwrap();
        let (fields, cover) = found.tags.unwrap();
        assert_eq!(song.stat, found.stat, "{}", song.path);
        assert_eq!(song.full_checksum, found.full_checksum, "{}", song.path);
        assert_eq!(song.audio_checksum, found.audio_checksum, "{}", song.path);
        assert_eq!(song.fields, fields, "{}", song.path);
        assert_eq!(song.audio, found.audio, "{}", song.path);
        assert_eq!(song.cover, cover.as_ref().map(Cover::name), "{}", song.path);
        covered += usize::from(song.cover.is_some());
    }
    // The fixtures have pictures: the names are not all none.
    assert!(covered > 0);
    // Listed again, from what was kept: the same.
    assert_eq!(library.tracks_as(Viewer::default()).unwrap(), songs);
}

#[test]
fn ones_own_layer_is_listed_for_them_alone() {
    let library = library();
    library
        .save_as(
            SONG,
            &Edit {
                title: Some("Luis's own".into()),
                ..Edit::default()
            },
            Scope::Mine(LUIS),
        )
        .unwrap();
    let luis = listed(&library, Viewer::mine(LUIS), SONG);
    let family = listed(&library, Viewer::default(), SONG);
    assert_eq!(luis.fields.title, "Luis's own");
    assert_ne!(family.fields.title, "Luis's own");
    // A version of its own, as inspect gives it, so the interface takes the tags again.
    assert_ne!(luis.full_checksum, family.full_checksum);
    assert_eq!(
        luis.full_checksum,
        library
            .inspect_as(SONG, None, Viewer::mine(LUIS))
            .unwrap()
            .full_checksum
    );
}

#[test]
fn a_cover_set_in_a_layer_is_named_as_the_picture() {
    let library = library();
    let picture = Cover {
        data: vec![0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8],
        mime: "image/jpeg".into(),
    };
    library
        .save(
            SONG,
            &Edit {
                cover: CoverEdit::Set(picture.clone()),
                ..Edit::default()
            },
        )
        .unwrap();
    assert_eq!(listed(&library, Viewer::default(), SONG).cover, Some(picture.name()));
    assert_eq!(library.cover_as(SONG, Viewer::default()).unwrap(), Some(picture));
    // Removed: the song shows no picture of that name any more.
    library
        .save(
            SONG,
            &Edit {
                cover: CoverEdit::Remove,
                ..Edit::default()
            },
        )
        .unwrap();
    let after = listed(&library, Viewer::default(), SONG);
    assert_eq!(
        after.cover,
        library
            .cover_as(SONG, Viewer::default())
            .unwrap()
            .as_ref()
            .map(Cover::name)
    );
}
