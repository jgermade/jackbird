//! Each person's own (F3): their layer over the family's, seen, played and downloaded by them
//! alone, and the switch back to the family's version; favourites, plays and their own playlists
//! in "My playlists"; an import with other tags becoming the importer's layer and a suggestion an
//! editor can apply.

use jackbird_tags::Edit;

use super::*;

const LUIS: i64 = 2;
const ANA: i64 = 3;
const SONG: &str = "Music/flac-full.flac";

fn library() -> (Library, PathBuf) {
    let library = Library::open(&scratch()).unwrap();
    let folder = music();
    library
        .import_folder(&folder, "Music", "Owner", Some(1), |_, _| {})
        .unwrap();
    (library, folder)
}

fn title(library: &Library, viewer: Viewer) -> String {
    library.inspect_as(SONG, None, viewer).unwrap().tags.unwrap().0.title
}

fn retitle(title: &str) -> Edit {
    Edit {
        title: Some(title.into()),
        ..Edit::default()
    }
}

#[test]
fn two_people_see_the_same_song_with_different_titles_and_the_family_version_is_untouched() {
    let (library, _) = library();
    library.save(SONG, &retitle("The family's")).unwrap();
    let mine = library
        .save_as(SONG, &retitle("Luis's own"), Scope::Mine(LUIS))
        .unwrap();
    assert_eq!(mine.tags.unwrap().0.title, "Luis's own");
    assert_eq!(title(&library, Viewer::mine(LUIS)), "Luis's own");
    assert_eq!(title(&library, Viewer::mine(ANA)), "The family's");
    assert_eq!(title(&library, Viewer::of(LUIS, false)), "The family's");
    assert_eq!(title(&library, Viewer::default()), "The family's");
    assert_eq!(
        library.song(SONG).unwrap().family.title.as_deref(),
        Some("The family's")
    );
    // Different checksums for different versions, so the interface reads the tags again.
    let luis = library
        .inspect_as(SONG, None, Viewer::mine(LUIS))
        .unwrap()
        .full_checksum;
    let ana = library.inspect_as(SONG, None, Viewer::mine(ANA)).unwrap().full_checksum;
    assert_ne!(luis, ana);
    // It plays and downloads as each sees it.
    let (tags, audio) = read_back(&whole(&library.outgoing_as(SONG, Viewer::mine(LUIS)).unwrap()));
    let (family, family_audio) = read_back(&whole(&library.outgoing_as(SONG, Viewer::mine(ANA)).unwrap()));
    assert_eq!(
        (tags.fields.title.as_str(), family.fields.title.as_str()),
        ("Luis's own", "The family's")
    );
    assert_eq!(audio, family_audio);
    // The family changes the artist: Luis sees it under his own title.
    library
        .save(
            SONG,
            &Edit {
                artist: Some("The family's artist".into()),
                ..Edit::default()
            },
        )
        .unwrap();
    let seen = library
        .inspect_as(SONG, None, Viewer::mine(LUIS))
        .unwrap()
        .tags
        .unwrap()
        .0;
    assert_eq!(
        (seen.title.as_str(), seen.artist.as_str()),
        ("Luis's own", "The family's artist")
    );
    // His own value back to the family's: the field is forgotten; then the whole layer.
    library
        .save_as(SONG, &retitle("The family's"), Scope::Mine(LUIS))
        .unwrap();
    assert_eq!(library.layers(SONG, Some(LUIS)).unwrap().mine, Layer::default());
    library.save_as(SONG, &retitle("Again his"), Scope::Mine(LUIS)).unwrap();
    library.forget_mine(SONG, LUIS).unwrap();
    assert_eq!(title(&library, Viewer::mine(LUIS)), "The family's");
    // What the engine refuses, it refuses in one's own layer too.
    let refused = library.save_as(
        "Music/mp3-v24-padded.mp3",
        &Edit {
            year: Some("not a year".into()),
            ..Edit::default()
        },
        Scope::Mine(LUIS),
    );
    assert!(matches!(refused, Err(Error::Tags(_))), "{refused:?}");
}

#[test]
fn favourites_and_plays_are_each_ones_and_their_playlists_too() {
    let (library, _) = library();
    library.set_favourite(LUIS, SONG, true).unwrap();
    library.set_favourite(LUIS, "Music/mp3-v24-padded.mp3", true).unwrap();
    library.set_favourite(LUIS, SONG, true).unwrap();
    assert_eq!(library.favourites(LUIS).unwrap(), [SONG, "Music/mp3-v24-padded.mp3"]);
    assert!(library.favourites(ANA).unwrap().is_empty());
    assert!(library.layers(SONG, Some(LUIS)).unwrap().favourite);
    assert!(!library.layers(SONG, Some(ANA)).unwrap().favourite);
    // As a playlist of his own folder, relative to it.
    let luis = Viewer::mine(LUIS);
    let text = String::from_utf8(library.read_as(FAVOURITES, luis).unwrap()).unwrap();
    assert_eq!(text, "#EXTM3U\n../Music/flac-full.flac\n../Music/mp3-v24-padded.mp3\n");
    // Written, it sets them; deleted, it empties them.
    library
        .write_as(
            FAVOURITES,
            b"#EXTM3U\n../Music/mp3-v24-padded.mp3\n../Nowhere/x.mp3\n",
            luis,
        )
        .unwrap();
    assert_eq!(library.favourites(LUIS).unwrap(), ["Music/mp3-v24-padded.mp3"]);
    library.delete_as(FAVOURITES, luis).unwrap();
    assert!(library.favourites(LUIS).unwrap().is_empty());
    library.set_favourite(LUIS, SONG, false).unwrap();

    // Plays: each song once, newest first; read only; deleting it clears them.
    library.played(LUIS, SONG).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    library.played(LUIS, "Music/mp3-v24-padded.mp3").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    library.played(LUIS, SONG).unwrap();
    let played: Vec<String> = library
        .history(LUIS, 10)
        .unwrap()
        .into_iter()
        .map(|(path, _)| path)
        .collect();
    assert_eq!(played, [SONG, "Music/mp3-v24-padded.mp3"]);
    assert!(library.history(ANA, 10).unwrap().is_empty());
    let recent = String::from_utf8(library.read_as(RECENT, luis).unwrap()).unwrap();
    assert!(recent.starts_with("#EXTM3U\n../Music/flac-full.flac\n"), "{recent}");
    assert!(matches!(library.write_as(RECENT, b"x", luis), Err(Error::Outside(_))));
    library.delete_as(RECENT, luis).unwrap();
    assert!(library.history(LUIS, 10).unwrap().is_empty());

    // His own playlists: his alone, beside the library's shared ones.
    library
        .write_as("My playlists/Road.m3u", b"#EXTM3U\n../Music/flac-full.flac\n", luis)
        .unwrap();
    library.write("Music/Shared.m3u", b"#EXTM3U\n").unwrap();
    let his: Vec<String> = library
        .walk_as(luis)
        .unwrap()
        .into_iter()
        .map(|entry| entry.path)
        .collect();
    for path in [FAVOURITES, RECENT, "My playlists/Road.m3u", "Music/Shared.m3u"] {
        assert!(his.contains(&path.to_owned()), "{path} in {his:?}");
    }
    let hers: Vec<String> = library
        .walk_as(Viewer::mine(ANA))
        .unwrap()
        .into_iter()
        .map(|entry| entry.path)
        .collect();
    assert!(!hers.contains(&"My playlists/Road.m3u".to_owned()));
    assert!(hers.contains(&"Music/Shared.m3u".to_owned()));
    let everyone: Vec<String> = library.walk().unwrap().into_iter().map(|entry| entry.path).collect();
    assert!(!everyone.iter().any(|path| is_own(path)));
    let top: Vec<String> = library
        .list_as("", luis)
        .unwrap()
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    assert!(top.contains(&OWN.to_owned()), "{top:?}");
    let own: Vec<String> = library
        .list_as(OWN, luis)
        .unwrap()
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    assert_eq!(own, ["Favourites.m3u", "Recently played.m3u", "Road.m3u"]);
    assert!(library.stat_as("My playlists/Road.m3u", luis).unwrap().is_some());
    assert!(library.stat_as(OWN, luis).unwrap().unwrap().folder);
    library
        .rename_as("My playlists/Road.m3u", "My playlists/Trip.m3u", luis)
        .unwrap();
    assert!(matches!(
        library.read_as("My playlists/Road.m3u", luis),
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        library.rename_as("My playlists/Trip.m3u", "Music/Trip.m3u", luis),
        Err(Error::Outside(_))
    ));
    assert!(matches!(
        library.read_as("My playlists/Trip.m3u", Viewer::default()),
        Err(Error::Outside(_))
    ));
    library.delete_as("My playlists/Trip.m3u", luis).unwrap();
    assert!(matches!(
        library.delete_as("My playlists/Trip.m3u", luis),
        Err(Error::NotFound(_))
    ));
    // Renames and deletes elsewhere are the library's.
    library
        .rename_as("Music/Shared.m3u", "Music/Shared2.m3u", luis)
        .unwrap();
    library.delete_as("Music/Shared2.m3u", luis).unwrap();
}

#[test]
fn an_import_with_other_tags_becomes_the_importers_layer_and_a_suggestion() {
    let (library, folder) = library();
    let other = scratch();
    fs::copy(folder.join("flac-full.flac"), other.join("mine.flac")).unwrap();
    let root = Root::open(&other).unwrap();
    jackbird_core::save(&root, "mine.flac", &retitle("Ana's title")).unwrap();
    let imported = library
        .import_file(
            &other.join("mine.flac"),
            "Uploads/Ana/mine.flac",
            "Ana",
            Some(ANA),
            false,
        )
        .unwrap();
    assert_eq!(imported, Imported::Suggested(SONG.into()));
    assert_eq!(title(&library, Viewer::mine(ANA)), "Ana's title");
    assert_ne!(title(&library, Viewer::mine(LUIS)), "Ana's title");
    let layers = library.layers(SONG, Some(ANA)).unwrap();
    assert_eq!(layers.mine.title.as_deref(), Some("Ana's title"));
    assert_eq!(layers.mine.artist, None, "only what differs");
    let id = layers.suggestions[0].id;
    // An editor applies it: the family's version has it, and Ana's own title is now the family's.
    library.apply_suggestion(SONG, id).unwrap();
    assert_eq!(title(&library, Viewer::mine(LUIS)), "Ana's title");
    assert!(matches!(
        library.apply_suggestion(SONG, id + 100),
        Err(Error::NotFound(_))
    ));
    assert_eq!(library.song_path(library.song(SONG).unwrap().id).as_deref(), Some(SONG));
}
