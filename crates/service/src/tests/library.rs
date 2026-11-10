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
        .filter(|path| jackbird_store::is_audio(path))
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

/// F3: each person's own, through the router.
#[tokio::test]
async fn each_person_has_their_own_version_favourites_plays_and_playlists() {
    let library = jackbird_store::Library::open(&scratch()).unwrap();
    let (_, app, _, [owner, _, editor, listener]) = family_with(Some(library)).await;
    let folder = two_songs();
    call(Method::POST, "/api/library/import")
        .header("cookie", &owner)
        .json(json!({ "path": folder.display().to_string(), "name": "Music" }))
        .on(&app)
        .await;
    for _ in 0..100 {
        let state = call(Method::GET, "/api/library/import")
            .header("cookie", &owner)
            .value(&app)
            .await
            .1;
        if state["running"] == false {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let path = "Music/flac-full.flac";
    let inspect = |cookie: &str| {
        call(Method::POST, "/api/library/inspect")
            .header("cookie", cookie)
            .json(json!({ "path": path }))
    };
    let title_for = |value: Value| value["metadata"]["title"].as_str().unwrap_or_default().to_owned();
    let before = inspect(&editor).value(&app).await.1;
    let retitled = |title: &str, scope: &str| {
        let mut metadata = before["metadata"].clone();
        metadata["title"] = json!(title);
        json!({ "path": path, "previous": before["metadata"], "metadata": metadata, "scope": scope })
    };
    // The editor saves for everyone; the listener, for themselves only.
    let (status, _) = call(Method::POST, "/api/library/save")
        .header("cookie", &editor)
        .json(retitled("The family's", "family"))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        call(Method::POST, "/api/library/save")
            .header("cookie", &listener)
            .json(retitled("Not allowed", "family"))
            .on(&app)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status, saved) = call(Method::POST, "/api/library/save")
        .header("cookie", &listener)
        .json(retitled("The kids' own", "mine"))
        .value(&app)
        .await;
    assert_eq!((status, title_for(saved)), (StatusCode::OK, "The kids' own".to_owned()));
    // Two people, the same song, two titles; the family's untouched.
    assert_eq!(title_for(inspect(&listener).value(&app).await.1), "The kids' own");
    assert_eq!(title_for(inspect(&editor).value(&app).await.1), "The family's");
    assert_eq!(title_for(inspect(&owner).value(&app).await.1), "The family's");
    let (_, layers) = call(Method::GET, format!("/api/library/layers?path={}", enc(path)))
        .header("cookie", &listener)
        .value(&app)
        .await;
    assert_eq!(layers["mine"]["title"], "The kids' own");
    assert_eq!(layers["family"]["title"], "The family's");
    // The switch: the family's version; and back.
    let (_, settings) = call(Method::POST, "/api/me/settings")
        .header("cookie", &listener)
        .json(json!({ "mine": false, "theme": "dark", "language": "es" }))
        .value(&app)
        .await;
    assert_eq!(
        (settings["mine"].as_bool(), settings["theme"].as_str()),
        (Some(false), Some("dark"))
    );
    assert_eq!(title_for(inspect(&listener).value(&app).await.1), "The family's");
    let (_, me) = call(Method::GET, "/api/me")
        .header("cookie", &listener)
        .value(&app)
        .await;
    assert_eq!(me["settings"]["language"], "es");
    call(Method::POST, "/api/me/settings")
        .header("cookie", &listener)
        .json(json!({ "mine": true }))
        .on(&app)
        .await;
    assert_eq!(title_for(inspect(&listener).value(&app).await.1), "The kids' own");
    // Downloads as each sees it.
    let (_, _, theirs) = call(Method::GET, format!("/api/library/download?path={}", enc(path)))
        .header("cookie", &listener)
        .on(&app)
        .await;
    assert_eq!(tags_of(&theirs).fields.title, "The kids' own");
    call(Method::POST, "/api/library/mine/forget")
        .header("cookie", &listener)
        .json(json!({ "path": path }))
        .on(&app)
        .await;
    assert_eq!(title_for(inspect(&listener).value(&app).await.1), "The family's");

    // Favourites and plays, the listener's own; their playlists in their own folder.
    assert_eq!(
        call(Method::POST, "/api/library/favourite")
            .header("cookie", &listener)
            .json(json!({ "path": path, "on": true }))
            .on(&app)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    call(Method::POST, "/api/library/played")
        .header("cookie", &listener)
        .json(json!({ "path": path }))
        .on(&app)
        .await;
    let read = |cookie: &str, file: &str| {
        call(Method::GET, format!("/api/library/read?path={}", enc(file))).header("cookie", cookie)
    };
    let (_, _, favourites) = read(&listener, "My playlists/Favourites.m3u").on(&app).await;
    assert_eq!(
        String::from_utf8(favourites).unwrap(),
        "#EXTM3U\n../Music/flac-full.flac\n"
    );
    let (_, _, recent) = read(&listener, "My playlists/Recently played.m3u").on(&app).await;
    assert!(String::from_utf8(recent).unwrap().contains("flac-full.flac"));
    let (_, _, editors) = read(&editor, "My playlists/Favourites.m3u").on(&app).await;
    assert_eq!(String::from_utf8(editors).unwrap(), "#EXTM3U\n");
    let write = |cookie: &str, file: &str| {
        let mut request = call(Method::POST, format!("/api/library/write?path={}", enc(file))).header("cookie", cookie);
        request.body = Body::from("#EXTM3U\n../Music/mp3-v24-padded.mp3\n");
        request
    };
    assert_eq!(
        write(&listener, "My playlists/Road.m3u").on(&app).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        write(&listener, "Music/Shared.m3u").on(&app).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        write(&editor, "Music/Shared.m3u").on(&app).await.0,
        StatusCode::NO_CONTENT
    );
    let walked = |cookie: &str| call(Method::GET, "/api/library/walk").header("cookie", cookie);
    let theirs: Vec<String> = walked(&listener)
        .value(&app)
        .await
        .1
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap().to_owned())
        .collect();
    assert!(theirs.contains(&"My playlists/Road.m3u".to_owned()) && theirs.contains(&"Music/Shared.m3u".to_owned()));
    let editors: Vec<String> = walked(&editor)
        .value(&app)
        .await
        .1
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap().to_owned())
        .collect();
    assert!(!editors.contains(&"My playlists/Road.m3u".to_owned()));
    // Their history, cleared.
    call(Method::POST, "/api/library/history/clear")
        .header("cookie", &listener)
        .on(&app)
        .await;
    let (_, _, recent) = read(&listener, "My playlists/Recently played.m3u").on(&app).await;
    assert_eq!(String::from_utf8(recent).unwrap(), "#EXTM3U\n");
    // Suggestions are applied by editors only.
    assert_eq!(
        call(Method::POST, "/api/library/suggestions/apply")
            .header("cookie", &listener)
            .json(json!({ "path": path, "id": 1 }))
            .on(&app)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

/// F4: stale saves and writes, the trash, snapshots, the scrub and the export, through the router.
#[tokio::test]
async fn edits_on_old_versions_are_refused_and_the_library_is_kept_safe() {
    let dir = scratch();
    let library = jackbird_store::Library::open(&dir).unwrap();
    let (_, app, _, [owner, admin, editor, listener]) = family_with(Some(library)).await;
    let folder = two_songs();
    call(Method::POST, "/api/library/import")
        .header("cookie", &owner)
        .json(json!({ "path": folder.display().to_string(), "name": "Music" }))
        .on(&app)
        .await;
    for _ in 0..100 {
        let state = call(Method::GET, "/api/library/import")
            .header("cookie", &owner)
            .value(&app)
            .await
            .1;
        if state["running"] == false {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let path = "Music/flac-full.flac";
    let (_, read) = call(Method::POST, "/api/library/inspect")
        .header("cookie", &editor)
        .json(json!({ "path": path }))
        .value(&app)
        .await;
    let save = |title: &str, expected: &Value| {
        let mut metadata = read["metadata"].clone();
        metadata["title"] = json!(title);
        json!({ "path": path, "previous": read["metadata"], "metadata": metadata, "expected": expected })
    };
    // The owner saves first; the editor's save, made on what they read before, is refused.
    let (status, _) = call(Method::POST, "/api/library/save")
        .header("cookie", &owner)
        .json(save("The owner's", &read["fullChecksum"]))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, refused) = call(Method::POST, "/api/library/save")
        .header("cookie", &editor)
        .json(save("The editor's", &read["fullChecksum"]))
        .value(&app)
        .await;
    assert_eq!(
        (status, refused["code"].as_str()),
        (StatusCode::CONFLICT, Some("stale"))
    );
    assert_eq!(refused["by"], "Owner");
    assert_eq!(refused["current"]["metadata"]["title"], "The owner's");
    assert!(refused["message"].as_str().unwrap().contains("Owner"));

    // A shared playlist changed since it was read is not written over.
    let write = |cookie: &str, query: String, text: &'static str| {
        let mut request = call(Method::POST, format!("/api/library/write?{query}")).header("cookie", cookie);
        request.body = Body::from(text);
        request
    };
    let list = "path=Music%2FShared.m3u";
    assert_eq!(
        write(&editor, list.into(), "#EXTM3U\n").on(&app).await.0,
        StatusCode::NO_CONTENT
    );
    let (_, stat) = call(Method::GET, format!("/api/library/stat?{list}"))
        .header("cookie", &editor)
        .value(&app)
        .await;
    let read_at = format!("{list}&size={}&mtime={}", stat["size"], stat["mtime"]);
    assert_eq!(
        write(&admin, read_at.clone(), "#EXTM3U\n../a.mp3\n").on(&app).await.0,
        StatusCode::NO_CONTENT
    );
    let (status, body) = write(&editor, read_at, "#EXTM3U\n../b.mp3\n../c.mp3\n")
        .value(&app)
        .await;
    assert_eq!((status, body["code"].as_str()), (StatusCode::CONFLICT, Some("stale")));

    // Deleted into the trash: admins restore it, listeners and editors may not.
    assert_eq!(
        call(Method::POST, format!("/api/library/delete?path={}", enc(path)))
            .header("cookie", &editor)
            .on(&app)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    for cookie in [&listener, &editor] {
        assert_eq!(
            call(Method::GET, "/api/library/trash")
                .header("cookie", cookie)
                .on(&app)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    let (_, trash) = call(Method::GET, "/api/library/trash")
        .header("cookie", &admin)
        .value(&app)
        .await;
    assert_eq!(
        (trash[0]["path"].as_str(), trash[0]["by"].as_str()),
        (Some(path), Some("editor"))
    );
    let (status, restored) = call(Method::POST, "/api/library/trash/restore")
        .header("cookie", &admin)
        .json(json!({ "id": trash[0]["id"] }))
        .value(&app)
        .await;
    assert_eq!((status, restored["path"].as_str()), (StatusCode::OK, Some(path)));
    let (_, trash) = call(Method::GET, "/api/library/trash")
        .header("cookie", &admin)
        .value(&app)
        .await;
    assert!(trash.as_array().unwrap().is_empty());

    // Snapshots, the scrub and the export are owners'.
    for cookie in [&admin, &editor] {
        assert_eq!(
            call(Method::POST, "/api/library/backups/snapshot")
                .header("cookie", cookie)
                .on(&app)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    let (status, backups) = call(Method::POST, "/api/library/backups/snapshot")
        .header("cookie", &owner)
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK, "{backups}");
    let snapshot = dir.join("backups").join(backups["snapshots"][0].as_str().unwrap());
    assert!(snapshot.join("catalogue.db").exists() && snapshot.join("jackbird.db").exists());
    call(Method::POST, "/api/library/backups/scrub")
        .header("cookie", &owner)
        .on(&app)
        .await;
    let to = scratch();
    call(Method::POST, "/api/library/export")
        .header("cookie", &owner)
        .json(json!({ "path": to.display().to_string() }))
        .on(&app)
        .await;
    let mut state = Value::Null;
    for _ in 0..200 {
        state = call(Method::GET, "/api/library/backups")
            .header("cookie", &owner)
            .value(&app)
            .await
            .1;
        if state["export"]["running"] == false && state["scrub"]["running"] == false && !state["scrub"]["at"].is_null()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(state["export"]["result"]["written"], 2, "{state}");
    assert_eq!(state["scrub"]["result"], json!([]), "{state}");
}
