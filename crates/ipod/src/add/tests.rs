//! Songs added to a small iPod built here: a master playlist, a playlist and
//! a smart one, no song yet.

use super::*;
use crate::library::{Table, columns, schema::FILES};

fn chunk(name: &[u8; 4], header_len: usize, fill: impl FnOnce(&mut [u8]), body: Body) -> Chunk {
    let mut header = vec![0u8; header_len];
    header[..4].copy_from_slice(name);
    header[4..8].copy_from_slice(&(header_len as u32).to_le_bytes());
    fill(&mut header);
    Chunk { header, body }
}

fn section(kind: u32, list_name: &[u8; 4], items: Vec<Chunk>) -> Chunk {
    let list = chunk(list_name, 0x5c, |_| {}, Body::List(items));
    chunk(
        b"mhsd",
        0x60,
        |h| put(h, 0x0c, &kind.to_le_bytes()),
        Body::Children(vec![list]),
    )
}

fn playlist(pid: i64, master: bool, name: &str) -> Chunk {
    chunk(
        b"mhyp",
        0xb8,
        |h| {
            put(h, 0x0c, &1u32.to_le_bytes());
            h[0x14] = u8::from(master);
            put(h, 0x1c, &pid.to_le_bytes());
        },
        Body::Children(vec![mhod_string(1, name)]),
    )
}

pub(crate) fn ipod() -> Ipod {
    let tree = chunk(
        b"mhbd",
        0xf4,
        |h| {
            put(h, 0x10, &0x75u32.to_le_bytes());
            put(h, 0x14, &4u32.to_le_bytes());
        },
        Body::Children(vec![
            section(SECTION_ALBUMS, b"mhla", vec![]),
            section(SECTION_ARTISTS, b"mhli", vec![]),
            section(SECTION_TRACKS, b"mhlt", vec![]),
            section(
                SECTION_PLAYLISTS,
                b"mhlp",
                vec![
                    playlist(77, true, "iPod"),
                    playlist(88, false, "Mine"),
                    playlist(99, false, "Smart"),
                ],
            ),
        ]),
    );
    let rows = FILES
        .iter()
        .map(|f| Rows {
            file: f.name.to_string(),
            tables: f
                .tables
                .iter()
                .map(|(name, _)| Table {
                    name: name.to_string(),
                    columns: columns(name).unwrap().into_iter().map(|(c, _)| c).collect(),
                    rows: vec![],
                })
                .collect(),
        })
        .collect();
    let mut ipod = Ipod { tree, rows };
    let library = ipod.rows.iter_mut().find(|r| r.file == "Library.itdb").unwrap();
    library
        .table_mut("db_info")
        .unwrap()
        .push(&[
            ("pid", Value::Integer(1)),
            ("primary_container_pid", Value::Integer(77)),
        ])
        .unwrap();
    let containers = library.table_mut("container").unwrap();
    for (pid, name, smart) in [(77, "iPod", false), (88, "Mine", false), (99, "Smart", true)] {
        containers
            .push(&[
                ("pid", Value::Integer(pid)),
                ("name", Value::Text(name.into())),
                ("distinguished_kind", Value::Integer(0)),
                ("smart_criteria", if smart { Value::Blob(vec![1]) } else { Value::Null }),
            ])
            .unwrap();
    }
    ipod
}

pub(crate) fn song(title: &str, path: &str) -> Song {
    Song {
        title: Some(title.into()),
        artist: Some("The Someones".into()),
        album: Some("First".into()),
        genre: Some("Rock".into()),
        path: path.into(),
        size: 1000,
        length_ms: 2000,
        samples: 88_200,
        bitrate: 128,
        sample_rate: 44_100,
        ..Song::default()
    }
}

pub(crate) fn counter() -> impl FnMut() -> u64 {
    let mut n = 0x1000u64;
    move || {
        n += 0x1_0001;
        n
    }
}

pub(crate) fn rows<'a>(ipod: &'a Ipod, file: &str, table: &str) -> &'a Table {
    ipod.rows.iter().find(|r| r.file == file).unwrap().table(table).unwrap()
}

pub(crate) const NOW: Stamp = Stamp {
    unix: 1_763_150_000,
    offset: 3600,
};

#[test]
fn a_first_song_then_one_more_on_the_same_album() {
    let mut ipod = ipod();
    let mut random = counter();
    let a = add(&mut ipod, song("Zeta", "F01/AAAA.mp3"), None, NOW, &mut random).unwrap();
    let b = add(&mut ipod, song("Alpha", "F02/BBBB.mp3"), Some("Mine"), NOW, &mut random).unwrap();

    // IDs from one counter, never reused.
    assert!(b.track_id > a.track_id + 1);
    assert_ne!(a.pid, b.pid);
    assert_eq!(a.album_id, b.album_id);
    assert_eq!(a.artist_id, b.artist_id);
    assert_eq!(a.album_pid, b.album_pid);
    assert_eq!(a.genre_id, 1);
    assert_eq!(b.genre_id, 1);
    assert_eq!(a.kind, MP3_KIND);
    assert_eq!(a.added, NOW);
    // Its ID, the one at 0x1F4, then its two playlist items.
    assert_eq!(highest_id(&ipod.tree), b.track_id + 3);

    // One album, one artist, two songs, in the master playlist and in Mine.
    assert_eq!(list(&ipod.tree, SECTION_TRACKS).len(), 2);
    assert_eq!(list(&ipod.tree, SECTION_ALBUMS).len(), 1);
    assert_eq!(list(&ipod.tree, SECTION_ARTISTS).len(), 1);
    let written = ipod.tree.write().unwrap();
    let db = crate::db::parse(&written).unwrap();
    assert_eq!(db.tracks.len(), 2);
    let names: Vec<(Option<&str>, usize)> = db
        .playlists
        .iter()
        .map(|p| (p.name.as_deref(), p.track_ids.len()))
        .collect();
    assert_eq!(names, [(Some("iPod"), 2), (Some("Mine"), 1), (Some("Smart"), 0)]);
    assert_eq!(db.playlists[1].track_ids, [b.track_id]);
    assert_eq!(crate::chunk::parse(&written).unwrap().write().unwrap(), written);
    let album = &list(&ipod.tree, SECTION_ALBUMS)[0];
    assert_eq!(
        strings_of(album),
        [(200, "First".to_string()), (201, "The Someones".to_string())]
    );
    let artist = &list(&ipod.tree, SECTION_ARTISTS)[0];
    assert_eq!(
        strings_of(artist),
        [(300, "The Someones".to_string()), (301, "Someones".to_string())]
    );

    // The rows, ranked.
    let items = rows(&ipod, "Library.itdb", "item");
    assert_eq!(items.rows.len(), 2);
    let col = |t: &Table, c: &str| -> Vec<Value> { t.rows.iter().map(|r| t.get(r, c)).collect() };
    assert_eq!(col(items, "title_order"), [Value::Integer(200), Value::Integer(100)]);
    assert_eq!(col(items, "is_song"), [Value::Integer(1), Value::Integer(1)]);
    let artists = rows(&ipod, "Library.itdb", "artist");
    assert_eq!(col(artists, "sort_name"), [Value::Text("Someones".into())]);
    assert_eq!(col(artists, "name_order"), [Value::Integer(100)]);
    assert_eq!(
        col(rows(&ipod, "Library.itdb", "genre_map"), "genre_order"),
        [Value::Integer(1)]
    );
    assert_eq!(rows(&ipod, "Library.itdb", "location_kind_map").rows.len(), 1);
    assert_eq!(rows(&ipod, "Locations.itdb", "location").rows.len(), 2);
    assert_eq!(rows(&ipod, "Dynamic.itdb", "item_stats").rows.len(), 2);
    let links = rows(&ipod, "Library.itdb", "item_to_container");
    assert_eq!(
        col(links, "container_pid"),
        [Value::Integer(77), Value::Integer(77), Value::Integer(88)]
    );
    assert_eq!(
        col(links, "physical_order"),
        [Value::Integer(0), Value::Integer(1), Value::Integer(0)]
    );
}

#[test]
fn a_new_album_artist_composer_and_genre() {
    let mut ipod = ipod();
    let mut random = counter();
    let a = add(&mut ipod, song("One", "F01/AAAA.mp3"), None, NOW, &mut random).unwrap();
    let other = Song {
        album: Some("Second".into()),
        album_artist: Some("Various".into()),
        composer: Some("Someone".into()),
        genre: Some("Jazz".into()),
        compilation: true,
        ..song("Two", "F03/CCCC.mp3")
    };
    let b = add(&mut ipod, other, None, NOW, &mut random).unwrap();
    assert_ne!(a.album_id, b.album_id);
    assert_ne!(a.artist_id, b.artist_id);
    assert_eq!(b.composer_pid, 1);
    assert_eq!(b.genre_id, 2);
    let albums = list(&ipod.tree, SECTION_ALBUMS);
    assert_eq!(albums.len(), 2);
    assert_eq!(u32_at(&albums[1].header, 0x1c), 0x102);
    assert_eq!(
        strings_of(&albums[1]),
        [(200, "Second".into()), (201, "Various".into()), (202, "Various".into())]
    );
    let albums = rows(&ipod, "Library.itdb", "album");
    let names: Vec<(Value, Value)> = albums
        .rows
        .iter()
        .map(|r| (albums.get(r, "sort_name"), albums.get(r, "name_order")))
        .collect();
    assert_eq!(
        names,
        [
            (Value::Text("First".into()), Value::Integer(100)),
            (Value::Text("Second".into()), Value::Integer(200))
        ]
    );
    let genres = rows(&ipod, "Library.itdb", "genre_map");
    let orders: Vec<Value> = genres.rows.iter().map(|r| genres.get(r, "genre_order")).collect();
    assert_eq!(orders, [Value::Integer(2), Value::Integer(1)]); // Jazz before Rock
}

#[test]
fn playlists_that_cannot_take_a_song() {
    let mut ipod = ipod();
    let before = ipod.tree.clone();
    let mut random = counter();
    assert_eq!(
        add(&mut ipod, song("A", "F01/A.mp3"), Some("Nope"), NOW, &mut random),
        Err(AddError::NoPlaylist("Nope".into()))
    );
    assert_eq!(
        add(&mut ipod, song("A", "F01/A.mp3"), Some("Smart"), NOW, &mut random),
        Err(AddError::SmartPlaylist("Smart".into()))
    );
    assert_eq!(
        add(&mut ipod, song("A", "F01/A.mp3"), Some("iPod"), NOW, &mut random),
        Err(AddError::NoPlaylist("iPod".into()))
    );
    assert_eq!(ipod.tree, before);
    assert!(rows(&ipod, "Library.itdb", "item").rows.is_empty());
}

#[test]
fn an_ipod_without_its_sections() {
    let mut ipod = ipod();
    ipod.tree
        .children_mut()
        .unwrap()
        .retain(|s| kind_of(s) != SECTION_TRACKS);
    let mut random = counter();
    assert_eq!(
        add(&mut ipod, song("A", "F01/A.mp3"), None, NOW, &mut random),
        Err(AddError::Missing("track list"))
    );
}
