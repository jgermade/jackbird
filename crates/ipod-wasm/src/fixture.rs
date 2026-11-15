//! The iPod the web's tests read (`fixtures/ipod/web/`): three songs and one
//! cover, made with `jackbird-ipod`'s own writers, so the repository holds no
//! one's library. The test below checks the files on disk are the ones these
//! writers make; `JACKBIRD_WRITE_FIXTURES=1 cargo test -p jackbird-ipod-wasm`
//! writes them again.

use std::path::PathBuf;

use jackbird_ipod::artwork::{self, ArtworkDb, Thumb};
use jackbird_ipod::cdb;
use jackbird_ipod::chunk::{Body, Chunk};
use jackbird_ipod::song::{Song, mhod_string};

/// The files of the fixture's iPod.
pub struct Files {
    /// `iPod_Control/iTunes/iTunesCDB`.
    pub cdb: Vec<u8>,
    /// The same database, not compressed (not written to disk).
    pub db: Vec<u8>,
    /// `iPod_Control/Artwork/ArtworkDB`.
    pub artwork: Vec<u8>,
    /// `iPod_Control/Artwork/F1010_1.ithmb`.
    pub ithmb: Vec<u8>,
}

fn header(name: &[u8; 4], len: usize, set: impl FnOnce(&mut [u8])) -> Vec<u8> {
    let mut h = vec![0u8; len];
    h[..4].copy_from_slice(name);
    h[4..8].copy_from_slice(&(len as u32).to_le_bytes());
    set(&mut h);
    h
}

fn put(h: &mut [u8], at: usize, bytes: &[u8]) {
    h[at..at + bytes.len()].copy_from_slice(bytes);
}

fn section(kind: u32, list: &[u8; 4], items: Vec<Chunk>) -> Chunk {
    Chunk {
        header: header(b"mhsd", 0x60, |h| put(h, 0x0c, &kind.to_le_bytes())),
        body: Body::Children(vec![Chunk {
            header: header(list, 0x5c, |_| {}),
            body: Body::List(items),
        }]),
    }
}

fn songs() -> Vec<Song> {
    let first = Song {
        pid: -6_450_187_065_278_421_731,
        track_id: 1,
        title: Some("First song".into()),
        artist: Some("The Fixtures".into()),
        album: Some("Fixtures".into()),
        album_artist: Some("The Fixtures".into()),
        genre: Some("Rock".into()),
        kind: "MPEG audio file".into(),
        path: "F00/AAAA.mp3".into(),
        size: 4_000_000,
        length_ms: 197_000,
        bitrate: 192,
        sample_rate: 44_100,
        track_number: 1,
        track_count: 2,
        disc_number: 1,
        disc_count: 1,
        year: 2024,
        artwork_id: Some(100),
        ..Song::default()
    };
    let second = Song {
        pid: 2,
        track_id: 2,
        title: Some("Second song".into()),
        path: "F01/BBBB.mp3".into(),
        track_number: 2,
        ..first.clone()
    };
    let third = Song {
        pid: 3,
        track_id: 3,
        title: Some("Sin carátula \"ni año\"".into()),
        artist: Some("Varios".into()),
        kind: "AAC audio file".into(),
        path: "F02/CCCC.m4a".into(),
        size: 3_000_000,
        length_ms: 120_000,
        compilation: true,
        ..Song::default()
    };
    vec![first, second, third]
}

/// The fixture's files, as the writers make them.
pub fn files() -> Files {
    let songs = songs();
    let mut items: Vec<Chunk> = vec![mhod_string(1, "Test nano")];
    items.extend(songs.iter().map(|s| Chunk {
        header: header(b"mhip", 0x4c, |h| put(h, 0x18, &s.track_id.to_le_bytes())),
        body: Body::Raw(Vec::new()),
    }));
    let master = Chunk {
        header: header(b"mhyp", 0x6c, |h| {
            put(h, 0x0c, &1u32.to_le_bytes());
            put(h, 0x10, &(songs.len() as u32).to_le_bytes());
            h[0x14] = 1;
            put(h, 0x1c, &7u64.to_le_bytes());
        }),
        body: Body::Children(items),
    };
    let database = Chunk {
        header: header(b"mhbd", 0xf4, |h| {
            put(h, 0x0c, &1u32.to_le_bytes());
            put(h, 0x10, &0x75u32.to_le_bytes());
            put(h, 0x14, &2u32.to_le_bytes());
            put(h, 0x18, &0x1122_3344_5566_7788u64.to_le_bytes());
            put(h, 0x30, &3u16.to_le_bytes());
        }),
        body: Body::Children(vec![
            section(1, b"mhlt", songs.iter().map(Song::mhit).collect()),
            section(3, b"mhlp", vec![master]),
        ]),
    };
    let db = database.write().expect("a small database");
    let cdb = cdb::compress(&db, cdb::LEVEL).expect("a small database");

    // One cover, 12 × 9, under a blank row (Apple centres a cover that is not square): a slot of
    // 12 rows of 24 bytes. A gradient, so each pixel differs.
    let (width, shown, row_bytes) = (12u16, 9u16, 24usize);
    let rgb: Vec<u8> = (0..usize::from(width) * usize::from(shown))
        .flat_map(|i| [(i * 2) as u8, (255 - i * 2) as u8, (i * 7 % 256) as u8])
        .collect();
    let mut ithmb = vec![0u8; row_bytes];
    ithmb.extend(artwork::encode(
        &rgb,
        width,
        shown,
        row_bytes,
        row_bytes * usize::from(shown) + row_bytes * 2,
    ));
    assert_eq!(ithmb.len(), 288);
    let thumb = Thumb {
        format: 1010,
        file: ":F1010_1.ithmb".into(),
        offset: 0,
        size: 288,
        height: 10,
        top: 1,
        left: 0,
        width,
    };
    let mut art = ArtworkDb::empty();
    let id = art.add(songs[0].pid, &[thumb]).expect("an image");
    assert_eq!(id, 100);
    art.share(id);
    Files {
        cdb,
        db,
        artwork: art.write().expect("a small database"),
        ithmb,
    }
}

#[test]
fn the_files_on_disk_are_the_writers() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/ipod/web/iPod_Control");
    let files = files();
    let wanted = [
        ("iTunes/iTunesCDB", &files.cdb),
        ("Artwork/ArtworkDB", &files.artwork),
        ("Artwork/F1010_1.ithmb", &files.ithmb),
    ];
    let write = std::env::var_os("JACKBIRD_WRITE_FIXTURES").is_some();
    for (path, bytes) in wanted {
        let path = root.join(path);
        if write {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, bytes).unwrap();
        }
        let on_disk = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert!(
            on_disk == *bytes,
            "{} is not what the writers make: run JACKBIRD_WRITE_FIXTURES=1 cargo test -p jackbird-ipod-wasm",
            path.display()
        );
    }
}
