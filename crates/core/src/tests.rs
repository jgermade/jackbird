//! The core on a temporary folder: paths kept inside their root; the small
//! files; and, on every shared fixture (`fixtures/tags/`), inspections that
//! give `cases.json`'s checksums and tags, and saves that give the same bytes
//! as the engine's whole-file `write`, in place or beside.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use jackbird_tags::{Cover, CoverEdit, Edit, Fields};
use serde_json::Value;
use sha1::{Digest, Sha1};

use crate::*;

/// A new, empty folder for one test.
fn scratch() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let path = std::env::temp_dir().join(format!(
        "jackbird-core-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tags")
}

fn sha1_hex(bytes: &[u8]) -> String {
    Sha1::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

struct Case {
    name: String,
    file: String,
    write: String,
    region_sha1: String,
}

fn cases() -> Vec<Case> {
    let json: Value = serde_json::from_str(&fs::read_to_string(fixtures().join("cases.json")).unwrap()).unwrap();
    json["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| Case {
            name: case["name"].as_str().unwrap().into(),
            file: case["file"].as_str().unwrap().into(),
            write: case["write"].as_str().unwrap().into(),
            region_sha1: case["region"]["sha1"].as_str().unwrap().into(),
        })
        .collect()
}

/// A root holding every fixture.
fn fixture_root() -> (PathBuf, Root) {
    let folder = scratch();
    for case in cases() {
        fs::copy(fixtures().join(&case.file), folder.join(&case.file)).unwrap();
    }
    let root = Root::open(&folder).unwrap();
    (folder, root)
}

// ---------------------------------------------------------------- paths

#[test]
fn paths_stay_inside_their_root() {
    let folder = scratch();
    fs::create_dir_all(folder.join("inside/deeper")).unwrap();
    let root = Root::open(&folder).unwrap();
    assert!(root.resolve("inside/deeper/x.mp3").unwrap().starts_with(root.path()));
    assert!(root.resolve("./inside//x.mp3").is_ok());
    assert_eq!(root.resolve("").unwrap(), root.path());
    for bad in ["..", "../x", "inside/../../x", "/etc/passwd", "inside/..", "a/../b"] {
        assert_eq!(root.resolve(bad).unwrap_err().code(), "outside", "{bad}");
    }
    assert_eq!(Root::open(folder.join("missing")).unwrap_err().code(), "not-found");
    fs::write(folder.join("file"), b"x").unwrap();
    assert_eq!(Root::open(folder.join("file")).unwrap_err().code(), "not-a-folder");
}

#[cfg(unix)]
#[test]
fn a_link_that_leads_out_is_refused_and_not_walked() {
    let outside = scratch();
    fs::write(outside.join("secret.mp3"), b"x").unwrap();
    let folder = scratch();
    std::os::unix::fs::symlink(&outside, folder.join("away")).unwrap();
    std::os::unix::fs::symlink(outside.join("secret.mp3"), folder.join("link.mp3")).unwrap();
    let root = Root::open(&folder).unwrap();
    assert_eq!(root.resolve("away/secret.mp3").unwrap_err().code(), "outside");
    assert_eq!(root.resolve("link.mp3").unwrap_err().code(), "outside");
    assert_eq!(root.read("away/secret.mp3").unwrap_err().code(), "outside");
    assert!(root.walk().unwrap().is_empty());
}

// ---------------------------------------------------------------- small files

#[test]
fn small_files_are_written_read_listed_moved_and_deleted() {
    let folder = scratch();
    let root = Root::open(&folder).unwrap();
    root.write(".meta/mp3-manager.json", b"{}").unwrap();
    assert_eq!(root.read(".meta/mp3-manager.json").unwrap(), b"{}");
    root.write(".meta/mp3-manager.json", b"{\"version\":1}").unwrap();
    assert_eq!(root.read(".meta/mp3-manager.json").unwrap(), b"{\"version\":1}");
    let stat = root.stat(".meta/mp3-manager.json").unwrap().unwrap();
    assert_eq!((stat.folder, stat.size), (false, 13));
    assert!(stat.mtime > 0);
    assert_eq!(root.stat("nothing").unwrap(), None);
    assert!(root.stat(".meta").unwrap().unwrap().folder);

    root.mkdir("Jazz/Miles").unwrap();
    root.write("Jazz/list.m3u8", b"#EXTM3U\n").unwrap();
    root.rename("Jazz/list.m3u8", "Jazz/Miles/Kind of Blue.m3u8").unwrap();
    assert_eq!(root.stat("Jazz/list.m3u8").unwrap(), None);
    let walked: Vec<String> = root.walk().unwrap().into_iter().map(|entry| entry.path).collect();
    assert_eq!(walked, [".meta/mp3-manager.json", "Jazz/Miles/Kind of Blue.m3u8"]);
    let listed: Vec<(String, bool)> = root
        .list("Jazz")
        .unwrap()
        .into_iter()
        .map(|entry| (entry.path, entry.stat.folder))
        .collect();
    assert_eq!(listed, [("Jazz/Miles".to_owned(), true)]);
    root.delete("Jazz/Miles/Kind of Blue.m3u8").unwrap();
    root.delete("Jazz/Miles").unwrap();
    assert_eq!(root.stat("Jazz/Miles").unwrap(), None);
    assert_eq!(root.delete("").unwrap_err().code(), "outside");
    assert_eq!(root.read("gone").unwrap_err().code(), "not-found");
    // No temporary file is left behind.
    assert!(
        fs::read_dir(folder.join(".meta")).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp"))
    );
    assert_eq!(root.name(), folder.file_name().unwrap().to_string_lossy());
}

#[test]
fn base64_both_ways() {
    for bytes in [&b""[..], b"f", b"fo", b"foo", b"foob", &[0, 1, 2, 250, 255]] {
        assert_eq!(base64_decode(&base64_encode(bytes)).unwrap(), bytes);
    }
    assert_eq!(base64_encode(&[0, 1, 2, 250, 255]), "AAEC+v8=");
    assert_eq!(base64_decode("***"), None);
    assert_eq!(base64_decode("A"), None);
}

// ---------------------------------------------------------------- inspect and save

#[test]
fn inspect_gives_each_fixtures_checksums_and_tags() {
    let (folder, root) = fixture_root();
    for case in cases() {
        let bytes = fs::read(folder.join(&case.file)).unwrap();
        let found = inspect(&root, &case.file, None).unwrap();
        assert_eq!(found.full_checksum, sha1_hex(&bytes), "{}", case.name);
        assert_eq!(found.audio_checksum, case.region_sha1, "{}", case.name);
        assert_eq!(found.stat.size, bytes.len() as u64, "{}", case.name);
        let tags = jackbird_tags::read(&bytes).unwrap();
        assert_eq!(found.tags, Some((tags.fields, tags.cover)), "{}", case.name);
        // Its full checksum known: the tags are not read again.
        let again = inspect(&root, &case.file, Some(&found.full_checksum)).unwrap();
        assert_eq!(again.tags, None, "{}", case.name);
    }
}

/// A file already open, as a phone's folders hand theirs over (E6b-D9): the same inspection as by its root.
#[test]
fn inspect_open_reads_a_file_already_open() {
    let (folder, root) = fixture_root();
    for case in cases() {
        let file = fs::File::open(folder.join(&case.file)).unwrap();
        let found = inspect_open(file, &case.file, None).unwrap();
        let expected = inspect(&root, &case.file, None).unwrap();
        assert_eq!(found.full_checksum, expected.full_checksum, "{}", case.name);
        assert_eq!(found.audio_checksum, expected.audio_checksum, "{}", case.name);
        assert_eq!(found.tags, expected.tags, "{}", case.name);
        assert_eq!(found.stat.size, expected.stat.size, "{}", case.name);
    }
}

/// The scan's two halves (the desktop app's tags first, checksums after): together, `inspect`.
#[test]
fn read_tags_and_checksums_are_inspect_in_two() {
    let (_, root) = fixture_root();
    for case in cases() {
        let whole = inspect(&root, &case.file, None).unwrap();
        let tagged = read_tags(&root, &case.file).unwrap();
        let sums = checksums(&root, &case.file).unwrap();
        assert_eq!(Some(tagged.tags), whole.tags, "{}", case.name);
        assert_eq!(tagged.stat.size, whole.stat.size, "{}", case.name);
        assert_eq!(sums.full_checksum, whole.full_checksum, "{}", case.name);
        assert_eq!(sums.audio_checksum, whole.audio_checksum, "{}", case.name);
        assert_eq!(sums.stat.mtime, whole.stat.mtime, "{}", case.name);
    }
}

/// Neither reaches out of its root.
#[test]
fn read_tags_and_checksums_stay_in_their_root() {
    let (_, root) = fixture_root();
    assert!(read_tags(&root, "../outside.mp3").is_err());
    assert!(checksums(&root, "../outside.mp3").is_err());
}

fn cover() -> Cover {
    Cover {
        data: fs::read(fixtures().join("covers/cover9.jpg")).unwrap(),
        mime: "image/jpeg".into(),
    }
}

#[test]
fn save_gives_the_engines_bytes_in_place_or_beside() {
    let edits = [
        Edit {
            title: Some("New title".into()),
            ..Edit::default()
        },
        Edit {
            cover: CoverEdit::Set(cover()),
            ..Edit::all(&Fields {
                title: "Título".into(),
                artist: "Artist B".into(),
                album: "Album B".into(),
                year: "2002".into(),
                genre: "Rock".into(),
                track: "2/3".into(),
                disc: "1/2".into(),
                album_artist: "Various Artists".into(),
                compilation: "1".into(),
            })
        },
        Edit {
            cover: CoverEdit::Remove,
            ..Edit::default()
        },
    ];
    let (mut in_place, mut beside) = (0, 0);
    for edit in &edits {
        let (folder, root) = fixture_root();
        for case in cases() {
            let path = folder.join(&case.file);
            let source = fs::read(&path).unwrap();
            let expected = jackbird_tags::write(&source, edit);
            match save(&root, &case.file, edit) {
                Ok(after) => {
                    let saved = fs::read(&path).unwrap();
                    assert_eq!(Ok(saved.clone()), expected, "{}: {edit:?}", case.name);
                    assert_eq!(after.full_checksum, sha1_hex(&saved), "{}", case.name);
                    assert_eq!(after.audio_checksum, case.region_sha1, "{}", case.name);
                    if saved.len() == source.len() && saved != source {
                        in_place += 1;
                    } else if saved != source {
                        beside += 1;
                    }
                }
                Err(error) => {
                    assert_eq!(
                        Err(error.code()),
                        expected.map_err(|error| error.code()).map(|_| ""),
                        "{}",
                        case.name
                    );
                    assert_eq!(
                        fs::read(&path).unwrap(),
                        source,
                        "{}: a refused save changes nothing",
                        case.name
                    );
                }
            }
        }
        assert!(
            fs::read_dir(&folder)
                .unwrap()
                .all(|entry| !entry.unwrap().file_name().to_string_lossy().ends_with(".tmp")),
            "no temporary file is left"
        );
    }
    assert!(
        in_place > 0 && beside > 0,
        "both routes taken: {in_place} in place, {beside} beside"
    );
}

/// `save_open`, as a phone's folders save (E6b-D9): the same bytes as `save` gives, in place in
/// the file handed over or in the one beside it, and a refusal that changes nothing.
#[test]
fn save_open_gives_what_save_gives() {
    let edits = [
        Edit {
            title: Some("New title".into()),
            ..Edit::default()
        },
        Edit {
            cover: CoverEdit::Set(cover()),
            ..Edit::default()
        },
        Edit {
            cover: CoverEdit::Remove,
            ..Edit::default()
        },
    ];
    let (mut in_place, mut beside_count) = (0, 0);
    for edit in &edits {
        let (folder, _) = fixture_root();
        for case in cases() {
            let path = folder.join(&case.file);
            let source = fs::read(&path).unwrap();
            let expected = jackbird_tags::write(&source, edit);
            let next = folder.join(format!("{}.new", case.file));
            let file = fs::OpenOptions::new().read(true).write(true).open(&path).unwrap();
            let made = || {
                fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .open(&next)
                    .map_err(crate::root::io(&case.file))
            };
            match save_open(file, &case.file, edit, made) {
                Ok(Saved::Done(after)) => {
                    let saved = fs::read(&path).unwrap();
                    assert_eq!(Ok(saved.clone()), expected, "{}: {edit:?}", case.name);
                    assert_eq!(after.full_checksum, sha1_hex(&saved), "{}", case.name);
                    assert_eq!(after.audio_checksum, case.region_sha1, "{}", case.name);
                    assert!(!next.exists(), "{}: nothing beside", case.name);
                    if saved != source {
                        in_place += 1;
                    }
                }
                Ok(Saved::Beside(after)) => {
                    assert_eq!(
                        fs::read(&path).unwrap(),
                        source,
                        "{}: the old file is left whole",
                        case.name
                    );
                    let saved = fs::read(&next).unwrap();
                    assert_eq!(Ok(saved.clone()), expected, "{}: {edit:?}", case.name);
                    assert_eq!(after.full_checksum, sha1_hex(&saved), "{}", case.name);
                    assert_eq!(after.audio_checksum, case.region_sha1, "{}", case.name);
                    assert_eq!(after.stat.size, saved.len() as u64, "{}", case.name);
                    beside_count += 1;
                }
                Err(error) => {
                    assert_eq!(
                        Err(error.code()),
                        expected.map_err(|error| error.code()).map(|_| ""),
                        "{}",
                        case.name
                    );
                    assert_eq!(
                        fs::read(&path).unwrap(),
                        source,
                        "{}: a refused save changes nothing",
                        case.name
                    );
                }
            }
        }
    }
    assert!(
        in_place > 0 && beside_count > 0,
        "both routes taken: {in_place} in place, {beside_count} beside"
    );
}

#[test]
fn a_refused_save_says_why_by_code() {
    let (folder, root) = fixture_root();
    let title = Edit {
        title: Some("New".into()),
        ..Edit::default()
    };
    for case in cases().into_iter().filter(|case| case.write != "ok") {
        assert_eq!(
            save(&root, &case.file, &title).unwrap_err().code(),
            case.write,
            "{}",
            case.name
        );
    }
    fs::write(folder.join("not-audio.mp3"), b"nothing").unwrap();
    assert_eq!(
        save(&root, "not-audio.mp3", &title).unwrap_err().code(),
        "not-supported"
    );
    assert_eq!(save(&root, "../x.mp3", &title).unwrap_err().code(), "outside");
    assert_eq!(inspect(&root, "missing.mp3", None).unwrap_err().code(), "not-found");
    let year = Edit {
        year: Some("c. 1959".into()),
        ..Edit::default()
    };
    assert_eq!(
        save(&root, "mp3-v23-padded.mp3", &year).unwrap_err().code(),
        "invalid-year"
    );
}

#[test]
fn a_large_file_is_hashed_by_chunks() {
    let folder = scratch();
    let mut bytes = fs::read(fixtures().join("mp3-v23-padded.mp3")).unwrap();
    let audio_start = jackbird_tags::audio_region(&bytes).start;
    bytes.extend((0..3_000_000u32).map(|n| (n % 251) as u8));
    fs::write(folder.join("long.mp3"), &bytes).unwrap();
    let root = Root::open(&folder).unwrap();
    let found = inspect(&root, "long.mp3", None).unwrap();
    assert_eq!(found.full_checksum, sha1_hex(&bytes));
    assert_eq!(found.audio_checksum, sha1_hex(&bytes[audio_start..]));
    let path: &Path = &folder.join("long.mp3");
    let after = save(
        &root,
        "long.mp3",
        &Edit {
            title: Some("Long".into()),
            ..Edit::default()
        },
    )
    .unwrap();
    assert_eq!(after.audio_checksum, found.audio_checksum);
    assert_eq!(fs::read(path).unwrap().len(), bytes.len());
}
