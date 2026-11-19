//! Updating the service from the app (Preferences, Server; owners): the latest release's version,
//! whether this one can update itself, and the update, which puts the release's binary for this
//! system in place of its own and leaves its service manager to start it again. See
//! RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-19, updating the server from the app).
//!
//! The latest release is told by where GitHub's `releases/latest` page leads (its tag), and its
//! files are downloaded from `releases/download/<tag>/<file>`: not GitHub's API, whose limit for
//! unknown callers (60 an hour per address) a shared address can spend. Over HTTPS, by a short
//! HTTP/1.1 client of its own on `rustls` (already built for email): no client crate. Each binary's
//! SHA-256 is checked against the release's `SHA256SUMS` before it is used.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::StatusCode;
use axum::{Extension, Json, Router};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::install::{Os, Way, binary_path};
use crate::people::Person;
use crate::{Answer, ApiError, Service};

/// Where the releases are.
const RELEASES: &str = "https://github.com/jgermade/jackbird/releases";
/// The checksums' file each release carries beside the binaries.
const SUMS: &str = "SHA256SUMS";
/// How long the latest release is kept before GitHub is asked again.
const KEEP: Duration = Duration::from_secs(3600);
/// The most a download may bring (a binary is some tens of megabytes).
const LIMIT: usize = 256 * 1024 * 1024;
/// The exit code that has the service manager start it again (a failure, as each restarts on one).
const RESTART: i32 = 75;

/// A release: its version (without the tag's `v`) and its tag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    /// The version, without the tag's `v`.
    pub version: String,
    /// Its tag, as its files' addresses name it.
    pub tag: String,
}

/// Whether the service can update itself, and if not, why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Situation {
    /// It runs the installed binary at logon, which it may replace: this one.
    Yes(PathBuf),
    /// In a container: the image is updated by pulling it.
    Container,
    /// Installed with the system: the binary is the administrator's.
    System,
    /// Not the installed binary (started by hand): no manager would start it again.
    Manual,
    /// Its folder cannot be written.
    ReadOnly,
}

impl Situation {
    /// Its name in the API.
    pub fn name(&self) -> &'static str {
        match self {
            Situation::Yes(_) => "yes",
            Situation::Container => "container",
            Situation::System => "system",
            Situation::Manual => "manual",
            Situation::ReadOnly => "readonly",
        }
    }
}

/// How this one runs: in a container (`JACKBIRD_LISTEN` on every address), or as the binary
/// installed one way or the other for the person whose home `home` is, or by hand.
pub fn situation(os: Os, exe: &Path, listen: Option<&str>, home: &Path, writable: impl Fn(&Path) -> bool) -> Situation {
    if listen
        .and_then(|listen| listen.parse::<std::net::IpAddr>().ok())
        .is_some_and(|listen| listen.is_unspecified())
    {
        return Situation::Container;
    }
    let person = crate::install::Person {
        user: String::new(),
        uid: 0,
        home: home.to_path_buf(),
        config: PathBuf::new(),
    };
    if exe == binary_path(os, Way::System, &person) {
        return Situation::System;
    }
    if exe != binary_path(os, Way::Logon, &person) {
        return Situation::Manual;
    }
    match exe.parent() {
        Some(folder) if writable(folder) => Situation::Yes(exe.to_path_buf()),
        _ => Situation::ReadOnly,
    }
}

/// This process's situation.
fn here() -> Situation {
    let exe = std::env::current_exe().unwrap_or_default();
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    situation(
        Os::current(),
        &exe,
        std::env::var("JACKBIRD_LISTEN").ok().as_deref(),
        &home,
        |folder| {
            let probe = folder.join(".jackbird-update-probe");
            let ok = std::fs::write(&probe, b"").is_ok();
            let _ = std::fs::remove_file(&probe);
            ok
        },
    )
}

/// The release's file for a system and an architecture (Rust's names: `linux`, `macos`,
/// `windows`; `x86_64`, `aarch64`), as `service.yml` and `ship.yml` name them: Linux's static one.
pub fn asset_name(os: &str, arch: &str) -> Option<String> {
    let arch = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return None,
    };
    match os {
        "linux" => Some(format!("jackbird-service-linux-{arch}-static")),
        "macos" => Some(format!("jackbird-service-macos-{arch}")),
        "windows" => Some(format!("jackbird-service-windows-{arch}.exe")),
        _ => None,
    }
}

/// A file's SHA-256 in a `SHA256SUMS` (`<hex>  <name>`, or `<hex> *<name>`), lowercase.
pub fn checksum_for(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (sum, file) = line.trim().split_once(char::is_whitespace)?;
        let file = file.trim_start().trim_start_matches('*');
        (file == name && sum.len() == 64 && sum.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| sum.to_ascii_lowercase())
    })
}

/// Whether `latest` is a later version than `current` (`v0.1.37` and `0.1.36`: by numbers).
pub fn is_newer(latest: &str, current: &str) -> bool {
    let parts = |version: &str| -> Vec<u64> {
        version
            .trim()
            .trim_start_matches('v')
            .split(['.', '-', '+'])
            .map_while(|part| part.parse().ok())
            .collect()
    };
    let (latest, current) = (parts(latest), parts(current));
    !latest.is_empty() && latest > current
}

/// The release `releases/latest` leads to (`…/releases/tag/v0.1.37`); none for anything else.
pub fn release_from_location(location: &str) -> Option<Release> {
    let tag = location
        .split("/releases/tag/")
        .nth(1)?
        .split(['?', '#'])
        .next()?
        .trim_end_matches('/');
    let version = tag.trim_start_matches('v');
    (!tag.is_empty()
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())))
    .then(|| Release {
        version: version.to_owned(),
        tag: tag.to_owned(),
    })
}

// ─── A short HTTPS client ────────────────────────────────────────────────────────────────────────

/// An HTTP answer: its status, its headers (names lowercase) and its body.
#[derive(Debug, PartialEq, Eq)]
pub struct Response {
    /// The status code.
    pub status: u16,
    /// The headers, names lowercase.
    pub headers: Vec<(String, String)>,
    /// The body, unchunked.
    pub body: Vec<u8>,
}

impl Response {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// An answer as read off the connection (to its end): its status line, headers and body, the body
/// unchunked when it came in chunks and cut to its length when one was given.
pub fn parse_response(raw: &[u8]) -> Result<Response, String> {
    let end = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("an answer without its headers' end")?;
    let head = std::str::from_utf8(&raw[..end]).map_err(|_| "headers that are not text")?;
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or("an answer without a status")?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let rest = &raw[end + 4..];
    let mut response = Response {
        status,
        headers,
        body: Vec::new(),
    };
    response.body = if response
        .header("transfer-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("chunked"))
    {
        dechunk(rest)?
    } else if let Some(length) = response
        .header("content-length")
        .and_then(|value| value.parse::<usize>().ok())
    {
        if rest.len() < length {
            return Err(format!("an answer cut short ({} of {length} bytes)", rest.len()));
        }
        rest[..length].to_vec()
    } else {
        rest.to_vec()
    };
    Ok(response)
}

/// A chunked body, whole: each chunk's size in hexadecimal, then its bytes, to the empty one.
pub fn dechunk(mut raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    loop {
        let line = raw
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or("a chunk without its size")?;
        let size = std::str::from_utf8(&raw[..line])
            .ok()
            .and_then(|text| usize::from_str_radix(text.split(';').next().unwrap_or("").trim(), 16).ok())
            .ok_or("a chunk's size that is not a number")?;
        raw = &raw[line + 2..];
        if size == 0 {
            return Ok(body);
        }
        if raw.len() < size + 2 {
            return Err("a chunk cut short".into());
        }
        body.extend_from_slice(&raw[..size]);
        raw = &raw[size + 2..];
    }
}

/// One `GET` over HTTPS, to its end (`Connection: close`), redirects followed.
async fn fetch(url: &str, accept: &str) -> Result<Response, String> {
    let mut url = url.to_owned();
    for _ in 0..5 {
        let response = tokio::time::timeout(Duration::from_secs(120), fetch_once(&url, accept))
            .await
            .map_err(|_| format!("{url}: no answer in time"))??;
        if (300..400).contains(&response.status)
            && let Some(location) = response.header("location")
        {
            url = location.to_owned();
            continue;
        }
        return Ok(response);
    }
    Err(format!("{url}: too many redirects"))
}

async fn fetch_once(url: &str, accept: &str) -> Result<Response, String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| format!("{url}: not an HTTPS address"))?;
    let (authority, path) = rest
        .split_once('/')
        .map_or((rest, "/".to_owned()), |(host, path)| (host, format!("/{path}")));
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if port.bytes().all(|byte| byte.is_ascii_digit()) => (host, port.parse().unwrap_or(443)),
        _ => (authority, 443),
    };
    let mut roots = rustls::RootCertStore::empty();
    for certificate in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(certificate);
    }
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|error| error.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
    let name = rustls::pki_types::ServerName::try_from(host.to_owned()).map_err(|error| format!("{host}: {error}"))?;
    let tcp = tokio::net::TcpStream::connect((host, port))
        .await
        .map_err(|error| format!("{host}: {error}"))?;
    let mut stream = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(name, tcp)
        .await
        .map_err(|error| format!("{host}: {error}"))?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: jackbird-service/{}\r\nAccept: {accept}\r\nConnection: close\r\n\r\n",
        env!("JACKBIRD_VERSION")
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| format!("{host}: {error}"))?;
    let mut raw = Vec::new();
    let mut chunk = vec![0; 64 * 1024];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) => break,
            Ok(read) => {
                raw.extend_from_slice(&chunk[..read]);
                if raw.len() > LIMIT {
                    return Err(format!("{host}: an answer too large"));
                }
            }
            // A server that closes without TLS's goodbye: what came is checked by its length,
            // its chunks or its checksum.
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(format!("{host}: {error}")),
        }
    }
    parse_response(&raw)
}

// ─── The release and the update ──────────────────────────────────────────────────────────────────

/// The latest release, asked again once an hour.
async fn latest() -> Result<Release, String> {
    static KEPT: Mutex<Option<(Instant, Release)>> = Mutex::new(None);
    if let Some((when, release)) = KEPT.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref()
        && when.elapsed() < KEEP
    {
        return Ok(release.clone());
    }
    let response = tokio::time::timeout(
        Duration::from_secs(30),
        fetch_once(&format!("{RELEASES}/latest"), "text/html"),
    )
    .await
    .map_err(|_| "GitHub did not answer in time".to_owned())??;
    let release = response
        .header("location")
        .and_then(release_from_location)
        .ok_or_else(|| format!("GitHub's latest release could not be read ({})", response.status))?;
    *KEPT.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some((Instant::now(), release.clone()));
    Ok(release)
}

/// The release's binary for this system, checked, put in place of `exe`.
async fn apply(exe: &Path, release: &Release) -> Result<(), String> {
    let name =
        asset_name(std::env::consts::OS, std::env::consts::ARCH).ok_or("the release has no binary for this system")?;
    let at = |file: &str| format!("{RELEASES}/download/{}/{file}", release.tag);
    let (sums_url, binary_url) = (at(SUMS), at(&name));
    let sums = fetch(&sums_url, "application/octet-stream").await?;
    if sums.status != 200 {
        return Err("the release has no SHA256SUMS".into());
    }
    let expected = checksum_for(&String::from_utf8_lossy(&sums.body), &name)
        .ok_or_else(|| format!("SHA256SUMS does not list {name}"))?;
    let binary = fetch(&binary_url, "application/octet-stream").await?;
    if binary.status != 200 {
        return Err(format!("the release has no {name} ({})", binary.status));
    }
    let got: String = Sha256::digest(&binary.body)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if got != expected {
        return Err(format!("{name}'s SHA-256 is not the release's"));
    }
    put_in_place(exe, &binary.body)
}

/// Writes `bytes` beside `exe` and moves it into its place, executable. On Windows, which does not
/// let a running program's file be replaced but lets it be moved aside, the old one goes aside first.
pub fn put_in_place(exe: &Path, bytes: &[u8]) -> Result<(), String> {
    let fresh = exe.with_extension("new");
    std::fs::write(&fresh, bytes).map_err(|error| format!("{}: {error}", fresh.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fresh, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("{}: {error}", fresh.display()))?;
    }
    if cfg!(windows) {
        let aside = exe.with_extension("old.exe");
        let _ = std::fs::remove_file(&aside);
        std::fs::rename(exe, &aside).map_err(|error| format!("{}: {error}", exe.display()))?;
    }
    std::fs::rename(&fresh, exe).map_err(|error| format!("{}: {error}", exe.display()))
}

/// Whether an update is under way (one at a time).
static UPDATING: AtomicBool = AtomicBool::new(false);

/// The version, the latest release's, and whether it can update itself.
async fn state() -> Json<Value> {
    let version = env!("JACKBIRD_VERSION");
    let can = here();
    match latest().await {
        Ok(release) => Json(json!({
            "version": version,
            "latest": release.version,
            "newer": is_newer(&release.version, version),
            "can": can.name(),
        })),
        Err(error) => {
            Json(json!({ "version": version, "latest": null, "newer": false, "can": can.name(), "error": error }))
        }
    }
}

/// Updates to the latest release, then exits so that its manager starts the new binary.
async fn update(State(service): State<Arc<Service>>, Extension(person): Extension<Person>) -> Answer<Json<Value>> {
    let refuse = |message: String| ApiError::new(StatusCode::CONFLICT, "update", message);
    let Situation::Yes(exe) = here() else {
        return Err(refuse(format!("this server cannot update itself ({})", here().name())));
    };
    let release = latest().await.map_err(refuse)?;
    if !is_newer(&release.version, env!("JACKBIRD_VERSION")) {
        return Err(refuse("this is the latest version already".into()));
    }
    if UPDATING.swap(true, Ordering::SeqCst) {
        return Err(refuse("an update is under way".into()));
    }
    if let Err(error) = apply(&exe, &release).await {
        UPDATING.store(false, Ordering::SeqCst);
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, "update", error));
    }
    service.store.log(
        &person.name,
        "update",
        "",
        &format!("{} → {}", env!("JACKBIRD_VERSION"), release.version),
    );
    println!("jackbird-service: updated to {}; starting again", release.version);
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(1)).await;
        std::process::exit(RESTART);
    });
    Ok(Json(json!({ "updating": true, "version": release.version })))
}

/// Routes of owners.
pub fn owners() -> Router<Arc<Service>> {
    Router::new().route("/update", axum::routing::get(state).post(update))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_names_the_release_file_for_each_system() {
        assert_eq!(
            asset_name("linux", "x86_64").as_deref(),
            Some("jackbird-service-linux-x64-static")
        );
        assert_eq!(
            asset_name("linux", "aarch64").as_deref(),
            Some("jackbird-service-linux-arm64-static")
        );
        assert_eq!(
            asset_name("macos", "aarch64").as_deref(),
            Some("jackbird-service-macos-arm64")
        );
        assert_eq!(
            asset_name("macos", "x86_64").as_deref(),
            Some("jackbird-service-macos-x64")
        );
        assert_eq!(
            asset_name("windows", "x86_64").as_deref(),
            Some("jackbird-service-windows-x64.exe")
        );
        assert_eq!(asset_name("freebsd", "x86_64"), None);
        assert_eq!(asset_name("linux", "riscv64"), None);
    }

    #[test]
    fn it_reads_a_files_checksum() {
        let sum = "a".repeat(64);
        let sums = format!(
            "{sum}  jackbird-service-macos-arm64\n{}  *jackbird-service-windows-x64.exe\n",
            "B".repeat(64)
        );
        assert_eq!(checksum_for(&sums, "jackbird-service-macos-arm64"), Some(sum));
        assert_eq!(
            checksum_for(&sums, "jackbird-service-windows-x64.exe"),
            Some("b".repeat(64))
        );
        assert_eq!(checksum_for(&sums, "jackbird-service-linux-x64-static"), None);
        assert_eq!(
            checksum_for("xyz  jackbird-service-macos-arm64", "jackbird-service-macos-arm64"),
            None
        );
    }

    #[test]
    fn it_compares_versions_by_their_numbers() {
        assert!(is_newer("v0.1.37", "0.1.36"));
        assert!(is_newer("0.2.0", "0.1.99"));
        assert!(is_newer("0.1.10", "0.1.9"));
        assert!(!is_newer("v0.1.36", "0.1.36"));
        assert!(!is_newer("0.1.35", "0.1.36"));
        assert!(!is_newer("", "0.1.36"));
    }

    #[test]
    fn it_reads_the_release_latest_leads_to() {
        assert_eq!(
            release_from_location("https://github.com/jgermade/jackbird/releases/tag/v0.1.37"),
            Some(Release {
                version: "0.1.37".into(),
                tag: "v0.1.37".into()
            })
        );
        assert_eq!(
            release_from_location("https://github.com/jgermade/jackbird/releases"),
            None
        );
        assert_eq!(release_from_location("https://github.com/x/releases/tag/nightly"), None);
    }

    #[test]
    fn it_reads_an_answer_whole_chunked_or_by_its_length() {
        let plain =
            parse_response(b"HTTP/1.1 302 Found\r\nLocation: https://elsewhere/x\r\nContent-Length: 2\r\n\r\nokEXTRA")
                .unwrap();
        assert_eq!(plain.status, 302);
        assert_eq!(plain.header("location"), Some("https://elsewhere/x"));
        assert_eq!(plain.body, b"ok");
        let chunked = parse_response(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\njack\r\n4;x=y\r\nbird\r\n0\r\n\r\n",
        )
        .unwrap();
        assert_eq!(chunked.body, b"jackbird");
        let to_the_end = parse_response(b"HTTP/1.1 200 OK\r\nServer: x\r\n\r\nall of it").unwrap();
        assert_eq!(to_the_end.body, b"all of it");
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort").is_err());
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\nshort").is_err());
        assert!(parse_response(b"no headers").is_err());
    }

    /// Run by hand (`cargo test -p jackbird-service -- --ignored update`): GitHub asked for real,
    /// and this system's binary of the latest release downloaded through its redirect.
    #[tokio::test]
    #[ignore = "asks GitHub"]
    async fn it_asks_github_and_downloads_through_a_redirect() {
        let release = latest().await.unwrap();
        let name = asset_name(std::env::consts::OS, std::env::consts::ARCH).unwrap();
        let file = fetch(
            &format!("{RELEASES}/download/{}/{name}", release.tag),
            "application/octet-stream",
        )
        .await
        .unwrap();
        println!("{} {name}: {} bytes", release.version, file.body.len());
        assert_eq!(file.status, 200);
        assert!(file.body.len() > 1_000_000);
    }

    #[test]
    fn it_puts_the_new_binary_in_place() {
        let folder = std::env::temp_dir().join(format!("jackbird-update-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let exe = folder.join("jackbird-service");
        std::fs::write(&exe, b"old").unwrap();
        put_in_place(&exe, b"new").unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"new");
        assert!(!exe.with_extension("new").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&exe).unwrap().permissions().mode() & 0o777, 0o755);
        }
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn it_knows_how_it_runs() {
        let home = Path::new("/home/ana");
        let logon = binary_path(
            Os::Linux,
            Way::Logon,
            &crate::install::Person {
                user: String::new(),
                uid: 0,
                home: home.to_path_buf(),
                config: PathBuf::new(),
            },
        );
        let yes = |_: &Path| true;
        assert_eq!(
            situation(Os::Linux, &logon, None, home, yes),
            Situation::Yes(logon.clone())
        );
        assert_eq!(situation(Os::Linux, &logon, None, home, |_| false), Situation::ReadOnly);
        assert_eq!(
            situation(Os::Linux, &logon, Some("0.0.0.0"), home, yes),
            Situation::Container
        );
        assert_eq!(
            situation(Os::Linux, &logon, Some("127.0.0.1"), home, yes),
            Situation::Yes(logon.clone())
        );
        assert_eq!(
            situation(
                Os::Linux,
                Path::new("/usr/local/lib/jackbird/jackbird-service"),
                None,
                home,
                yes
            ),
            Situation::System
        );
        assert_eq!(
            situation(
                Os::Linux,
                Path::new("/home/ana/src/target/debug/jackbird-service"),
                None,
                home,
                yes
            ),
            Situation::Manual
        );
    }
}
