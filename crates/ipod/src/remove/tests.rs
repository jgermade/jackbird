//! Songs taken out of the small iPod of `add`'s tests.

use super::*;
use crate::add::tests::{NOW, counter, ipod, rows, song};
use crate::add::{add, list};
use crate::song::Song;

fn col(t: &Table, c: &str) -> Vec<Value> {
    t.rows.iter().map(|r| t.get(r, c)).collect()
}

#[test]
fn add_then_remove_gives_the_ipod_back() {
    let mut ipod = ipod();
    let mut random = counter();
    add(&mut ipod, song("Kept", "F01/KEEP.mp3"), Some("Mine"), NOW, &mut random).unwrap();
    let before = ipod.clone();
    let other = Song {
        album: Some("Other".into()),
        artist: Some("Someone Else".into()),
        composer: Some("A Composer".into()),
        genre: Some("Jazz".into()),
        ..song("Gone", "F02/GONE.mp3")
    };
    let added = add(&mut ipod, other, Some("Mine"), NOW, &mut random).unwrap();
    let removed = remove(&mut ipod, added.pid).unwrap();
    assert_eq!(
        removed,
        Removed {
            path: Some("F02/GONE.mp3".into()),
            title: Some("Gone".into())
        }
    );
    assert_eq!(ipod.tree.write().unwrap(), before.tree.write().unwrap());
    assert_eq!(ipod.rows, before.rows);
    assert_eq!(remove(&mut ipod, added.pid), Err(RemoveError::NoSong(added.pid)));
}

#[test]
fn a_song_of_an_album_that_stays() {
    let mut ipod = ipod();
    let mut random = counter();
    let a = add(&mut ipod, song("A", "F01/AAAA.mp3"), Some("Mine"), NOW, &mut random).unwrap();
    let b = add(&mut ipod, song("B", "F01/BBBB.mp3"), Some("Mine"), NOW, &mut random).unwrap();
    let c = add(&mut ipod, song("C", "F01/CCCC.mp3"), Some("Mine"), NOW, &mut random).unwrap();
    // The album shows the first song's artwork.
    let library = ipod.rows.iter_mut().find(|r| r.file == "Library.itdb").unwrap();
    let albums = library.table_mut("album").unwrap();
    let art = albums.column("artwork_item_pid").unwrap();
    albums.rows[0][art] = Value::Integer(a.pid);

    remove(&mut ipod, a.pid).unwrap();
    // The album and artist stay, with one song fewer.
    assert_eq!(list(&ipod.tree, SECTION_ALBUMS).len(), 1);
    assert_eq!(list(&ipod.tree, SECTION_ARTISTS).len(), 1);
    assert_eq!(list(&ipod.tree, SECTION_TRACKS).len(), 2);
    let albums = rows(&ipod, "Library.itdb", "album");
    assert_eq!(col(albums, "artwork_item_pid"), [Value::Integer(b.pid)]);
    // The playlists, numbered again from 0, in their order.
    let links = rows(&ipod, "Library.itdb", "item_to_container");
    let mine: Vec<(Value, Value)> = links
        .rows
        .iter()
        .filter(|r| links.get(r, "container_pid") == Value::Integer(88))
        .map(|r| (links.get(r, "item_pid"), links.get(r, "physical_order")))
        .collect();
    assert_eq!(
        mine,
        [
            (Value::Integer(b.pid), Value::Integer(0)),
            (Value::Integer(c.pid), Value::Integer(1))
        ]
    );
    let db = crate::db::parse(&ipod.tree.write().unwrap()).unwrap();
    let counts: Vec<usize> = db.playlists.iter().map(|p| p.track_ids.len()).collect();
    assert_eq!(counts, [2, 2, 0]);
    assert_eq!(db.playlists[1].track_ids, [b.track_id, c.track_id]);
    // Its ranks, again.
    assert_eq!(
        col(rows(&ipod, "Library.itdb", "item"), "title_order"),
        [Value::Integer(100), Value::Integer(200)]
    );
    for (file, table) in [
        ("Library.itdb", "avformat_info"),
        ("Locations.itdb", "location"),
        ("Dynamic.itdb", "item_stats"),
    ] {
        assert_eq!(rows(&ipod, file, table).rows.len(), 2, "{table}");
    }
}

#[test]
fn a_song_in_a_smart_playlist_too() {
    let mut ipod = ipod();
    let mut random = counter();
    let a = add(&mut ipod, song("A", "F01/AAAA.mp3"), None, NOW, &mut random).unwrap();
    // Put it in the smart playlist, as the firmware's list of it would have it.
    let playlists = list_mut(&mut ipod.tree, SECTION_PLAYLISTS, "playlists").unwrap();
    let item = playlists[0]
        .children()
        .iter()
        .find(|c| c.name() == *b"mhip")
        .unwrap()
        .clone();
    let smart = &mut playlists[2];
    smart.children_mut().unwrap().push(item);
    put(&mut smart.header, 0x10, &1u32.to_le_bytes());
    remove(&mut ipod, a.pid).unwrap();
    let db = crate::db::parse(&ipod.tree.write().unwrap()).unwrap();
    assert!(db.playlists.iter().all(|p| p.track_ids.is_empty()));
    assert!(rows(&ipod, "Library.itdb", "item").rows.is_empty());
    assert!(list(&ipod.tree, SECTION_ALBUMS).is_empty());
}
