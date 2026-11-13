//! The library's safety over HTTP (F4, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md,
//! 2026-11-09 15:18): the trash (admins and owners restore and empty it), snapshots of both
//! databases, the scrub and the export (owners), and the timers that take a snapshot every night
//! (03:00 UTC), empty what has been in the trash for 30 days, and scrub once a week.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use jackbird_core::Error;
use jackbird_store::Library;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::people::Person;
use crate::{Answer, ApiError, Service, blocking};

type Shared = State<Arc<Service>>;

/// A job in the background (the export, the scrub): under way, or how the last one ended.
#[derive(Serialize, Clone, Debug, Default)]
pub struct JobState {
    /// Whether it is under way.
    pub running: bool,
    /// Done, and in all.
    pub done: usize,
    /// In all.
    pub total: usize,
    /// When the last one ended, in milliseconds since 1970.
    pub at: Option<u64>,
    /// What it found or did.
    pub result: Option<Value>,
    /// Why it stopped, if it failed.
    pub error: Option<String>,
}

fn library(service: &Service) -> Answer<Arc<Library>> {
    service
        .library
        .clone()
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no-library", "this service has no library"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

fn lock(state: &std::sync::Mutex<JobState>) -> std::sync::MutexGuard<'_, JobState> {
    state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

// ---------------------------------------------------------------------------------------------
// The trash (admins and owners).

/// A catalogue path as people read it: the shelf's path, and whose shelf (SH-D1).
fn shown(service: &Service, path: &str) -> (String, String) {
    match jackbird_store::on_shelf(path) {
        Some((owner, inner)) => (
            inner.to_owned(),
            service.store.person(owner).map(|owner| owner.name).unwrap_or_default(),
        ),
        None => (path.to_owned(), String::new()),
    }
}

async fn trash(State(service): Shared) -> Answer<Json<Value>> {
    let library = library(&service)?;
    let songs = blocking(move || library.trash()).await?;
    let songs: Vec<Value> = songs
        .into_iter()
        .map(|song| {
            let (path, owner) = shown(&service, &song.path);
            json!({ "id": song.id, "path": path, "owner": owner, "by": song.by, "at": song.at })
        })
        .collect();
    Ok(Json(json!(songs)))
}

#[derive(Deserialize)]
struct Id {
    id: i64,
}

async fn restore(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Json(body): Json<Id>,
) -> Answer<Json<Value>> {
    let library = library(&service)?;
    let path = blocking(move || library.restore(body.id)).await?;
    let (path, owner) = shown(&service, &path);
    service.store.log(&person.name, "restore", "Library", &path);
    Ok(Json(json!({ "path": path, "owner": owner })))
}

async fn empty(State(service): Shared, Extension(person): Extension<Person>) -> Answer<Json<Value>> {
    let library = library(&service)?;
    let gone = blocking(move || library.empty_trash(None)).await?;
    service
        .store
        .log(&person.name, "empty", "Library", &format!("{gone} songs"));
    Ok(Json(json!({ "emptied": gone })))
}

/// Routes of admins and owners.
pub fn admins() -> Router<Arc<Service>> {
    Router::new()
        .route("/library/trash", get(trash))
        .route("/library/trash/restore", post(restore))
        .route("/library/trash/empty", post(empty))
}

// ---------------------------------------------------------------------------------------------
// Snapshots, the scrub, the export (owners).

/// Today's snapshot of both databases, then the old ones rotated; its folder.
pub fn snapshot_all(service: &Service) -> Result<PathBuf, Error> {
    let library = service
        .library
        .clone()
        .ok_or_else(|| Error::NotFound("the library".into()))?;
    let folder = library.snapshot()?;
    service
        .store
        .vacuum_into(&folder.join("jackbird.db"))
        .map_err(|refusal| Error::Io(format!("{refusal:?}")))?;
    library.rotate_backups()?;
    Ok(folder)
}

/// Where the last scrub's result is kept, so a restart remembers it.
fn scrub_file(library: &Library) -> PathBuf {
    library.backups_dir().join("scrub.json")
}

/// The last scrub's result, as kept.
fn last_scrub(library: &Library) -> Option<JobState> {
    let text = std::fs::read_to_string(scrub_file(library)).ok()?;
    serde_json::from_str::<Value>(&text).ok().map(|kept| JobState {
        at: kept["at"].as_u64(),
        result: Some(kept["bad"].clone()),
        ..JobState::default()
    })
}

/// Scrubs the library now, unless a scrub is under way; blocks until it ends.
pub fn run_scrub(service: &Service) {
    let Some(library) = service.library.clone() else { return };
    {
        let mut state = lock(&service.scrubbing);
        if state.running {
            return;
        }
        *state = JobState {
            running: true,
            ..JobState::default()
        };
    }
    let result = library.scrub(|done, total| {
        let mut state = lock(&service.scrubbing);
        state.done = done;
        state.total = total;
    });
    let at = now_ms();
    let mut state = lock(&service.scrubbing);
    state.running = false;
    state.at = Some(at);
    match result {
        Ok(bad) => {
            let bad = json!(
                bad.iter()
                    .map(|(blob, paths)| json!({ "blob": blob, "songs": paths }))
                    .collect::<Vec<_>>()
            );
            if bad.as_array().is_some_and(|bad| !bad.is_empty()) {
                service.store.log("jackbird", "scrub", "Library", &format!("{bad}"));
            }
            let _ = std::fs::create_dir_all(library.backups_dir());
            let _ = std::fs::write(scrub_file(&library), json!({ "at": at, "bad": bad }).to_string());
            state.result = Some(bad);
        }
        Err(error) => state.error = Some(error.to_string()),
    }
}

async fn backups(State(service): Shared) -> Answer<Json<Value>> {
    let library = library(&service)?;
    let snapshots = library.backups();
    let mut scrub = lock(&service.scrubbing).clone();
    if !scrub.running && scrub.at.is_none() {
        scrub = last_scrub(&library).unwrap_or_default();
    }
    Ok(Json(json!({
        "folder": library.dir().display().to_string(),
        "snapshots": snapshots,
        "scrub": scrub,
        "export": lock(&service.exporting).clone(),
    })))
}

async fn snapshot(State(service): Shared, Extension(person): Extension<Person>) -> Answer<Json<Value>> {
    library(&service)?;
    let worker = Arc::clone(&service);
    let folder = tokio::task::spawn_blocking(move || snapshot_all(&worker))
        .await
        .map_err(|error| ApiError::from(Error::Io(error.to_string())))??;
    service
        .store
        .log(&person.name, "snapshot", "Library", &folder.display().to_string());
    backups(State(service)).await
}

async fn scrub(State(service): Shared) -> Answer<Json<Value>> {
    library(&service)?;
    let worker = Arc::clone(&service);
    tokio::task::spawn_blocking(move || run_scrub(&worker));
    Ok(Json(json!({ "started": true })))
}

#[derive(Deserialize)]
struct ExportTo {
    path: String,
}

async fn export(
    State(service): Shared,
    Extension(person): Extension<Person>,
    Json(body): Json<ExportTo>,
) -> Answer<Json<JobState>> {
    let library = library(&service)?;
    {
        let mut state = lock(&service.exporting);
        if state.running {
            return Err(ApiError::new(StatusCode::CONFLICT, "busy", "an export is under way"));
        }
        *state = JobState {
            running: true,
            ..JobState::default()
        };
    }
    let worker = Arc::clone(&service);
    let by = person.name.clone();
    let to = PathBuf::from(&body.path);
    tokio::task::spawn_blocking(move || {
        let result = library.export(&to, |done, total| {
            let mut state = lock(&worker.exporting);
            state.done = done;
            state.total = total;
        });
        if let Ok(exported) = &result {
            worker.store.log(
                &by,
                "export",
                "Library",
                &format!(
                    "{}: {} written, {} failed",
                    to.display(),
                    exported.written,
                    exported.failed.len()
                ),
            );
        }
        let mut state = lock(&worker.exporting);
        state.running = false;
        state.at = Some(now_ms());
        match result {
            Ok(exported) => state.result = Some(json!(exported)),
            Err(error) => state.error = Some(error.to_string()),
        }
    });
    Ok(Json(lock(&service.exporting).clone()))
}

/// Routes of owners.
pub fn owners() -> Router<Arc<Service>> {
    Router::new()
        .route("/library/backups", get(backups))
        .route("/library/backups/snapshot", post(snapshot))
        .route("/library/backups/scrub", post(scrub))
        .route("/library/export", get(export_state).post(export))
}

async fn export_state(State(service): Shared) -> Json<JobState> {
    Json(lock(&service.exporting).clone())
}

// ---------------------------------------------------------------------------------------------
// The timers.

/// Every ten minutes: today's snapshot once it is past 03:00 (UTC) and none was taken today; the
/// trash's songs older than 30 days emptied once a day; a scrub when the last one is a week old.
pub fn spawn_timers(service: Arc<Service>) {
    let Some(library) = service.library.clone() else { return };
    tokio::spawn(async move {
        let mut expired_on = String::new();
        loop {
            let today = jackbird_store::today();
            let hour = (now_ms() / 3_600_000) % 24;
            let worker = Arc::clone(&service);
            let library = Arc::clone(&library);
            let due = hour >= 3 && !library.backups().contains(&today);
            let expire = expired_on != today;
            expired_on.clone_from(&today);
            let _ = tokio::task::spawn_blocking(move || {
                if due && let Err(error) = snapshot_all(&worker) {
                    eprintln!("jackbird-service: the night's snapshot: {error}");
                }
                if expire
                    && let Ok(gone) = library.expire_trash()
                    && gone > 0
                {
                    worker
                        .store
                        .log("jackbird", "empty", "Library", &format!("{gone} songs, after 30 days"));
                }
                let week = 7 * 24 * 3_600_000;
                let last = last_scrub(&library).and_then(|state| state.at).unwrap_or(0);
                let importing = worker.importing.lock().map(|state| state.running).unwrap_or(true);
                if now_ms().saturating_sub(last) > week
                    && !importing
                    && !library.songs().map(|songs| songs.is_empty()).unwrap_or(true)
                {
                    run_scrub(&worker);
                }
            })
            .await;
            tokio::time::sleep(Duration::from_secs(600)).await;
        }
    });
}
