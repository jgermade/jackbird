//! The iPod in the desktop app (the panel, `RECORD/2026-11-14.ipod-sync.WIP.md`): the iPods
//! mounted here, one opened as a root whose songs come from its database, songs sent to it from
//! the app's folders and taken off it, over `jackbird-ipod-sync`. The interface's side is
//! `src/lib/sources/ipod.ts`.

use std::path::{Path, PathBuf};

use jackbird_api::{AudioJson, CoverJson, Failure, Metadata, Opened, ScannedJson, cover_ref, failure};
use jackbird_ipod_sync::listing::{self, Found};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{Answer, Roots, register, root_of};

/// An iPod mounted on this machine.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpodJson {
    /// Its mount point: the root's path once opened.
    path: String,
    /// Its name (its master playlist's).
    name: String,
    /// Whether jackbird can send songs to it.
    writable: bool,
    /// Why not, when it cannot.
    reason: Option<String>,
    /// Whether it lacks only its `SysInfoExtended`, which the app can read over USB.
    needs_sysinfo: bool,
}

fn json(found: Found) -> IpodJson {
    let reason = found.writable.err();
    IpodJson {
        path: found.root.to_string_lossy().into_owned(),
        name: found.name,
        writable: reason.is_none(),
        needs_sysinfo: reason.as_deref().is_some_and(|r| r.contains("SysInfoExtended")),
        reason,
    }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Answer<T> + Send + 'static) -> Answer<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| failure("io", error.to_string()))?
}

/// `path` if it is a mounted iPod's root; refused otherwise, so that these commands only ever
/// write to an iPod.
fn ipod_at(path: &str) -> Answer<PathBuf> {
    let root = PathBuf::from(path);
    if listing::find_in([root.clone()]).is_empty() {
        return Err(failure("outside", format!("{path:?} is not an iPod")));
    }
    Ok(root)
}

fn sync_failure(error: jackbird_ipod_sync::Error) -> Failure {
    failure("ipod", error.0)
}

/// The iPods mounted on this machine.
#[tauri::command]
pub async fn ipods() -> Answer<Vec<IpodJson>> {
    blocking(|| Ok(listing::find_ipods().into_iter().map(json).collect())).await
}

/// The mount points that hold an iPod, looked at cheaply: the interface asks every few seconds,
/// and reads the iPods again (`ipods`) when they change.
#[tauri::command]
pub async fn ipod_mounts() -> Answer<Vec<String>> {
    blocking(|| {
        Ok(listing::ipod_mounts()
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect())
    })
    .await
}

/// What the iPod's foot and sheet show beside its songs (W5, `RECORD/2026-11-14.ipod-sync.WIP.md`):
/// what it says of itself, its database's checksum scheme, and its drive's size and free space.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpodInfoJson {
    model_number: Option<String>,
    family_id: Option<String>,
    firmware: Option<String>,
    serial: Option<String>,
    rockbox: Option<String>,
    checksum: Option<u16>,
    total: Option<u64>,
    free: Option<u64>,
    artwork_bytes: Option<u64>,
    photo_bytes: Option<u64>,
    rockbox_bytes: Option<u64>,
}

/// [`IpodInfoJson`] of the iPod at `path`.
#[tauri::command]
pub async fn ipod_info(path: String) -> Answer<IpodInfoJson> {
    let root = ipod_at(&path)?;
    blocking(move || {
        let info = listing::info(&root);
        Ok(IpodInfoJson {
            model_number: info.facts.model_number,
            family_id: info.facts.family_id,
            firmware: info.facts.firmware,
            serial: info.facts.serial,
            rockbox: info.facts.rockbox,
            checksum: info.checksum,
            total: info.space.map(|s| s.total),
            free: info.space.map(|s| s.free),
            artwork_bytes: Some(info.content.artwork),
            photo_bytes: Some(info.content.photos),
            rockbox_bytes: Some(info.content.rockbox),
        })
    })
    .await
}

/// Ejects an iPod (W6, `RECORD/2026-11-14.ipod-sync.WIP.md`): the interface closes its root
/// first, then the system is asked to eject its drive; the error is what the system said.
#[tauri::command]
pub async fn ipod_eject(path: String) -> Answer<()> {
    let root = ipod_at(&path)?;
    blocking(move || listing::eject(&root).map_err(|why| failure("eject", why))).await
}

/// Opens an iPod as a root (its files reachable for playing, as a folder's).
#[tauri::command]
pub fn ipod_open(app: AppHandle, path: String) -> Answer<Opened> {
    ipod_at(&path)?;
    register(&app, &path)
}

/// The songs of an iPod, as the interface's scan gives a folder's, with their covers (each
/// image once, unless the interface has it already).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpodTracks {
    tracks: Vec<ScannedJson>,
    covers: Vec<CoverJson>,
    /// Each song's pid, by its path, to take it off: as text, since a 64-bit integer does not
    /// survive JavaScript's numbers.
    pids: Vec<(String, String)>,
}

/// A number as the interface's fields hold it: `n`, `n/total`, or nothing for 0.
fn numbered(n: u32, total: u32) -> String {
    match (n, total) {
        (0, _) => String::new(),
        (n, 0) => n.to_string(),
        (n, total) => format!("{n}/{total}"),
    }
}

/// The name a cover of image `id` on the iPod at `root` goes by: unique to that iPod, and shaped
/// as the interface's cover names are (`helpers/cover.ts`: sixteen hex digits, a dash, hex digits
/// and the type's extension), which it checks before it takes a reference: the iPod's path hashed
/// twice (FNV-1a, two seeds), then the image's ID.
fn cover_name(root: &Path, id: u32) -> String {
    let path = root.to_string_lossy();
    let hash = |seed: u32| {
        path.bytes()
            .fold(seed, |h, b| (h ^ u32::from(b)).wrapping_mul(0x0100_0193))
    };
    format!(
        "{:08x}{:08x}-{id:x}.png",
        hash(0x811c_9dc5),
        hash(0x0100_0193 ^ 0x6970_6f64)
    )
}

/// The songs of the iPod at `path`, from its database.
#[tauri::command]
pub async fn ipod_tracks(path: String, known_covers: Vec<String>) -> Answer<IpodTracks> {
    let root = ipod_at(&path)?;
    blocking(move || tracks_of(&root, &known_covers)).await
}

/// [`ipod_tracks`]'s work: the songs of the iPod at `root`, and the covers not in `known_covers`.
fn tracks_of(root: &Path, known_covers: &[String]) -> Answer<IpodTracks> {
    {
        let root = root.to_path_buf();
        let listing = listing::list(&root).map_err(sync_failure)?;
        let mut images = listing::Covers::open(&root);
        let mut covers = Vec::new();
        let mut sent = std::collections::HashSet::new();
        let mut tracks = Vec::new();
        let mut pids = Vec::new();
        for song in listing.songs {
            let t = &song.track;
            let cover = t.artwork_id.map(|id| {
                let name = cover_name(&root, id);
                if !known_covers.contains(&name)
                    && sent.insert(name.clone())
                    && let Some(png) = images.png(id)
                {
                    covers.push(CoverJson {
                        name: name.clone(),
                        data: base64(&png),
                    });
                }
                cover_ref(&name)
            });
            let text = |s: &Option<String>| s.clone().unwrap_or_default();
            pids.push((song.path.clone(), (t.database_id as i64).to_string()));
            tracks.push(ScannedJson {
                path: song.path,
                size: u64::from(t.size),
                last_modified: 0,
                metadata: Metadata {
                    title: text(&t.title),
                    artist: text(&t.artist),
                    album: text(&t.album),
                    year: if t.year == 0 { String::new() } else { t.year.to_string() },
                    genre: text(&t.genre),
                    track_number: numbered(t.track_number, t.track_count),
                    disc_number: numbered(t.disc_number, t.disc_count),
                    album_artist: text(&t.album_artist),
                    compilation: if t.compilation { "1".into() } else { String::new() },
                    composer: text(&t.composer),
                    // Its database keeps no comment jackbird reads.
                    comment: String::new(),
                    // The iPod's database has no lyrics (they live in the file's tags).
                    lyrics: String::new(),
                    bpm: if t.bpm == 0 { String::new() } else { t.bpm.to_string() },
                    cover_data_url: cover,
                },
                // Its length and bit rate as its database keeps them; no sample rate there.
                audio: (t.length_ms > 0).then_some(AudioJson {
                    duration_ms: t.length_ms,
                    bitrate: t.bitrate,
                    sample_rate: 0,
                    channels: 0,
                    bits: 0,
                    vbr: false,
                }),
            });
        }
        Ok(IpodTracks { tracks, covers, pids })
    }
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[(n >> (18 - 6 * i) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Where the installed service keeps its configuration, as `jackbird-service` finds it
/// (`crates/service/src/config.rs`, `default_path`).
fn service_config() -> PathBuf {
    if let Some(path) = std::env::var_os("JACKBIRD_SERVICE_CONFIG") {
        return PathBuf::from(path);
    }
    let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let base = if cfg!(windows) {
        var("APPDATA").unwrap_or_else(|| PathBuf::from("."))
    } else if cfg!(target_os = "macos") {
        var("HOME").map_or_else(|| PathBuf::from("."), |home| home.join("Library/Application Support"))
    } else {
        var("XDG_CONFIG_HOME")
            .unwrap_or_else(|| var("HOME").map_or_else(|| PathBuf::from("."), |home| home.join(".config")))
    };
    base.join("jackbird").join("service.json")
}

/// The folders the installed service serves (its `roots`): when the app is the service's
/// interface, its folders are these, and a song sent from one is read from there.
fn service_roots() -> Vec<String> {
    std::fs::read(service_config())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|config| {
            config["roots"]
                .as_array()
                .map(|roots| roots.iter().filter_map(|r| r.as_str().map(str::to_owned)).collect())
        })
        .unwrap_or_default()
}

/// A file of one of the app's open folders, to send.
#[derive(Deserialize)]
pub struct FileRef {
    root: String,
    path: String,
}

/// A song sent: its file, and what the iPod made of it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentJson {
    /// The file, as the interface named it.
    path: String,
    /// Where it went on the iPod.
    to: String,
    /// Whether it went with its cover.
    cover: bool,
}

/// Sends files of the app's open folders (or the installed service's) to the iPod at `path` (its master playlist, and
/// `playlist` when named), with their covers: MP3s only. All or nothing.
#[tauri::command]
pub async fn ipod_send(
    roots: State<'_, Roots>,
    path: String,
    files: Vec<FileRef>,
    playlist: Option<String>,
) -> Answer<Vec<SentJson>> {
    let root = ipod_at(&path)?;
    let mut resolved = Vec::new();
    let served = service_roots();
    for file in files {
        // A folder the app opened, or one the installed service serves (the app as its interface).
        let root = match root_of(&roots, &file.root) {
            Ok(root) => root,
            Err(_) if served.contains(&file.root) => jackbird_core::Root::open(&file.root).map_err(Failure::from)?,
            Err(refused) => return Err(refused),
        };
        let from = root.resolve(&file.path).map_err(Failure::from)?;
        resolved.push((file.path, from));
    }
    blocking(move || {
        let mut device = jackbird_ipod_sync::open(&root).map_err(sync_failure)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64);
        let offset = jackbird_ipod_sync::local_offset(now);
        let mut sent = Vec::new();
        for (name, file) in resolved {
            let song = jackbird_ipod_sync::read_mp3(&file, &jackbird_ipod_sync::local_offset).map_err(sync_failure)?;
            let cover = jackbird_ipod_sync::read_cover(&file);
            let added = device
                .add(
                    &file,
                    song,
                    playlist.as_deref(),
                    jackbird_ipod::song::Stamp { unix: now, offset },
                    cover.as_ref(),
                )
                .map_err(sync_failure)?;
            sent.push(SentJson {
                path: name,
                to: added.path,
                cover: added.artwork_id.is_some(),
            });
        }
        device.commit().map_err(sync_failure)?;
        Ok(sent)
    })
    .await
}

/// Takes songs off the iPod at `path`, by their pids (as `ipod_tracks` gave them). All or nothing.
#[tauri::command]
pub async fn ipod_remove(path: String, pids: Vec<String>) -> Answer<usize> {
    let root = ipod_at(&path)?;
    let pids = pids
        .iter()
        .map(|p| {
            p.parse::<i64>()
                .map_err(|_| failure("ipod", format!("{p:?} is not a pid")))
        })
        .collect::<Answer<Vec<i64>>>()?;
    blocking(move || {
        let mut device = jackbird_ipod_sync::open(&root).map_err(sync_failure)?;
        for pid in &pids {
            device.remove(*pid).map_err(sync_failure)?;
        }
        device.commit().map_err(sync_failure)?;
        Ok(pids.len())
    })
    .await
}

/// Reads the iPod's `SysInfoExtended` over USB and keeps it on its disk, for an iPod that has
/// none there yet (the one plugged in, when only one is).
#[tauri::command]
pub async fn ipod_save_sysinfo(path: String) -> Answer<()> {
    let root = ipod_at(&path)?;
    blocking(move || {
        let target = root.join("iPod_Control").join("Device").join("SysInfoExtended");
        if target.exists() {
            return Ok(());
        }
        let devices = jackbird_ipod_usb::list_apple_devices().map_err(|e| failure("ipod", e.to_string()))?;
        let ipods: Vec<_> = devices.iter().filter(|d| d.generation.is_some()).collect();
        let [device] = ipods.as_slice() else {
            return Err(failure("ipod", "plug in only this iPod to read its SysInfoExtended"));
        };
        let xml = jackbird_ipod_usb::read_sysinfo_extended(device).map_err(|e| failure("ipod", e.to_string()))?;
        if xml.trim().is_empty() {
            return Err(failure("ipod", "the iPod sent an empty SysInfoExtended"));
        }
        std::fs::write(&target, xml).map_err(|e| failure("io", e.to_string()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On a copy of a real iPod (`JACKBIRD_IPOD_COPY`, its root), skipped otherwise: every cover a
    /// song names comes in the answer, as a PNG, under a name the interface takes.
    #[test]
    fn every_cover_named_is_sent() {
        let Some(root) = std::env::var_os("JACKBIRD_IPOD_COPY").map(PathBuf::from) else {
            return;
        };
        let Ok(answer) = tracks_of(&root, &[]) else {
            panic!("{} could not be read", root.display())
        };
        let sent: std::collections::HashMap<&str, &str> = answer
            .covers
            .iter()
            .map(|c| (c.name.as_str(), c.data.as_str()))
            .collect();
        let mut named = std::collections::BTreeSet::new();
        for track in &answer.tracks {
            if let Some(reference) = &track.metadata.cover_data_url {
                let name = reference.trim_start_matches("jackbird-cover:");
                named.insert(name.to_string());
                let data = sent
                    .get(name)
                    .unwrap_or_else(|| panic!("{name} ({}) not sent", track.metadata.album));
                assert!(data.starts_with("iVBORw0KGgo"), "{name} is not a PNG");
            }
        }
        eprintln!(
            "{} covers named, every one sent ({} in all)",
            named.len(),
            answer.covers.len()
        );
    }

    #[test]
    fn numbers_and_names() {
        assert_eq!(numbered(0, 12), "");
        assert_eq!(numbered(3, 0), "3");
        assert_eq!(numbered(3, 12), "3/12");
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
        let a = cover_name(Path::new("/Volumes/iPod"), 0x1c7);
        // The interface's `refName` takes only `^[0-9a-f]{16}-[0-9a-f]+\.[a-z]+$`.
        let (hashes, rest) = a.split_once('-').unwrap();
        assert_eq!(hashes.len(), 16);
        assert!(hashes.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(rest, "1c7.png");
        assert_ne!(a, cover_name(Path::new("/Volumes/Other"), 0x1c7));
    }
}
