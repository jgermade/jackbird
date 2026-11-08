//! jackbird's service (S1, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-08
//! 17:43): `jackbird-core` behind HTTP, and the web build served from the same origin. One
//! person, open, on the machine only, until S3 brings sign-in:
//!
//! - it listens on the loopback address only (`main.rs`);
//! - every request must name the service itself as its `Host` (`localhost`, `127.0.0.1` or
//!   `[::1]`, with its port), so a page elsewhere cannot reach it by pointing its own name at
//!   127.0.0.1 ("DNS rebinding");
//! - a request from another site is refused (`Sec-Fetch-Site: cross-site`, or an `Origin` that is
//!   not the service's), and one that changes anything must come from its own page.
//!
//! The interface's side is `src/lib/sources/service.ts`; the JSON is `jackbird-api`'s, the same
//! the desktop app speaks.

pub mod config;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use jackbird_api::{EntryJson, Failure, InspectionJson, Metadata, Opened, StatJson, edit_for, failure};
use jackbird_core::{Error, Root};
use serde::{Deserialize, Serialize};
use tower::ServiceExt;

/// The web build (`npm run build`), in the binary of a release build; read from `dist/` in a
/// debug one. Missing when the binary was built without it: the API still works.
#[derive(rust_embed::Embed)]
#[folder = "../../dist/"]
#[allow_missing = true]
struct Web;

/// What the service holds: its open roots, its port, and where its configuration is kept.
pub struct Service {
    roots: RwLock<HashMap<String, Root>>,
    port: u16,
    config: Option<PathBuf>,
}

impl Service {
    /// A service on `port`, keeping its roots in the configuration at `config` (none in tests).
    /// The roots the configuration lists are opened again; one that is gone is left out.
    pub fn new(port: u16, config: Option<PathBuf>, roots: &[String]) -> Arc<Service> {
        let open = roots
            .iter()
            .filter_map(|path| Root::open(path).ok().map(|root| (path.clone(), root)))
            .collect();
        Arc::new(Service {
            roots: RwLock::new(open),
            port,
            config,
        })
    }

    fn root(&self, path: &str) -> Result<Root, ApiError> {
        self.roots
            .read()
            .map_err(|_| ApiError::from(failure("io", "the roots' list")))?
            .get(path)
            .cloned()
            .ok_or_else(|| {
                ApiError(
                    StatusCode::NOT_FOUND,
                    failure("outside", format!("{path:?} is not an open folder")),
                )
            })
    }

    fn save_config(&self) {
        if let (Some(path), Ok(roots)) = (&self.config, self.roots.read()) {
            let mut paths: Vec<String> = roots.keys().cloned().collect();
            paths.sort();
            let _ = config::Config {
                port: self.port,
                roots: paths,
            }
            .save(path);
        }
    }
}

/// An error as an HTTP answer: a status, and `jackbird-api`'s failure as JSON.
pub struct ApiError(StatusCode, Failure);

impl From<Failure> for ApiError {
    fn from(failure: Failure) -> Self {
        let status = match failure.code.as_str() {
            "outside" => StatusCode::FORBIDDEN,
            "not-found" => StatusCode::NOT_FOUND,
            "io" => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        };
        ApiError(status, failure)
    }
}

impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        Failure::from(error).into()
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

type Answer<T> = Result<T, ApiError>;

/// Runs file work off the async threads.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, Error> + Send + 'static) -> Answer<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| ApiError::from(failure("io", error.to_string())))?
        .map_err(ApiError::from)
}

#[derive(Deserialize)]
struct At {
    root: String,
    #[serde(default)]
    path: String,
}

#[derive(Serialize)]
struct Info {
    name: &'static str,
    version: &'static str,
}

async fn info() -> Json<Info> {
    Json(Info {
        name: "jackbird-service",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn roots(State(service): State<Arc<Service>>) -> Answer<Json<Vec<Opened>>> {
    let roots = service
        .roots
        .read()
        .map_err(|_| ApiError::from(failure("io", "the roots' list")))?;
    let mut open: Vec<Opened> = roots
        .iter()
        .map(|(path, root)| Opened {
            path: path.clone(),
            name: root.name(),
        })
        .collect();
    open.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Json(open))
}

#[derive(Deserialize)]
struct OpenRoot {
    path: String,
}

async fn open_root(State(service): State<Arc<Service>>, Json(body): Json<OpenRoot>) -> Answer<Json<Opened>> {
    let path = body.path.clone();
    let root = blocking(move || Root::open(&path)).await?;
    let opened = Opened {
        path: body.path.clone(),
        name: root.name(),
    };
    service
        .roots
        .write()
        .map_err(|_| ApiError::from(failure("io", "the roots' list")))?
        .insert(body.path, root);
    service.save_config();
    Ok(Json(opened))
}

#[derive(Deserialize)]
struct CloseRoot {
    root: String,
}

async fn close_root(State(service): State<Arc<Service>>, Json(body): Json<CloseRoot>) -> Answer<StatusCode> {
    service
        .roots
        .write()
        .map_err(|_| ApiError::from(failure("io", "the roots' list")))?
        .remove(&body.root);
    service.save_config();
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct FoldersAt {
    path: Option<String>,
}

#[derive(Serialize)]
struct Folder {
    name: String,
    path: String,
}

#[derive(Serialize)]
struct Folders {
    path: String,
    parent: Option<String>,
    folders: Vec<Folder>,
}

/// The person's home folder, where the dialog starts.
fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map_or_else(|| PathBuf::from("/"), PathBuf::from)
}

/// The folders in a folder of the machine, for the interface's dialog: any folder the service
/// can read (the owner's choice for S1); hidden ones left out.
fn folders_in(path: &Path) -> Result<Folders, Error> {
    let shown = path.display().to_string();
    let entries = std::fs::read_dir(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => Error::NotFound(shown.clone()),
        _ => Error::Io(format!("{shown}: {error}")),
    })?;
    let mut folders: Vec<Folder> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry.path()))
        .filter(|(name, _)| !name.starts_with('.'))
        .map(|(name, path)| Folder {
            name,
            path: path.display().to_string(),
        })
        .collect();
    folders.sort_by_key(|folder| folder.name.to_lowercase());
    Ok(Folders {
        path: shown,
        parent: path.parent().map(|parent| parent.display().to_string()),
        folders,
    })
}

async fn folders(Query(at): Query<FoldersAt>) -> Answer<Json<Folders>> {
    let path = at.path.map_or_else(home, PathBuf::from);
    blocking(move || folders_in(&path)).await.map(Json)
}

async fn walk(State(service): State<Arc<Service>>, Query(at): Query<At>) -> Answer<Json<Vec<EntryJson>>> {
    let root = service.root(&at.root)?;
    let entries = blocking(move || root.walk()).await?;
    Ok(Json(entries.into_iter().map(Into::into).collect()))
}

async fn list(State(service): State<Arc<Service>>, Query(at): Query<At>) -> Answer<Json<Vec<EntryJson>>> {
    let root = service.root(&at.root)?;
    let entries = blocking(move || root.list(&at.path)).await?;
    Ok(Json(entries.into_iter().map(Into::into).collect()))
}

async fn read(State(service): State<Arc<Service>>, Query(at): Query<At>) -> Answer<Response> {
    let root = service.root(&at.root)?;
    let bytes = blocking(move || root.read(&at.path)).await?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response())
}

async fn write(State(service): State<Arc<Service>>, Query(at): Query<At>, body: Bytes) -> Answer<StatusCode> {
    let root = service.root(&at.root)?;
    blocking(move || root.write(&at.path, &body)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn stat(State(service): State<Arc<Service>>, Query(at): Query<At>) -> Answer<Json<Option<StatJson>>> {
    let root = service.root(&at.root)?;
    let stat = blocking(move || root.stat(&at.path)).await?;
    Ok(Json(stat.map(Into::into)))
}

async fn delete(State(service): State<Arc<Service>>, Query(at): Query<At>) -> Answer<StatusCode> {
    let root = service.root(&at.root)?;
    blocking(move || root.delete(&at.path)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn mkdir(State(service): State<Arc<Service>>, Query(at): Query<At>) -> Answer<StatusCode> {
    let root = service.root(&at.root)?;
    blocking(move || root.mkdir(&at.path)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Rename {
    root: String,
    from: String,
    to: String,
}

async fn rename(State(service): State<Arc<Service>>, Json(body): Json<Rename>) -> Answer<StatusCode> {
    let root = service.root(&body.root)?;
    blocking(move || root.rename(&body.from, &body.to)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Inspect {
    root: String,
    path: String,
    known: Option<String>,
}

async fn inspect(State(service): State<Arc<Service>>, Json(body): Json<Inspect>) -> Answer<Json<InspectionJson>> {
    let root = service.root(&body.root)?;
    let found = blocking(move || jackbird_core::inspect(&root, &body.path, body.known.as_deref())).await?;
    Ok(Json(found.into()))
}

#[derive(Deserialize)]
struct Save {
    root: String,
    path: String,
    previous: Metadata,
    metadata: Metadata,
}

async fn save(State(service): State<Arc<Service>>, Json(body): Json<Save>) -> Answer<Json<InspectionJson>> {
    let root = service.root(&body.root)?;
    let edit = edit_for(&body.previous, body.metadata);
    let found = blocking(move || jackbird_core::save(&root, &body.path, &edit)).await?;
    Ok(Json(found.into()))
}

/// A track's file, with byte ranges, for the `<audio>` element.
async fn media(State(service): State<Arc<Service>>, Query(at): Query<At>, request: Request) -> Answer<Response> {
    let file = service.root(&at.root)?.resolve(&at.path)?;
    let served = tower_http::services::ServeFile::new(file)
        .oneshot(request)
        .await
        .map_err(|error| ApiError::from(failure("io", error.to_string())))?;
    Ok(served.map(Body::new))
}

/// The web build: a file of it, or its page for any other path (the app has one page).
async fn web(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let file = Web::get(if path.is_empty() { "index.html" } else { path }).or_else(|| Web::get("index.html"));
    match file {
        Some(file) => {
            let mime = file.metadata.mimetype().to_owned();
            ([(header::CONTENT_TYPE, mime)], file.data.into_owned()).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            "jackbird-service was built without the web build (npm run build first)",
        )
            .into_response(),
    }
}

/// The names the service answers to.
fn own_hosts(port: u16) -> [String; 3] {
    [
        format!("localhost:{port}"),
        format!("127.0.0.1:{port}"),
        format!("[::1]:{port}"),
    ]
}

/// The guards of an open service on the machine (the module's documentation).
async fn guard(State(service): State<Arc<Service>>, request: Request, next: Next) -> Response {
    let headers: &HeaderMap = request.headers();
    let refuse = |why: &str| (StatusCode::FORBIDDEN, Json(failure("outside", why))).into_response();
    let hosts = own_hosts(service.port);
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !hosts.iter().any(|own| own == host) {
        return refuse("this service answers only on this machine, by its own address");
    }
    if headers.get("sec-fetch-site").map(HeaderValue::as_bytes) == Some(b"cross-site") {
        return refuse("a request from another site");
    }
    let origin = headers.get(header::ORIGIN).and_then(|value| value.to_str().ok());
    let own_origin = |origin: &str| hosts.iter().any(|own| origin == format!("http://{own}"));
    if origin.is_some_and(|origin| !own_origin(origin)) {
        return refuse("a request from another origin");
    }
    let changes = !matches!(*request.method(), Method::GET | Method::HEAD);
    if changes && origin.is_none() {
        return refuse("a request that changes something must come from the service's own page");
    }
    next.run(request).await
}

/// The service's routes, behind its guards.
pub fn router(service: Arc<Service>) -> Router {
    let api = Router::new()
        .route("/info", get(info))
        .route("/roots", get(roots).post(open_root))
        .route("/roots/close", post(close_root))
        .route("/folders", get(folders))
        .route("/walk", get(walk))
        .route("/list", get(list))
        .route("/read", get(read))
        .route("/write", post(write))
        .route("/stat", get(stat))
        .route("/delete", post(delete))
        .route("/mkdir", post(mkdir))
        .route("/rename", post(rename))
        .route("/inspect", post(inspect))
        .route("/save", post(save))
        .route("/media", get(media));
    Router::new()
        .nest("/api", api)
        .fallback(get(web))
        // `.meta/` holds the covers as data URLs: larger than axum's default 2 MB.
        .layer(DefaultBodyLimit::max(512 << 20))
        .layer(middleware::from_fn_with_state(Arc::clone(&service), guard))
        .with_state(service)
}

#[cfg(test)]
mod tests;
