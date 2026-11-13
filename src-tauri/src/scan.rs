//! Reading a folder's files in bulk, for the interface's opening of a folder (`hydrateRoot` in
//! `src/lib/roots.ts`, through `src/lib/sources/desktop.ts`): in two halves, so the library shows
//! whole at once and the long part comes after.
//!
//! - `scan`: each file's tags, from its head only (no checksum, the audio not read), several files
//!   at a time, sent to the interface in batches over a channel: one call for the whole folder,
//!   not one per file. The tracks hold their cover by reference (`cover_name`); the picture itself
//!   is written into the folder's `.meta/covers/` the first time the scan meets it (unless it is
//!   there), where the interface reads it when it shows it: no picture crosses in the batches, but
//!   one that could not be written there, which goes once.
//! - `checksums`: each file's checksums (the whole file read), the same way, after.
//!
//! See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-14).

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use jackbird_api::{CoverJson, ScannedJson, SumsJson, UnreadJson, scanned};
use jackbird_core::Root;
use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::{Answer, Roots, root_of};

/// How often a batch goes to the interface while the work goes on, at most.
const EVERY: Duration = Duration::from_millis(150);
/// How many files a batch holds at most.
const BATCH: usize = 256;

/// Tags read: the files, the covers that could not be written into `.meta/covers/` (once each),
/// the files that could not be read.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TagsBatch {
    /// The last batch: the interface waits for it, not for the command's answer (which can come first).
    done: bool,
    tracks: Vec<ScannedJson>,
    covers: Vec<CoverJson>,
    unread: Vec<UnreadJson>,
}

/// Checksums worked out, and the files that could not be read.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SumsBatch {
    /// The last batch, as [`TagsBatch`]'s.
    done: bool,
    sums: Vec<SumsJson>,
    unread: Vec<UnreadJson>,
}

/// Runs `work` on each of `paths` on `threads` threads, handing each result to `take` on this
/// thread as it comes, into `batch`, and `flush` every [`EVERY`] or [`BATCH`] results, and at the
/// end (`true`).
fn in_parallel<R: Send, B>(
    paths: Vec<String>,
    threads: usize,
    work: impl Fn(&str) -> R + Sync,
    batch: &mut B,
    mut take: impl FnMut(&mut B, String, R),
    mut flush: impl FnMut(&mut B, bool),
) {
    let next = AtomicUsize::new(0);
    let (send, receive) = mpsc::channel::<(usize, R)>();
    thread::scope(|scope| {
        for _ in 0..threads.max(1).min(paths.len().max(1)) {
            let send = send.clone();
            let (next, paths, work) = (&next, &paths, &work);
            scope.spawn(move || {
                loop {
                    let at = next.fetch_add(1, Ordering::Relaxed);
                    let Some(path) = paths.get(at) else { break };
                    if send.send((at, work(path))).is_err() {
                        break;
                    }
                }
            });
        }
        drop(send);
        let (mut held, mut since) = (0, Instant::now());
        for (at, result) in receive {
            take(batch, paths[at].clone(), result);
            held += 1;
            if held >= BATCH || (held > 0 && since.elapsed() >= EVERY) {
                flush(batch, false);
                held = 0;
                since = Instant::now();
            }
        }
    });
    flush(batch, true);
}

/// How many files are read at once: the machine's cores, between 2 and 8.
fn threads() -> usize {
    thread::available_parallelism().map_or(4, |count| count.get().clamp(2, 8))
}

/// Where a folder keeps its covers, by name (`src/lib/covers.ts`'s `COVERS_DIR`).
const COVERS_DIR: &str = ".meta/covers";

/// The tags of `paths` under `root`, in batches over `channel`; each cover met for the first time
/// written into `.meta/covers/`, or sent when it cannot be; `known_covers` are the covers' names
/// the interface has already, neither written nor sent.
pub fn scan_tags(root: &Root, paths: Vec<String>, known_covers: Vec<String>, channel: &Channel<TagsBatch>) {
    let mut sent: HashSet<String> = known_covers.into_iter().collect();
    let mut batch = TagsBatch::default();
    in_parallel(
        paths,
        threads(),
        |path| jackbird_core::read_tags(root, path),
        &mut batch,
        |batch, path, result| match result {
            Ok(tagged) => {
                let (json, cover) = scanned(path, tagged);
                if let Some((name, cover)) = cover
                    && sent.insert(name.clone())
                {
                    let at = format!("{COVERS_DIR}/{name}");
                    let kept = matches!(root.stat(&at), Ok(Some(_))) || root.write(&at, &cover.data).is_ok();
                    if !kept {
                        batch.covers.push(CoverJson {
                            name,
                            data: jackbird_core::base64_encode(&cover.data),
                        });
                    }
                }
                batch.tracks.push(json);
            }
            Err(error) => batch.unread.push(UnreadJson {
                path,
                message: error.to_string(),
            }),
        },
        |batch, done| {
            batch.done = done;
            let _ = channel.send(std::mem::take(batch));
        },
    );
}

/// The checksums of `paths` under `root`, in batches over `channel`.
pub fn scan_sums(root: &Root, paths: Vec<String>, channel: &Channel<SumsBatch>) {
    let mut batch = SumsBatch::default();
    // Fewer at once than the tags: this reads whole files, and a disk serves a few streams best.
    in_parallel(
        paths,
        threads().min(4),
        |path| jackbird_core::checksums(root, path),
        &mut batch,
        |batch, path, result| match result {
            Ok(sums) => batch.sums.push(SumsJson::of(path, sums)),
            Err(error) => batch.unread.push(UnreadJson {
                path,
                message: error.to_string(),
            }),
        },
        |batch, done| {
            batch.done = done;
            let _ = channel.send(std::mem::take(batch));
        },
    );
}

/// The tags of a folder's files, in batches (the module's doc). Resolves once every batch is sent.
#[tauri::command]
pub async fn scan(
    roots: State<'_, Roots>,
    root: String,
    paths: Vec<String>,
    known_covers: Vec<String>,
    channel: Channel<TagsBatch>,
) -> Answer<()> {
    let root = root_of(&roots, &root)?;
    tauri::async_runtime::spawn_blocking(move || scan_tags(&root, paths, known_covers, &channel))
        .await
        .map_err(|error| jackbird_api::failure("io", error.to_string()))
}

/// The checksums of a folder's files, in batches (the module's doc). Resolves once every batch is sent.
#[tauri::command]
pub async fn checksums(
    roots: State<'_, Roots>,
    root: String,
    paths: Vec<String>,
    channel: Channel<SumsBatch>,
) -> Answer<()> {
    let root = root_of(&roots, &root)?;
    tauri::async_runtime::spawn_blocking(move || scan_sums(&root, paths, &channel))
        .await
        .map_err(|error| jackbird_api::failure("io", error.to_string()))
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::atomic::AtomicUsize as Counter;
    use std::sync::{Arc, Mutex};

    use serde_json::Value;
    use tauri::ipc::InvokeResponseBody;

    use super::*;

    /// A channel that keeps what it is sent, as JSON.
    fn kept<T: tauri::ipc::IpcResponse>() -> (Channel<T>, Arc<Mutex<Vec<Value>>>) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let into = sent.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                into.lock().unwrap().push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, sent)
    }

    const PATHS: [&str; 5] = [
        "mp3-v23-padded.mp3",
        "mp3-v24-padded.mp3",
        "mp3-v22.mp3",
        "mp3-no-tag.mp3",
        "gone.mp3",
    ];

    /// A copy of a few fixtures in a folder of its own (the scan writes into `.meta/covers/`).
    fn fixtures() -> Root {
        static NEXT: Counter = Counter::new(0);
        let at = std::env::temp_dir().join(format!(
            "jackbird-scan-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&at);
        std::fs::create_dir_all(&at).unwrap();
        let from = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/tags");
        for path in PATHS.iter().filter(|path| **path != "gone.mp3") {
            std::fs::copy(from.join(path), at.join(path)).unwrap();
        }
        Root::open(at.to_str().unwrap()).unwrap()
    }

    fn all(sent: &[Value], key: &str) -> Vec<Value> {
        sent.iter()
            .flat_map(|batch| batch[key].as_array().unwrap().clone())
            .collect()
    }

    /// The covers' names the tracks refer to.
    fn names(tracks: &[Value]) -> HashSet<String> {
        tracks
            .iter()
            .filter_map(|track| track["metadata"]["coverDataUrl"].as_str())
            .map(|cover| cover.strip_prefix("jackbird-cover:").unwrap().to_string())
            .collect()
    }

    #[test]
    fn scan_sends_each_files_tags_and_writes_each_cover_once() {
        let root = fixtures();
        let (channel, sent) = kept::<TagsBatch>();
        scan_tags(&root, PATHS.map(String::from).to_vec(), Vec::new(), &channel);
        let sent = sent.lock().unwrap();
        assert_eq!(sent.last().unwrap()["done"], true);
        assert_eq!(sent.iter().filter(|batch| batch["done"] == true).count(), 1);
        let tracks = all(&sent, "tracks");
        assert_eq!(tracks.len(), 4);
        let untagged = tracks.iter().find(|track| track["path"] == "mp3-no-tag.mp3").unwrap();
        assert_eq!(untagged["metadata"]["coverDataUrl"], Value::Null);
        // Two files share a picture, another has its own: two pictures, written, none sent.
        let names = names(&tracks);
        assert_eq!(names.len(), 2);
        assert!(all(&sent, "covers").is_empty());
        for name in &names {
            let written = root.read(&format!("{COVERS_DIR}/{name}")).unwrap();
            assert!(name.ends_with(&format!("-{:x}.jpg", written.len())), "{name}");
        }
        let unread = all(&sent, "unread");
        assert_eq!(unread.len(), 1);
        assert_eq!(unread[0]["path"], "gone.mp3");
    }

    #[test]
    fn scan_neither_writes_nor_sends_a_cover_the_interface_has() {
        let (channel, sent) = kept::<TagsBatch>();
        scan_tags(&fixtures(), PATHS.map(String::from).to_vec(), Vec::new(), &channel);
        let known: Vec<String> = names(&all(&sent.lock().unwrap(), "tracks")).into_iter().collect();
        let fresh = fixtures();
        let (channel, sent) = kept::<TagsBatch>();
        scan_tags(&fresh, PATHS.map(String::from).to_vec(), known.clone(), &channel);
        assert!(all(&sent.lock().unwrap(), "covers").is_empty());
        for name in &known {
            assert_eq!(fresh.stat(&format!("{COVERS_DIR}/{name}")).unwrap(), None);
        }
    }

    /// Where the folder cannot be written, a cover goes in the batch, once.
    #[cfg(unix)]
    #[test]
    fn scan_sends_a_cover_it_cannot_write() {
        use std::os::unix::fs::PermissionsExt;
        let root = fixtures();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        let (channel, sent) = kept::<TagsBatch>();
        scan_tags(&root, PATHS.map(String::from).to_vec(), Vec::new(), &channel);
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let sent = sent.lock().unwrap();
        // As root, a folder is written whatever its mode: nothing to check then.
        if root.stat(COVERS_DIR).unwrap().is_none() {
            let covers: HashSet<String> = all(&sent, "covers")
                .iter()
                .map(|one| one["name"].as_str().unwrap().to_string())
                .collect();
            assert_eq!(covers.len(), 2);
            assert_eq!(names(&all(&sent, "tracks")), covers);
        }
    }

    #[test]
    fn checksums_are_inspects() {
        let root = fixtures();
        let (channel, sent) = kept::<SumsBatch>();
        scan_sums(&root, PATHS.map(String::from).to_vec(), &channel);
        let sent = sent.lock().unwrap();
        assert_eq!(sent.last().unwrap()["done"], true);
        let sums = all(&sent, "sums");
        assert_eq!(sums.len(), 4);
        for sum in sums {
            let whole = jackbird_core::inspect(&root, sum["path"].as_str().unwrap(), None).unwrap();
            assert_eq!(sum["fullChecksum"], whole.full_checksum.as_str());
            assert_eq!(sum["audioChecksum"], whole.audio_checksum.as_str());
            assert_eq!(sum["size"], whole.stat.size);
        }
        assert_eq!(all(&sent, "unread").len(), 1);
    }

    #[test]
    fn nothing_to_read_still_sends_the_last_batch() {
        let (channel, sent) = kept::<TagsBatch>();
        scan_tags(&fixtures(), Vec::new(), Vec::new(), &channel);
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["done"], true);
    }
}
