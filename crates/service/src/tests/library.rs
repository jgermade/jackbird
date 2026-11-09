//! The family library through the router (F1): an owner imports a folder of the machine in the
//! background, an editor uploads a song and retitles one, a listener sees the new title, plays a
//! range and downloads a file carrying it; what each role may not do is refused; the files on the
//! machine are never written.

use std::time::Duration;

use super::people::family_with;
use super::*;

/// A folder of the machine with two songs of different audio.
fn two_songs() -> PathBuf {
    let folder = scratch();
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tags");
    for name in ["mp3-v24-padded.mp3", "flac-full.flac"] {
        std::fs::copy(fixtures.join(name), folder.join(name)).unwrap();
    }
    folder
}

fn tags_of(bytes: &[u8]) -> jackbird_tags::Tags {
    let tail = &bytes[bytes.len().saturating_sub(jackbird_tags::TAIL_LEN)..];
    let jackbird_tags::Layout::Known(layout) = jackbird_tags::layout(bytes, tail, bytes.len() as u64).unwrap() else {
        panic!("no layout")
    };
    jackbird_tags::read_head(bytes, &layout).unwrap()
}

#[tokio::test]
async fn a_family_library_imports_plays_and_shares_an_edit() {
    let library = jackbird_store::Library::open(&scratch()).unwrap();
    let (_, app, _, [owner, admin, editor, listener]) = family_with(Some(library)).await;
    let folder = two_songs();
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tags");

    // Only an owner imports a folder of the machine.
    for cookie in [&admin, &editor, &listener] {
        let status = call(Method::POST, "/api/library/import")
            .header("cookie", cookie)
            .json(json!({ "path": folder.display().to_string(), "name": "Music" }))
            .on(&app)
            .await
            .0;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    let (status, started) = call(Method::POST, "/api/library/import")
        .header("cookie", &owner)
        .json(json!({ "path": folder.display().to_string(), "name": "Music" }))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let mut state = Value::Null;
    for _ in 0..100 {
        state = call(Method::GET, "/api/library/import")
            .header("cookie", &listener)
            .value(&app)
            .await
            .1;
        if state["running"] == false {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(state["report"]["added"], 2, "{state}");

    // An editor uploads a song; a listener may not.
    let song = std::fs::read(fixtures.join("mp3-v24-ape.mp3")).unwrap();
    let upload = |cookie: &str| {
        call(Method::POST, "/api/library/upload?path=Uploads%2FLuis%2Fape.mp3")
            .header("cookie", cookie)
            .header("content-type", "application/octet-stream")
    };
    let mut refused = upload(&listener);
    refused.body = Body::from(song.clone());
    assert_eq!(refused.on(&app).await.0, StatusCode::FORBIDDEN);
    let mut request = upload(&editor);
    request.body = Body::from(song.clone());
    let (status, uploaded) = request.value(&app).await;
    assert_eq!(
        (status, uploaded["result"].as_str()),
        (StatusCode::OK, Some("added")),
        "{uploaded}"
    );
    let mut again = upload(&editor);
    again.body = Body::from(song);
    assert_eq!(again.value(&app).await.1["result"], "existing");

    // Everyone sees the library as a root.
    let (_, walked) = call(Method::GET, "/api/library/walk")
        .header("cookie", &listener)
        .value(&app)
        .await;
    let paths: Vec<&str> = walked
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect();
    assert_eq!(
        paths,
        [
            "Music/flac-full.flac",
            "Music/mp3-v24-padded.mp3",
            "Uploads/Luis/ape.mp3"
        ]
    );

    // An editor retitles a song; a listener may not; the listener sees the new title.
    let path = "Music/flac-full.flac";
    let (_, before) = call(Method::POST, "/api/library/inspect")
        .header("cookie", &listener)
        .json(json!({ "path": path }))
        .value(&app)
        .await;
    let mut metadata = before["metadata"].clone();
    metadata["title"] = json!("Retitled by Luis");
    let save = json!({ "path": path, "previous": before["metadata"], "metadata": metadata });
    assert_eq!(
        call(Method::POST, "/api/library/save")
            .header("cookie", &listener)
            .json(save.clone())
            .on(&app)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status, saved) = call(Method::POST, "/api/library/save")
        .header("cookie", &editor)
        .json(save)
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (_, after) = call(Method::POST, "/api/library/inspect")
        .header("cookie", &listener)
        .json(json!({ "path": path }))
        .value(&app)
        .await;
    assert_eq!(after["metadata"]["title"], "Retitled by Luis");
    assert_ne!(after["fullChecksum"], before["fullChecksum"]);

    // Played by ranges, downloaded whole with the new title, the audio as it was.
    let (status, headers, first) = call(Method::GET, format!("/api/library/media?path={}", enc(path)))
        .header("cookie", &listener)
        .header("range", "bytes=0-99")
        .on(&app)
        .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(first.len(), 100);
    let total: usize = headers[header::CONTENT_RANGE]
        .to_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let (status, headers, file) = call(Method::GET, format!("/api/library/download?path={}", enc(path)))
        .header("cookie", &listener)
        .on(&app)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(file.len(), total);
    assert_eq!(&file[..100], &first[..]);
    assert!(
        headers[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .contains("flac-full.flac")
    );
    assert_eq!(tags_of(&file).fields.title, "Retitled by Luis");
    let (status, _, tail) = call(Method::GET, format!("/api/library/media?path={}", enc(path)))
        .header("cookie", &listener)
        .header("range", "bytes=-10")
        .on(&app)
        .await;
    assert_eq!(
        (status, &tail[..]),
        (StatusCode::PARTIAL_CONTENT, &file[file.len() - 10..])
    );
    assert_eq!(
        call(Method::GET, format!("/api/library/media?path={}", enc(path)))
            .header("cookie", &listener)
            .header("range", format!("bytes={}-", total + 5).as_str())
            .on(&app)
            .await
            .0,
        StatusCode::RANGE_NOT_SATISFIABLE
    );
    // The folder on the machine was never written.
    assert_eq!(
        std::fs::read(folder.join("flac-full.flac")).unwrap(),
        std::fs::read(fixtures.join("flac-full.flac")).unwrap()
    );

    // Renames and removals are editors'; the log names who did what.
    assert_eq!(
        call(Method::POST, "/api/library/rename")
            .header("cookie", &listener)
            .json(json!({ "from": path, "to": "Music/Full.flac" }))
            .on(&app)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(Method::POST, "/api/library/rename")
            .header("cookie", &editor)
            .json(json!({ "from": path, "to": "Music/Full.flac" }))
            .on(&app)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    let (_, log) = call(Method::GET, "/api/log").header("cookie", &owner).value(&app).await;
    let actions: Vec<(&str, &str)> = log
        .as_array()
        .unwrap()
        .iter()
        .map(|change| (change["person"].as_str().unwrap(), change["action"].as_str().unwrap()))
        .collect();
    for expected in [
        ("Owner", "import"),
        ("editor", "upload"),
        ("editor", "save"),
        ("editor", "rename"),
    ] {
        assert!(actions.contains(&expected), "{expected:?} in {actions:?}");
    }
    // Signed out: nothing.
    assert_eq!(
        call(Method::GET, "/api/library/walk").on(&app).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn without_a_library_its_routes_say_so() {
    let (_, app, _) = super::people::instance();
    let (status, body) = call(Method::GET, "/api/library").value(&app).await;
    assert_eq!(
        (status, body["code"].as_str()),
        (StatusCode::NOT_FOUND, Some("no-library"))
    );
}
