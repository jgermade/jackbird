//! OpenSubsonic (E6's spike): an app signs in with a key its person made in "My account", lists the
//! library as artists, albums and songs, plays a song, stars it and counts a play; wrong or
//! missing keys and salted tokens get the API's own errors; answers are XML unless JSON is asked.

use super::people::family_with;
use super::*;

/// A request as a phone's app makes it: no page, no origin.
fn app_call(method: Method, uri: impl Into<String>) -> Call {
    Call {
        method,
        uri: uri.into(),
        headers: vec![("host", HOST.into())],
        body: Body::empty(),
        peer: None,
    }
}

async fn rest(app: &Router, query: &str) -> Value {
    let (status, body) = app_call(Method::GET, format!("/rest/{query}")).value(app).await;
    assert_eq!(status, StatusCode::OK, "{query}");
    body["subsonic-response"].clone()
}

#[tokio::test]
async fn an_app_browses_plays_stars_and_scrobbles_with_a_key() {
    let library = jackbird_store::Library::open(&scratch()).unwrap();
    let folder = scratch();
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tags");
    for name in ["mp3-v24-padded.mp3", "flac-full.flac"] {
        std::fs::copy(fixtures.join(name), folder.join(name)).unwrap();
    }
    library
        .import_folder(&folder, "Music", "owner", None, |_, _| ())
        .unwrap();
    let (service, app, _, [_, _, _, listener]) = family_with(Some(library)).await;

    // The listener makes a key for the app; it is shown once.
    let (status, made) = call(Method::POST, "/api/me/keys")
        .header("cookie", &listener)
        .json(json!({ "name": "Symfonium" }))
        .value(&app)
        .await;
    assert_eq!(status, StatusCode::OK, "{made}");
    let key = made["secret"].as_str().unwrap().to_string();
    let (_, keys) = call(Method::GET, "/api/me/keys")
        .header("cookie", &listener)
        .value(&app)
        .await;
    assert_eq!(keys[0]["name"], "Symfonium");
    assert!(keys[0].get("secret").is_none());
    let with = |method: &str, rest: &str| format!("{method}.view?apiKey={}&f=json&v=1.16.1&c=test{rest}", enc(&key));

    let ping = rest(&app, &with("ping", "")).await;
    assert_eq!(ping["status"], "ok", "{ping}");
    assert_eq!(ping["openSubsonic"], true);
    let extensions = rest(&app, &with("getOpenSubsonicExtensions", "")).await;
    assert_eq!(extensions["openSubsonicExtensions"][0]["name"], "apiKeyAuthentication");

    // The ways in that are not a key, or not this one.
    let refused = rest(&app, "ping.view?apiKey=wrong&f=json").await;
    assert_eq!(
        (refused["status"].as_str(), refused["error"]["code"].as_u64()),
        (Some("failed"), Some(44))
    );
    let tokens = rest(&app, "ping.view?u=listener&t=abc&s=def&f=json").await;
    assert_eq!(tokens["error"]["code"], 41);
    let missing = rest(&app, "ping.view?f=json").await;
    assert_eq!(missing["error"]["code"], 10);
    let both = rest(&app, &format!("ping.view?u=listener&apiKey={}&f=json", enc(&key))).await;
    assert_eq!(both["error"]["code"], 43);
    // The key as a password, plain or hex-encoded, for apps that ask for one.
    let plain = rest(&app, &format!("ping.view?u=listener&p={}&f=json", enc(&key))).await;
    assert_eq!(plain["status"], "ok", "{plain}");
    let hex: String = key.bytes().map(|byte| format!("{byte:02x}")).collect();
    let encoded = rest(&app, &format!("ping.view?u=LISTENER%40X.ES&p=enc:{hex}&f=json")).await;
    assert_eq!(encoded["status"], "ok", "{encoded}");
    let someone_else = rest(&app, &format!("ping.view?u=owner&p={}&f=json", enc(&key))).await;
    assert_eq!(someone_else["error"]["code"], 40);

    // XML, unless JSON is asked.
    let (status, _, body) = app_call(Method::GET, format!("/rest/ping.view?apiKey={}", enc(&key)))
        .on(&app)
        .await;
    let xml = String::from_utf8(body).unwrap();
    assert_eq!(status, StatusCode::OK);
    assert!(
        xml.starts_with("<?xml")
            && xml.contains("status=\"ok\"")
            && xml.contains("xmlns=\"http://subsonic.org/restapi\""),
        "{xml}"
    );

    // Browsing: artists, an artist's albums, an album's songs, a song.
    let artists = rest(&app, &with("getArtists", "")).await;
    let index = artists["artists"]["index"].as_array().unwrap();
    let artist = &index[0]["artist"][0];
    assert!(artist["id"].as_str().unwrap().starts_with("ar-"), "{artists}");
    let albums = rest(
        &app,
        &with("getArtist", &format!("&id={}", artist["id"].as_str().unwrap())),
    )
    .await;
    let album_id = albums["artist"]["album"][0]["id"].as_str().unwrap().to_string();
    let album = rest(&app, &with("getAlbum", &format!("&id={album_id}"))).await;
    let songs = album["album"]["song"].as_array().unwrap().clone();
    assert!(!songs.is_empty(), "{album}");
    let song_id = songs[0]["id"].as_str().unwrap().to_string();
    let song = rest(&app, &with("getSong", &format!("&id={song_id}"))).await;
    assert_eq!(song["song"]["albumId"], album_id.as_str());
    let everything = rest(&app, &with("search3", "&query=%22%22&songCount=100")).await;
    assert_eq!(everything["searchResult3"]["song"].as_array().unwrap().len(), 2);
    let newest = rest(&app, &with("getAlbumList2", "&type=newest&size=5")).await;
    assert!(!newest["albumList2"]["album"].as_array().unwrap().is_empty());

    // Playing: the song as it leaves (the family's tags), in ranges.
    let (status, headers, bytes) = app_call(
        Method::GET,
        format!("/rest/{}", with("stream", &format!("&id={song_id}"))),
    )
    .header("range", "bytes=0-3")
    .on(&app)
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert!(headers[header::CONTENT_TYPE].to_str().unwrap().starts_with("audio/"));
    assert_eq!(bytes.len(), 4);
    let (status, _, _) = app_call(
        Method::GET,
        format!("/rest/{}", with("getCoverArt", &format!("&id={album_id}"))),
    )
    .on(&app)
    .await;
    assert!(status == StatusCode::OK || status == StatusCode::NOT_FOUND);

    // Starring and counting a play are the listener's own (F3); a form post works as a query does.
    let mut star =
        app_call(Method::POST, "/rest/star.view").header("content-type", "application/x-www-form-urlencoded");
    star.body = Body::from(format!("apiKey={}&f=json&id={song_id}", enc(&key)));
    let (status, starred) = star.value(&app).await;
    assert_eq!(
        (status, starred["subsonic-response"]["status"].as_str()),
        (StatusCode::OK, Some("ok"))
    );
    let starred = rest(&app, &with("getStarred2", "")).await;
    assert_eq!(starred["starred2"]["song"][0]["id"], song_id.as_str());
    rest(&app, &with("scrobble", &format!("&id={song_id}"))).await;
    let library = service.library.clone().unwrap();
    let listener_id = service.store.person_by_email("listener@x.es").unwrap().id;
    assert_eq!(library.history(listener_id, 10).unwrap().len(), 1);
    rest(&app, &with("unstar", &format!("&id={song_id}"))).await;
    let starred = rest(&app, &with("getStarred2", "")).await;
    assert!(starred["starred2"]["song"].as_array().unwrap().is_empty());

    // A key removed opens nothing.
    let id = keys[0]["id"].as_i64().unwrap();
    call(Method::POST, "/api/me/keys/remove")
        .header("cookie", &listener)
        .json(json!({ "id": id }))
        .on(&app)
        .await;
    assert_eq!(rest(&app, &with("ping", "")).await["error"]["code"], 44);
}
