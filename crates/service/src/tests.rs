//! The service through its router (no socket): its guards, its roots and their persistence, every
//! operation on the shared fixtures, ranged media.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};

use super::*;

const HOST: &str = "localhost:4646";
const ORIGIN: &str = "http://localhost:4646";

fn scratch() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let path = std::env::temp_dir().join(format!(
        "jackbird-service-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

/// A folder holding the shared fixtures' audio files.
fn library() -> String {
    let folder = scratch();
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tags");
    for entry in std::fs::read_dir(fixtures).unwrap().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".mp3") || name.ends_with(".flac") {
            std::fs::copy(entry.path(), folder.join(&name)).unwrap();
        }
    }
    folder.display().to_string()
}

struct Call {
    method: Method,
    uri: String,
    headers: Vec<(&'static str, String)>,
    body: Body,
    peer: Option<std::net::SocketAddr>,
}

fn call(method: Method, uri: impl Into<String>) -> Call {
    Call {
        method,
        uri: uri.into(),
        headers: vec![("host", HOST.into()), ("origin", ORIGIN.into())],
        body: Body::empty(),
        peer: None,
    }
}

impl Call {
    fn json(mut self, value: Value) -> Self {
        self.headers.push(("content-type", "application/json".into()));
        self.body = Body::from(value.to_string());
        self
    }

    fn header(mut self, name: &'static str, value: &str) -> Self {
        self.headers.retain(|(own, _)| *own != name);
        if !value.is_empty() {
            self.headers.push((name, value.into()));
        }
        self
    }

    /// From another machine (or a proxy) at `peer`.
    fn from(mut self, peer: &str) -> Self {
        self.peer = Some(peer.parse().unwrap());
        self
    }

    async fn on(self, app: &Router) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut request = Request::builder().method(self.method).uri(self.uri);
        for (name, value) in self.headers {
            request = request.header(name, value);
        }
        let mut request = request.body(self.body).unwrap();
        if let Some(peer) = self.peer {
            request.extensions_mut().insert(ConnectInfo(peer));
        }
        let response = app.clone().oneshot(request).await.unwrap();
        let (status, headers) = (response.status(), response.headers().clone());
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, headers, body.to_vec())
    }

    async fn value(self, app: &Router) -> (StatusCode, Value) {
        let (status, _, body) = self.on(app).await;
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
    }
}

fn enc(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn app() -> Router {
    router(Service::new(
        config::Config::default(),
        None,
        crate::people::Store::memory(),
    ))
}

#[tokio::test]
async fn the_guards_keep_other_sites_and_other_names_out() {
    let app = app();
    assert_eq!(
        call(Method::GET, "/api/info").value(&app).await.1["name"],
        "jackbird-service"
    );
    // A GET from its own page, or typed in the address bar (no Origin): answered.
    assert_eq!(
        call(Method::GET, "/api/roots").header("origin", "").on(&app).await.0,
        StatusCode::OK
    );
    for host in ["127.0.0.1:4646", "[::1]:4646"] {
        assert_eq!(
            call(Method::GET, "/api/roots")
                .header("host", host)
                .header("origin", "")
                .on(&app)
                .await
                .0,
            StatusCode::OK
        );
    }
    // Another name for it (DNS rebinding), another port: refused.
    for host in ["evil.example:4646", "localhost:80", "localhost", ""] {
        assert_eq!(
            call(Method::GET, "/api/info").header("host", host).on(&app).await.0,
            StatusCode::FORBIDDEN,
            "{host}"
        );
    }
    // Another site: refused, reading or writing.
    assert_eq!(
        call(Method::GET, "/api/roots")
            .header("origin", "https://evil.example")
            .on(&app)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(Method::GET, "/api/roots")
            .header("sec-fetch-site", "cross-site")
            .on(&app)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let open = json!({ "path": library() });
    let (status, body) = call(Method::POST, "/api/roots")
        .header("origin", "http://localhost:9999")
        .json(open.clone())
        .value(&app)
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("outside"))
    );
    // A change with no Origin at all: refused.
    assert_eq!(
        call(Method::POST, "/api/roots")
            .header("origin", "")
            .json(open)
            .on(&app)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn roots_open_close_and_come_back_from_the_configuration() {
    let config = scratch().join("service.json");
    let folder = library();
    let app = router(Service::new(
        config::Config::default(),
        Some(config.clone()),
        crate::people::Store::memory(),
    ));
    let (status, opened) = call(Method::POST, "/api/roots")
        .json(json!({ "path": folder }))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(opened["path"], folder.as_str());
    let saved = config::Config::load(&config).unwrap();
    assert_eq!(saved.roots, std::slice::from_ref(&folder));

    // Restarted from its configuration: the root is open again.
    let again = router(Service::new(
        saved.clone(),
        Some(config.clone()),
        crate::people::Store::memory(),
    ));
    let (_, roots) = call(Method::GET, "/api/roots").value(&again).await;
    assert_eq!(roots[0]["path"], folder.as_str());
    let (status, _) = call(Method::POST, "/api/roots/close")
        .json(json!({ "root": folder }))
        .value(&again)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(config::Config::load(&config).unwrap().roots.is_empty());
    assert_eq!(
        call(Method::GET, format!("/api/walk?root={}", enc(&folder)))
            .on(&again)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (status, body) = call(Method::POST, "/api/roots")
        .json(json!({ "path": "/nowhere/at/all" }))
        .value(&again)
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::NOT_FOUND, Some("not-found"))
    );
}

#[tokio::test]
async fn every_operation_on_the_fixtures() {
    let folder = library();
    let app = app();
    call(Method::POST, "/api/roots")
        .json(json!({ "path": folder }))
        .on(&app)
        .await;
    let root = enc(&folder);

    let (_, walked) = call(Method::GET, format!("/api/walk?root={root}")).value(&app).await;
    assert_eq!(walked.as_array().unwrap().len(), 26);
    let (_, found) = call(Method::POST, "/api/inspect")
        .json(json!({ "root": folder, "path": "mp3-v23-padded.mp3" }))
        .value(&app)
        .await;
    assert_eq!(found["metadata"]["title"], "Before");
    assert!(
        found["metadata"]["coverDataUrl"]
            .as_str()
            .unwrap()
            .starts_with("data:image/jpeg;base64,")
    );
    assert_eq!(found["audioChecksum"].as_str().unwrap().len(), 40);
    let known = found["fullChecksum"].clone();
    let (_, again) = call(Method::POST, "/api/inspect")
        .json(json!({ "root": folder, "path": "mp3-v23-padded.mp3", "known": known }))
        .value(&app)
        .await;
    assert_eq!(again["metadata"], Value::Null);

    let previous = found["metadata"].clone();
    let mut wanted = previous.clone();
    wanted["title"] = json!("Saved by the service");
    let (status, saved) = call(Method::POST, "/api/save")
        .json(json!({ "root": folder, "path": "mp3-v23-padded.mp3", "previous": previous, "metadata": wanted }))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["metadata"]["title"], "Saved by the service");
    assert_eq!(saved["audioChecksum"], found["audioChecksum"]);
    let mut odd = previous.clone();
    odd["year"] = json!("c. 1959");
    let (status, refused) = call(Method::POST, "/api/save")
        .json(json!({ "root": folder, "path": "mp3-v23-padded.mp3", "previous": previous, "metadata": odd }))
        .value(&app)
        .await;
    assert_eq!(
        (status, refused["code"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid-year"))
    );

    // Small files, and paths that leave the root.
    let meta = format!("/api/write?root={root}&path={}", enc(".meta/mp3-manager.json"));
    let big = vec![b'x'; 3 << 20];
    let mut writing = call(Method::POST, meta);
    writing.body = Body::from(big.clone());
    assert_eq!(writing.on(&app).await.0, StatusCode::NO_CONTENT);
    let (_, _, read) = call(
        Method::GET,
        format!("/api/read?root={root}&path={}", enc(".meta/mp3-manager.json")),
    )
    .on(&app)
    .await;
    assert_eq!(read, big);
    let (_, stat) = call(
        Method::GET,
        format!("/api/stat?root={root}&path={}", enc(".meta/mp3-manager.json")),
    )
    .value(&app)
    .await;
    assert_eq!(
        (stat["kind"].as_str(), stat["size"].as_u64()),
        (Some("file"), Some(3 << 20))
    );
    assert_eq!(
        call(Method::GET, format!("/api/stat?root={root}&path=none"))
            .value(&app)
            .await
            .1,
        Value::Null
    );
    assert_eq!(
        call(Method::POST, format!("/api/mkdir?root={root}&path=Jazz"))
            .on(&app)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    let (status, _) = call(Method::POST, "/api/rename")
        .json(json!({ "root": folder, "from": "mp3-no-tag.mp3", "to": "Jazz/untagged.mp3" }))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, listed) = call(Method::GET, format!("/api/list?root={root}&path=Jazz"))
        .value(&app)
        .await;
    assert_eq!(listed[0]["path"], "Jazz/untagged.mp3");
    assert_eq!(
        call(
            Method::POST,
            format!("/api/delete?root={root}&path={}", enc("Jazz/untagged.mp3"))
        )
        .on(&app)
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    for outside in ["../x", "/etc/passwd", "a/../../b"] {
        let (status, body) = call(Method::GET, format!("/api/read?root={root}&path={}", enc(outside)))
            .value(&app)
            .await;
        assert_eq!(
            (status, body["code"].as_str()),
            (StatusCode::FORBIDDEN, Some("outside")),
            "{outside}"
        );
    }
}

#[tokio::test]
async fn media_is_served_with_ranges() {
    let folder = library();
    let app = app();
    call(Method::POST, "/api/roots")
        .json(json!({ "path": folder }))
        .on(&app)
        .await;
    let uri = format!("/api/media?root={}&path={}", enc(&folder), enc("flac-full.flac"));
    let size = std::fs::metadata(PathBuf::from(&folder).join("flac-full.flac"))
        .unwrap()
        .len();
    let (status, headers, body) = call(Method::GET, uri.clone()).header("origin", "").on(&app).await;
    assert_eq!((status, body.len() as u64), (StatusCode::OK, size));
    assert!(headers[header::CONTENT_TYPE].to_str().unwrap().contains("flac"));
    let (status, headers, body) = call(Method::GET, uri)
        .header("origin", "")
        .header("range", "bytes=4-13")
        .on(&app)
        .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(headers[header::CONTENT_RANGE], format!("bytes 4-13/{size}").as_str());
    assert_eq!(body.len(), 10);
    let outside = format!("/api/media?root={}&path={}", enc(&folder), enc("../secret"));
    assert_eq!(call(Method::GET, outside).on(&app).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn folders_of_the_machine_are_listed_for_the_dialog() {
    let folder = scratch();
    for name in ["Music", "audio", ".hidden"] {
        std::fs::create_dir_all(folder.join(name)).unwrap();
    }
    std::fs::write(folder.join("file.txt"), b"x").unwrap();
    let app = app();
    let (_, listed) = call(
        Method::GET,
        format!("/api/folders?path={}", enc(&folder.display().to_string())),
    )
    .value(&app)
    .await;
    let names: Vec<&str> = listed["folders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|one| one["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["audio", "Music"]);
    assert_eq!(
        listed["parent"].as_str(),
        folder.parent().map(|parent| parent.to_str().unwrap())
    );
    let (status, _) = call(Method::GET, "/api/folders").value(&app).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = call(Method::GET, "/api/folders?path=%2Fnowhere%2Fat%2Fall")
        .value(&app)
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::NOT_FOUND, Some("not-found"))
    );
}

#[tokio::test]
async fn the_desktop_apps_page_is_answered_with_cors_for_itself_alone() {
    let app = app();
    for desktop in ["tauri://localhost", "http://tauri.localhost"] {
        let (status, headers, _) = call(Method::OPTIONS, "/api/roots")
            .header("origin", desktop)
            .header("sec-fetch-site", "cross-site")
            .on(&app)
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{desktop}");
        assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], desktop);
        let (status, headers, _) = call(Method::GET, "/api/roots")
            .header("origin", desktop)
            .header("sec-fetch-site", "cross-site")
            .on(&app)
            .await;
        assert_eq!(status, StatusCode::OK, "{desktop}");
        assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], desktop);
        let open = call(Method::POST, "/api/roots")
            .header("origin", desktop)
            .json(json!({ "path": library() }));
        assert_eq!(open.on(&app).await.0, StatusCode::OK, "{desktop}");
    }
    // Its own page gets no CORS headers; another origin, even one like the app's, nothing.
    let (_, headers, _) = call(Method::GET, "/api/roots").on(&app).await;
    assert!(headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    for other in ["tauri://evil", "http://tauri.localhost.evil.example", "null"] {
        assert_eq!(
            call(Method::GET, "/api/roots").header("origin", other).on(&app).await.0,
            StatusCode::FORBIDDEN,
            "{other}"
        );
    }
}

mod people;
