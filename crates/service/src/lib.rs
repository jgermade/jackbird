//! jackbird's service (S1, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-08
//! 17:43): `jackbird-core` behind HTTP, and the web build served from the same origin; with
//! people, roles and sign-in since S3 (2026-11-09, 10:45 to 11:57).
//!
//! Open (sign-in off), it answers on the machine only:
//!
//! - it refuses a peer that is not the machine itself, and a request a proxy forwarded;
//! - every request must name the service itself as its `Host` (`localhost`, `127.0.0.1` or
//!   `[::1]`, with its port), so a page elsewhere cannot reach it by pointing its own name at
//!   127.0.0.1 ("DNS rebinding").
//!
//! With sign-in on, any name is answered (the instance's address behind a proxy, the home
//! network), since without a session nothing but signing in is. Either way:
//!
//! - a request from another site is refused (`Sec-Fetch-Site: cross-site`, or an `Origin` that is
//!   not the service's), and one that changes anything must come from its own page (or carry an
//!   `Authorization`, which no other site can set);
//! - the desktop app's page, its interface while it is installed (S2), is the one other origin
//!   answered, with CORS for itself alone;
//! - every route asks for a role (`access.rs`), and every change to the folders is logged.
//!
//! The interface's side is `src/lib/sources/service.ts`; the JSON is `jackbird-api`'s, the same
//! the desktop app speaks.

pub mod access;
pub mod auth;
pub mod config;
pub mod install;
mod library_api;
pub mod mail;
mod passkeys;
pub mod people;
mod people_api;
pub mod safety_api;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use jackbird_api::{EntryJson, Failure, InspectionJson, Metadata, Opened, StatJson, edit_for, failure};
use jackbird_core::{Error, Root};
use serde::{Deserialize, Serialize};
use tower::ServiceExt;

use crate::access::{Client, require};
use crate::auth::{Codes, Once, Signer};
use crate::config::Config;
use crate::people::{Person, Role, Store};

/// The web build (`npm run build`), in the binary of a release build; read from `dist/` in a
/// debug one. Missing when the binary was built without it: the API still works.
#[derive(rust_embed::Embed)]
#[folder = "../../dist/"]
#[allow_missing = true]
struct Web;

/// What the service holds: its open roots, its settings and where they are kept, its people,
/// and what signing in needs.
pub struct Service {
    roots: RwLock<HashMap<String, Root>>,
    port: u16,
    settings: RwLock<Config>,
    config: Option<PathBuf>,
    /// The people, their sessions and passkeys, the log.
    pub store: Store,
    pub(crate) signer: Signer,
    pub(crate) codes: Codes,
    pub(crate) ceremonies: Once,
    /// The console's key (`config::console_key_path`): `Authorization: Console <key>` acts as an
    /// owner, for `jackbird-service setup` and `signin off`.
    pub(crate) console_key: String,
    /// Whether it should listen on the home network too (sign-in on and the network allowed);
    /// `main.rs` follows it.
    pub network: tokio::sync::watch::Sender<bool>,
    /// Sends email (SMTP; a fake one in tests).
    pub(crate) mailer: Box<dyn mail::Mailer>,
    /// Networks that count as this machine for an open instance (F5).
    pub(crate) machine: Vec<(std::net::IpAddr, u8)>,
    /// The family library (F1), when it could be opened.
    pub(crate) library: Option<Arc<jackbird_store::Library>>,
    /// The import from a folder of the machine under way, or the last one.
    pub(crate) importing: std::sync::Mutex<library_api::ImportState>,
    /// The export under way, or the last one (F4).
    pub(crate) exporting: std::sync::Mutex<safety_api::JobState>,
    /// The scrub under way, or the last one (F4).
    pub(crate) scrubbing: std::sync::Mutex<safety_api::JobState>,
}

impl Service {
    /// A service with `settings`, kept in the configuration at `config` (none in tests), with
    /// its people in `store`. The roots the settings list are opened again; one that is gone is
    /// left out.
    pub fn new(settings: Config, config: Option<PathBuf>, store: Store) -> Arc<Service> {
        Service::with_mailer(settings, config, store, Box::new(mail::SmtpMailer))
    }

    /// The same, with another way of sending email (tests), and no library.
    pub fn with_mailer(
        settings: Config,
        config: Option<PathBuf>,
        store: Store,
        mailer: Box<dyn mail::Mailer>,
    ) -> Arc<Service> {
        Service::with_library(settings, config, store, mailer, None)
    }

    /// The same, with the family library (F1).
    pub fn with_library(
        settings: Config,
        config: Option<PathBuf>,
        store: Store,
        mailer: Box<dyn mail::Mailer>,
        library: Option<jackbird_store::Library>,
    ) -> Arc<Service> {
        let open = settings
            .roots
            .iter()
            .filter_map(|path| Root::open(path).ok().map(|root| (path.clone(), root)))
            .collect();
        let signer = Signer::new(store.secret("signer"));
        let console_key = {
            use base64::Engine;
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(people::random::<32>())
        };
        let (network, _) = tokio::sync::watch::channel(settings.signin && settings.network);
        let machine = config::machine_networks(&settings.machine);
        Arc::new(Service {
            roots: RwLock::new(open),
            port: settings.port,
            settings: RwLock::new(settings),
            config,
            store,
            signer,
            codes: Codes::default(),
            ceremonies: Once::default(),
            console_key,
            network,
            mailer,
            machine,
            library: library.map(Arc::new),
            importing: std::sync::Mutex::new(library_api::ImportState::default()),
            exporting: std::sync::Mutex::new(safety_api::JobState::default()),
            scrubbing: std::sync::Mutex::new(safety_api::JobState::default()),
        })
    }

    /// The console's key, for `main.rs` to write where the console finds it.
    pub fn console_key(&self) -> &str {
        &self.console_key
    }

    /// Its settings as they are now.
    pub fn settings(&self) -> Config {
        self.settings
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Changes its settings and keeps them.
    pub(crate) fn change_settings(&self, change: impl FnOnce(&mut Config)) {
        let mut settings = self.settings.write().unwrap_or_else(std::sync::PoisonError::into_inner);
        change(&mut settings);
        self.network.send_replace(settings.signin && settings.network);
        drop(settings);
        self.save_config();
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
            let mut settings = self.settings.write().unwrap_or_else(std::sync::PoisonError::into_inner);
            settings.roots = paths;
            let _ = settings.save(path);
        }
    }
}

/// An error as an HTTP answer: a status, and `jackbird-api`'s failure as JSON.
pub struct ApiError(pub(crate) StatusCode, pub(crate) Failure);

impl ApiError {
    /// An answer with a status, a code and a message.
    pub(crate) fn new(status: StatusCode, code: &str, message: impl Into<String>) -> ApiError {
        ApiError(status, failure(code, message))
    }
}

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

pub(crate) type Answer<T> = Result<T, ApiError>;

/// Runs file work off the async threads.
pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, Error> + Send + 'static) -> Answer<T> {
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
        version: env!("JACKBIRD_VERSION"),
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

async fn open_root(
    State(service): State<Arc<Service>>,
    Extension(person): Extension<Person>,
    Json(body): Json<OpenRoot>,
) -> Answer<Json<Opened>> {
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
        .insert(body.path.clone(), root);
    service.save_config();
    service.store.log(&person.name, "open", &body.path, "");
    Ok(Json(opened))
}

#[derive(Deserialize)]
struct CloseRoot {
    root: String,
}

async fn close_root(
    State(service): State<Arc<Service>>,
    Extension(person): Extension<Person>,
    Json(body): Json<CloseRoot>,
) -> Answer<StatusCode> {
    service
        .roots
        .write()
        .map_err(|_| ApiError::from(failure("io", "the roots' list")))?
        .remove(&body.root);
    service.save_config();
    service.store.log(&person.name, "close", &body.root, "");
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

async fn write(
    State(service): State<Arc<Service>>,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
    body: Bytes,
) -> Answer<StatusCode> {
    let root = service.root(&at.root)?;
    let path = at.path.clone();
    blocking(move || root.write(&path, &body)).await?;
    // `.meta/` is the interface's own cache of the folder, not a change to the catalogue.
    if !at.path.starts_with(".meta/") {
        service.store.log(&person.name, "write", &at.root, &at.path);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn stat(State(service): State<Arc<Service>>, Query(at): Query<At>) -> Answer<Json<Option<StatJson>>> {
    let root = service.root(&at.root)?;
    let stat = blocking(move || root.stat(&at.path)).await?;
    Ok(Json(stat.map(Into::into)))
}

async fn delete(
    State(service): State<Arc<Service>>,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
) -> Answer<StatusCode> {
    let root = service.root(&at.root)?;
    let path = at.path.clone();
    blocking(move || root.delete(&path)).await?;
    service.store.log(&person.name, "delete", &at.root, &at.path);
    Ok(StatusCode::NO_CONTENT)
}

async fn mkdir(
    State(service): State<Arc<Service>>,
    Extension(person): Extension<Person>,
    Query(at): Query<At>,
) -> Answer<StatusCode> {
    let root = service.root(&at.root)?;
    let path = at.path.clone();
    blocking(move || root.mkdir(&path)).await?;
    service.store.log(&person.name, "mkdir", &at.root, &at.path);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Rename {
    root: String,
    from: String,
    to: String,
}

async fn rename(
    State(service): State<Arc<Service>>,
    Extension(person): Extension<Person>,
    Json(body): Json<Rename>,
) -> Answer<StatusCode> {
    let root = service.root(&body.root)?;
    let (from, to) = (body.from.clone(), body.to.clone());
    blocking(move || root.rename(&from, &to)).await?;
    service.store.log(
        &person.name,
        "rename",
        &body.root,
        &format!("{} → {}", body.from, body.to),
    );
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

async fn save(
    State(service): State<Arc<Service>>,
    Extension(person): Extension<Person>,
    Json(body): Json<Save>,
) -> Answer<Json<InspectionJson>> {
    let root = service.root(&body.root)?;
    let edit = edit_for(&body.previous, body.metadata);
    let path = body.path.clone();
    let found = blocking(move || jackbird_core::save(&root, &path, &edit)).await?;
    service.store.log(&person.name, "save", &body.root, &body.path);
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

/// Whether an address is the machine itself.
fn loopback(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_loopback(),
        std::net::IpAddr::V6(v6) => v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()),
    }
}

/// The guards (the module's documentation).
async fn guard(State(service): State<Arc<Service>>, mut request: Request, next: Next) -> Response {
    let refuse = |why: &str| (StatusCode::FORBIDDEN, Json(failure("outside", why))).into_response();
    let settings = service.settings();
    let headers: &HeaderMap = request.headers();
    let text = |name: header::HeaderName| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    // No peer is known only when the router is called directly (tests): the machine itself.
    let peer = request
        .extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
        .map_or(std::net::IpAddr::from([127, 0, 0, 1]), |info| info.0.ip());
    let forwarded = headers.contains_key("x-forwarded-for") || headers.contains_key(header::FORWARDED);
    let proxied = forwarded && settings.proxies.iter().any(|proxy| proxy.parse() == Ok(peer));
    let host = text(header::HOST).unwrap_or_default();
    let hosts = own_hosts(service.port);
    if !settings.signin {
        // In a container (F5), the networks the host reaches it from count as the machine.
        let machine = loopback(peer) || service.machine.iter().any(|network| config::in_network(peer, *network));
        if !machine || forwarded {
            return refuse("this service answers only on this machine until sign-in is turned on");
        }
        // In a container the port published on the host is not known: a loopback name with any
        // port (the name is what keeps a rebinding page out).
        let loopback_name = host.rsplit_once(':').is_some_and(|(name, port)| {
            matches!(name, "localhost" | "127.0.0.1" | "[::1]") && port.parse::<u16>().is_ok()
        });
        if !hosts.contains(&host) && !(loopback_name && !service.machine.is_empty()) {
            return refuse("this service answers only on this machine, by its own address");
        }
    } else if host.is_empty() {
        return refuse("a request without a host");
    }
    let secure = proxied && headers.get("x-forwarded-proto").map(HeaderValue::as_bytes) == Some(b"https");
    let ip = if proxied {
        text(header::HeaderName::from_static("x-forwarded-for"))
            .and_then(|list| list.split(',').next_back().map(|ip| ip.trim().to_owned()))
            .unwrap_or_else(|| peer.to_string())
    } else {
        peer.to_string()
    };
    let own_origin = format!("{}://{host}", if secure { "https" } else { "http" });
    let origin = text(header::ORIGIN);
    // The desktop app's page, which is the service's interface while it is installed (S2-D4).
    let desktop = origin
        .as_deref()
        .filter(|origin| DESKTOP_ORIGINS.contains(origin))
        .map(str::to_owned);
    if desktop.is_none() && headers.get("sec-fetch-site").map(HeaderValue::as_bytes) == Some(b"cross-site") {
        return refuse("a request from another site");
    }
    if origin
        .as_deref()
        .is_some_and(|origin| origin != own_origin && desktop.is_none())
    {
        return refuse("a request from another origin");
    }
    let changes = !matches!(*request.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if changes && origin.is_none() && !headers.contains_key(header::AUTHORIZATION) {
        return refuse("a request that changes something must come from the service's own page");
    }
    request.extensions_mut().insert(Client { ip, secure });
    if let Some(desktop) = desktop {
        let desktop = HeaderValue::from_str(&desktop).expect("a known origin");
        if request.method() == Method::OPTIONS {
            let mut answer = StatusCode::NO_CONTENT.into_response();
            let headers = answer.headers_mut();
            headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, desktop);
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static("GET, POST"),
            );
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static("content-type, range, authorization"),
            );
            headers.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
            headers.insert(header::VARY, HeaderValue::from_static("origin"));
            return answer;
        }
        let mut answer = next.run(request).await;
        let headers = answer.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, desktop);
        headers.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static("content-range, content-length, accept-ranges"),
        );
        headers.insert(header::VARY, HeaderValue::from_static("origin"));
        return answer;
    }
    next.run(request).await
}

/// The desktop app's page origins (Tauri v2: `tauri://localhost` on macOS and Linux,
/// `http://tauri.localhost` on Windows), answered with CORS for themselves alone.
const DESKTOP_ORIGINS: [&str; 3] = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

/// The routes of a role: the person is checked, and handed to them.
fn of(service: &Arc<Service>, role: Role, routes: Router<Arc<Service>>) -> Router<Arc<Service>> {
    routes.route_layer(middleware::from_fn_with_state((Arc::clone(service), role), require))
}

/// The service's routes, each behind the role it needs (S3-D9, 11:57), and the guards.
pub fn router(service: Arc<Service>) -> Router {
    let listener = Router::new()
        .route("/roots", get(roots))
        .route("/walk", get(walk))
        .route("/list", get(list))
        .route("/read", get(read))
        .route("/stat", get(stat))
        .route("/inspect", post(inspect))
        .route("/media", get(media))
        .merge(people_api::own())
        .merge(passkeys::own())
        .merge(library_api::listeners());
    let editor = Router::new()
        .route("/write", post(write))
        .route("/delete", post(delete))
        .route("/mkdir", post(mkdir))
        .route("/rename", post(rename))
        .route("/save", post(save))
        .merge(library_api::editors());
    let owner = Router::new()
        .route("/roots", post(open_root))
        .route("/roots/close", post(close_root))
        .route("/folders", get(folders))
        .merge(people_api::owners())
        .merge(library_api::owners());
    let api = Router::new()
        .route("/info", get(info))
        .merge(people_api::open())
        .merge(passkeys::open())
        .merge(of(&service, Role::Listener, listener))
        .merge(of(&service, Role::Editor, editor))
        .merge(of(&service, Role::Admin, people_api::admins()))
        .merge(of(&service, Role::Admin, safety_api::admins()))
        .merge(of(&service, Role::Owner, safety_api::owners()))
        .merge(of(&service, Role::Owner, owner));
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
