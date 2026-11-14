//! A small library built here (never the owner's files): written, read back,
//! post-processed with commands shaped like Apple's.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use jackbird_ipod::library::{Command, Rows, Table, Value, strip_post_processed};

use super::*;

fn scratch() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let path = std::env::temp_dir().join(format!(
        "jackbird-ipod-sqlite-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn table(name: &str, columns: &[&str], rows: Vec<Vec<Value>>) -> Table {
    Table {
        name: name.into(),
        columns: columns.iter().map(|c| c.to_string()).collect(),
        rows,
    }
}

fn command(name: &str, sql: &str) -> Command {
    Command {
        name: name.into(),
        sql: sql.into(),
    }
}

/// Two songs, one without an artist, as jackbird would write them before the
/// post-process; and a play count in `Dynamic.itdb`.
fn small() -> Vec<Rows> {
    use Value::{Integer as I, Null, Real as R, Text as T};
    vec![
        Rows {
            file: "Library.itdb".into(),
            tables: vec![
                table(
                    "version_info",
                    &["id", "major", "minor"],
                    vec![vec![I(1), I(1), I(117)]],
                ),
                table(
                    "item",
                    &[
                        "pid",
                        "is_song",
                        "media_kind",
                        "title",
                        "artist",
                        "artist_pid",
                        "album_pid",
                        "genre_id",
                    ],
                    vec![
                        vec![
                            I(1001),
                            I(1),
                            I(1),
                            T("One".into()),
                            T("Someone".into()),
                            I(7),
                            I(70),
                            I(0),
                        ],
                        vec![I(1002), I(1), I(1), T("Two".into()), Null, Null, I(70), I(0)],
                    ],
                ),
                table(
                    "artist",
                    &["pid", "name", "name_order"],
                    vec![vec![I(7), T("Someone".into()), I(100)]],
                ),
                table(
                    "album",
                    &["pid", "name", "artist_pid"],
                    vec![vec![I(70), T("Album".into()), I(7)]],
                ),
                table(
                    "avformat_info",
                    &["item_pid", "sample_rate"],
                    vec![vec![I(1001), R(44100.0)], vec![I(1002), R(48000.0)]],
                ),
            ],
        },
        Rows {
            file: "Dynamic.itdb".into(),
            tables: vec![table(
                "item_stats",
                &["item_pid", "play_count_user"],
                vec![vec![I(1001), I(3)], vec![I(1002), I(0)]],
            )],
        },
    ]
}

/// Commands shaped like Apple's: a column the schema has, an unknown artist,
/// a count, a table and an index made, and one reaching into an attached file.
fn post_process() -> Vec<Command> {
    vec![
        command(
            "AddArtistIsUnknown",
            "ALTER TABLE artist ADD COLUMN is_unknown INTEGER DEFAULT 0;",
        ),
        command(
            "CreateUnknownArtist",
            "INSERT INTO artist (kind, name, name_order, sort_name, is_unknown) SELECT 2, 'Unknown Artist', 4294967295, 'Unknown Artist', 1 FROM item WHERE artist IS NULL GROUP BY artist ;",
        ),
        command(
            "LinkUnknownArtist",
            "UPDATE item SET artist_pid = (SELECT pid FROM artist WHERE is_unknown == 1) WHERE artist_pid IS NULL;",
        ),
        command(
            "PopulateAlbumItemCount",
            "UPDATE album SET item_count = (SELECT COUNT(item.pid) FROM item WHERE item.album_pid == album.pid);",
        ),
        command(
            "CreateTrackSize",
            "CREATE TABLE track_size_calc (pid INTEGER NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (pid), UNIQUE (kind));",
        ),
        command(
            "CreateItemGenreIdIndex",
            "CREATE INDEX item_genre_id_idx ON item (genre_id);",
        ),
        command(
            "UpdatePlayCountUserOriginal",
            "UPDATE item_stats SET play_count_user_original = play_count_user;",
        ),
        command(
            "UpdateDeviceUpdateLevelTo1109",
            "UPDATE version_info SET device_update_level = 1109;",
        ),
    ]
}

fn cell(rows: &[Rows], file: &str, table: &str, column: &str, row: usize) -> Value {
    let t = rows.iter().find(|r| r.file == file).unwrap().table(table).unwrap();
    t.rows[row][t.column(column).unwrap()].clone()
}

#[test]
fn write_then_read() {
    let folder = scratch();
    let failed = write(&folder, &small(), &post_process()).unwrap();
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].name, "AddArtistIsUnknown");
    assert!(failed[0].is_duplicate_column());

    let back = read(&folder).unwrap();
    assert_eq!(back.len(), 5);
    use Value::{Integer as I, Real as R, Text as T};
    // The unknown artist was made, after the one there, and linked.
    assert_eq!(
        cell(&back, "Library.itdb", "artist", "name", 1),
        T("Unknown Artist".into())
    );
    assert_eq!(cell(&back, "Library.itdb", "artist", "pid", 1), I(8));
    assert_eq!(cell(&back, "Library.itdb", "item", "artist_pid", 1), I(8));
    assert_eq!(cell(&back, "Library.itdb", "album", "item_count", 0), I(2));
    assert_eq!(
        cell(&back, "Library.itdb", "version_info", "device_update_level", 0),
        I(1109)
    );
    assert_eq!(
        cell(&back, "Library.itdb", "avformat_info", "sample_rate", 1),
        R(48000.0)
    );
    // Through the attached file.
    assert_eq!(
        cell(&back, "Dynamic.itdb", "item_stats", "play_count_user_original", 0),
        I(3)
    );
    // Columns the rows left out have their defaults.
    assert_eq!(cell(&back, "Library.itdb", "item", "is_movie", 0), I(0));

    // Each file's settings.
    for file in &FILES {
        let db = Connection::open(folder.join(file.name)).unwrap();
        let get = |p: &str| {
            db.query_row(&format!("PRAGMA {p}"), [], |r| r.get::<_, i64>(0))
                .unwrap()
        };
        assert_eq!(get("page_size"), i64::from(file.page_size), "{}", file.name);
        assert_eq!(get("auto_vacuum"), 1, "{}", file.name);
        assert_eq!(get("user_version"), file.user_version, "{}", file.name);
    }
    let db = Connection::open(folder.join("Library.itdb")).unwrap();
    let index: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'item_genre_id_idx'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(index, 1);
    // No journal left behind.
    let names: Vec<String> = std::fs::read_dir(&folder)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 5, "{names:?}");
}

#[test]
fn a_round_trip_gives_the_same_rows() {
    let first = scratch();
    write(&first, &small(), &post_process()).unwrap();
    let mut read_back = read(&first).unwrap();
    let expected = read_back.clone();
    for rows in &mut read_back {
        if rows.file == "Library.itdb" {
            strip_post_processed(rows);
        }
    }
    let second = scratch();
    write(&second, &read_back, &post_process()).unwrap();
    assert_eq!(read(&second).unwrap(), expected);
    for file in &FILES {
        let (a, b) = (
            snapshot(&first.join(file.name)).unwrap(),
            snapshot(&second.join(file.name)).unwrap(),
        );
        assert_eq!(a, b, "{}", file.name);
    }
    let library = snapshot(&first.join("Library.itdb")).unwrap();
    assert!(library.tables.iter().any(|t| t.name == "track_size_calc"));
    assert!(
        library
            .master
            .iter()
            .any(|m| m[1].as_deref() == Some("item_genre_id_idx"))
    );
    assert_eq!(library.pragmas, [26, 4096, 1]);
}

#[test]
fn never_over_a_file_and_never_outside_the_schema() {
    let folder = scratch();
    write(&folder, &[], &[]).unwrap();
    assert!(matches!(write(&folder, &[], &[]), Err(Error::Exists(_))));
    let other = scratch();
    let mut odd = small();
    odd[0].tables.push(table("nothing", &["x"], vec![]));
    assert!(matches!(write(&other, &odd, &[]), Err(Error::Unknown(_))));
    let mut odd = small();
    odd[1].file = "Other.itdb".into();
    assert!(matches!(write(&other, &odd, &[]), Err(Error::Unknown(_))));
    assert_eq!(std::fs::read_dir(&other).unwrap().count(), 0);
}

#[test]
fn a_bad_row_is_an_error() {
    let folder = scratch();
    let mut bad = small();
    bad[0].tables[1].columns[0] = "no_such_column".into();
    assert!(matches!(write(&folder, &bad, &[]), Err(Error::Sqlite(..))));
}
