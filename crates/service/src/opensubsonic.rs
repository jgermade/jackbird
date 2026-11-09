//! The family library over OpenSubsonic (E6's spike, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md,
//! 2026-11-09): enough of the API for the apps that speak it (Symfonium, Tempus, Amperfy,
//! Feishin…) to browse the library, play it, star songs and count plays, each person with their own
//! favourites and history (F3). jackbird has no passwords, so the way in is a key a person makes in
//! "My account" (`apiKeyAuthentication`), or that key given as `p` by the apps that only ask for a
//! user and a password. Salted tokens (`t`, `s`) need the password itself, which jackbird never has:
//! they are refused with the code the specification gives for it.
//!
//! Ids: a song's is its number in the catalogue; an album's (`al-…`) and an artist's (`ar-…`) are
//! made from their names, as the catalogue has no albums or artists of its own. Answers are JSON
//! (`f=json`) or XML, the API's default.

use std::collections::{BTreeMap, HashSet};
use std::fmt::Write as _;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use jackbird_store::{FieldsJson, Library, Song};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::people::{Person, Role};
use crate::{Service, blocking, library_api};

/// The Subsonic version the answers follow.
const VERSION: &str = "1.16.1";

/// What a request asked, from its query and, with `formPost`, its body.
struct Params(Vec<(String, String)>);

impl Params {
    fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn all(&self, name: &str) -> Vec<&str> {
        self.0
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
            .collect()
    }

    fn number(&self, name: &str, default: usize) -> usize {
        self.get(name).and_then(|value| value.parse().ok()).unwrap_or(default)
    }

    fn json(&self) -> bool {
        self.get("f") == Some("json")
    }
}

// ---------------------------------------------------------------------------------------------
// Answers.

fn envelope(status: &str, body: Value) -> Value {
    let mut answer = Map::new();
    answer.insert("status".into(), json!(status));
    answer.insert("version".into(), json!(VERSION));
    answer.insert("type".into(), json!("jackbird"));
    answer.insert("serverVersion".into(), json!(env!("CARGO_PKG_VERSION")));
    answer.insert("openSubsonic".into(), json!(true));
    if let Value::Object(body) = body {
        answer.extend(body);
    }
    json!({ "subsonic-response": answer })
}

fn respond(params: &Params, status: &str, body: Value) -> Response {
    let value = envelope(status, body);
    if params.json() {
        return axum::Json(value).into_response();
    }
    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    element(&mut xml, "subsonic-response", &value["subsonic-response"], true);
    ([(header::CONTENT_TYPE, "application/xml; charset=utf-8")], xml).into_response()
}

fn ok(params: &Params, body: Value) -> Response {
    respond(params, "ok", body)
}

/// A failure as the API gives it: HTTP 200, `status="failed"` and the error's code.
fn failed(params: &Params, code: u32, message: &str) -> Response {
    let mut error = json!({ "code": code, "message": message });
    if matches!(code, 41..=44) {
        error["helpUrl"] = json!("https://github.com/jgermade/jackbird/blob/main/docs/opensubsonic.md");
    }
    respond(params, "failed", json!({ "error": error }))
}

fn escape(text: &str, into: &mut String) {
    for character in text.chars() {
        match character {
            '&' => into.push_str("&amp;"),
            '<' => into.push_str("&lt;"),
            '>' => into.push_str("&gt;"),
            '"' => into.push_str("&quot;"),
            _ => into.push(character),
        }
    }
}

/// JSON as Subsonic's XML: an object's plain values are its attributes, its objects its children,
/// and its lists repeated children of the list's name.
fn element(xml: &mut String, name: &str, value: &Value, root: bool) {
    let _ = write!(xml, "<{name}");
    if root {
        xml.push_str(" xmlns=\"http://subsonic.org/restapi\"");
    }
    let mut children = Vec::new();
    if let Value::Object(fields) = value {
        for (key, field) in fields {
            match field {
                Value::Object(_) => children.push((key, field)),
                Value::Array(items) => children.extend(items.iter().map(|item| (key, item))),
                Value::Null => {}
                Value::String(text) => {
                    let _ = write!(xml, " {key}=\"");
                    escape(text, xml);
                    xml.push('"');
                }
                other => {
                    let _ = write!(xml, " {key}=\"{other}\"");
                }
            }
        }
    }
    if children.is_empty() {
        xml.push_str("/>");
        return;
    }
    xml.push('>');
    for (key, child) in children {
        if child.is_object() {
            element(xml, key, child, false);
        } else {
            let _ = write!(xml, "<{key}>");
            escape(child.to_string().trim_matches('"'), xml);
            let _ = write!(xml, "</{key}>");
        }
    }
    let _ = write!(xml, "</{name}>");
}

// ---------------------------------------------------------------------------------------------
// The way in.

/// The person a request is for, or the API's error for it.
fn person(service: &Service, params: &Params) -> Result<Person, (u32, &'static str)> {
    let key = params.get("apiKey");
    let user = params.get("u");
    if key.is_some() && user.is_some() {
        return Err((43, "Multiple conflicting authentication mechanisms provided"));
    }
    if let Some(key) = key {
        return service.store.person_by_key(key).ok_or((44, "Invalid API key"));
    }
    let Some(user) = user else {
        return Err((10, "Required parameter is missing: u or apiKey"));
    };
    if params.get("t").is_some() || params.get("s").is_some() {
        return Err((
            41,
            "Token authentication is not supported: use an API key made in jackbird's My account",
        ));
    }
    let Some(password) = params.get("p") else {
        return Err((10, "Required parameter is missing: p"));
    };
    let password = match password.strip_prefix("enc:") {
        Some(hex) => from_hex(hex).ok_or((40, "Wrong username or password"))?,
        None => password.to_string(),
    };
    let found = service
        .store
        .person_by_key(&password)
        .ok_or((40, "Wrong username or password"))?;
    let named = found.name.eq_ignore_ascii_case(user)
        || found
            .email
            .as_deref()
            .is_some_and(|email| email.eq_ignore_ascii_case(user));
    if named {
        Ok(found)
    } else {
        Err((40, "Wrong username or password"))
    }
}

fn from_hex(hex: &str) -> Option<String> {
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|at| hex.get(at..at + 2).and_then(|pair| u8::from_str_radix(pair, 16).ok()))
        .collect::<Option<Vec<u8>>>()?;
    String::from_utf8(bytes).ok()
}

// ---------------------------------------------------------------------------------------------
// The catalogue as artists, albums and songs.

const UNKNOWN_ARTIST: &str = "Unknown artist";
const UNKNOWN_ALBUM: &str = "Unknown album";

fn id_of(prefix: &str, text: &str) -> String {
    let digest = Sha256::digest(text.to_lowercase().as_bytes());
    let mut id = String::from(prefix);
    for byte in &digest[..8] {
        let _ = write!(id, "{byte:02x}");
    }
    id
}

struct Album {
    id: String,
    name: String,
    artist: String,
    artist_id: String,
    songs: Vec<usize>,
}

struct Catalogue {
    songs: Vec<(Song, FieldsJson)>,
    /// Artists by id: their name and their albums' ids.
    artists: BTreeMap<String, (String, Vec<String>)>,
    albums: BTreeMap<String, Album>,
    starred: HashSet<String>,
}

fn catalogue(library: &Library, person: i64) -> Result<Catalogue, jackbird_core::Error> {
    let songs: Vec<(Song, FieldsJson)> = library
        .songs()?
        .into_iter()
        .map(|song| {
            let fields = song.fields();
            (song, fields)
        })
        .collect();
    let mut artists: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
    let mut albums: BTreeMap<String, Album> = BTreeMap::new();
    for (at, (_, fields)) in songs.iter().enumerate() {
        let artist = non_empty(&fields.artist, UNKNOWN_ARTIST);
        let name = non_empty(&fields.album, UNKNOWN_ALBUM);
        let artist_id = id_of("ar-", &artist);
        let album_id = id_of("al-", &format!("{artist}\u{0}{name}"));
        let album = albums.entry(album_id.clone()).or_insert_with(|| Album {
            id: album_id.clone(),
            name,
            artist: artist.clone(),
            artist_id: artist_id.clone(),
            songs: Vec::new(),
        });
        album.songs.push(at);
        let entry = artists.entry(artist_id).or_insert_with(|| (artist, Vec::new()));
        if !entry.1.contains(&album_id) {
            entry.1.push(album_id);
        }
    }
    for album in albums.values_mut() {
        album.songs.sort_by_key(|at| {
            let fields = &songs[*at].1;
            (
                track_number(&fields.track).unwrap_or(u32::MAX),
                fields.title.to_lowercase(),
            )
        });
    }
    let starred = library.favourites(person)?.into_iter().collect();
    Ok(Catalogue {
        songs,
        artists,
        albums,
        starred,
    })
}

fn non_empty(text: &str, otherwise: &str) -> String {
    let text = text.trim();
    if text.is_empty() {
        otherwise.to_string()
    } else {
        text.to_string()
    }
}

/// "3/12" or "3" as 3.
fn track_number(text: &str) -> Option<u32> {
    text.split('/').next()?.trim().parse().ok()
}

fn year_of(text: &str) -> Option<u32> {
    text.get(..4)?.parse().ok()
}

/// Milliseconds since 1970 as ISO 8601 (UTC).
fn iso(milliseconds: u64) -> String {
    let seconds = milliseconds / 1000;
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    // Days to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

impl Catalogue {
    fn song_json(&self, at: usize) -> Value {
        let (song, fields) = &self.songs[at];
        let artist = non_empty(&fields.artist, UNKNOWN_ARTIST);
        let album = non_empty(&fields.album, UNKNOWN_ALBUM);
        let album_id = id_of("al-", &format!("{artist}\u{0}{album}"));
        let flac = song.format == "flac";
        let mut value = json!({
            "id": song.id.to_string(),
            "parent": album_id,
            "isDir": false,
            "title": non_empty(&fields.title, song.path.rsplit('/').next().unwrap_or(&song.path)),
            "album": album,
            "artist": artist,
            "albumId": album_id,
            "artistId": id_of("ar-", &artist),
            "coverArt": song.id.to_string(),
            "size": song.size,
            "contentType": if flac { "audio/flac" } else { "audio/mpeg" },
            "suffix": song.format,
            "path": song.path,
            "type": "music",
            "mediaType": "song",
            "created": iso(song.added),
        });
        if let Some(track) = track_number(&fields.track) {
            value["track"] = json!(track);
        }
        if let Some(year) = year_of(&fields.year) {
            value["year"] = json!(year);
        }
        if !fields.genre.trim().is_empty() {
            value["genre"] = json!(fields.genre.trim());
        }
        if self.starred.contains(&song.path) {
            value["starred"] = json!(iso(song.changed));
        }
        value
    }

    fn album_json(&self, album: &Album) -> Value {
        let first = album.songs.first().map(|at| &self.songs[*at]);
        let created = album.songs.iter().map(|at| self.songs[*at].0.added).min().unwrap_or(0);
        let mut value = json!({
            "id": album.id,
            "parent": album.artist_id,
            "isDir": true,
            "name": album.name,
            "title": album.name,
            "album": album.name,
            "artist": album.artist,
            "artistId": album.artist_id,
            "coverArt": album.id,
            "songCount": album.songs.len(),
            "duration": 0,
            "created": iso(created),
        });
        if let Some((_, fields)) = first {
            if let Some(year) = year_of(&fields.year) {
                value["year"] = json!(year);
            }
            if !fields.genre.trim().is_empty() {
                value["genre"] = json!(fields.genre.trim());
            }
        }
        value
    }

    fn artist_json(&self, id: &str) -> Value {
        let (name, albums) = &self.artists[id];
        json!({ "id": id, "name": name, "albumCount": albums.len(), "coverArt": id })
    }

    fn song_at(&self, id: &str) -> Option<usize> {
        let id: i64 = id.parse().ok()?;
        self.songs.iter().position(|(song, _)| song.id == id)
    }

    /// The song whose cover stands for an id (a song's, an album's first, an artist's first).
    fn cover_song(&self, id: &str) -> Option<usize> {
        if let Some(album) = self.albums.get(id) {
            return album.songs.first().copied();
        }
        if let Some((_, albums)) = self.artists.get(id) {
            return albums
                .first()
                .and_then(|album| self.albums[album].songs.first().copied());
        }
        self.song_at(id)
    }

    /// The artists by their initial, as getArtists and getIndexes give them.
    fn index(&self) -> Value {
        let mut index: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
        for (id, (name, _)) in &self.artists {
            let initial = name
                .chars()
                .next()
                .filter(|letter| letter.is_alphabetic())
                .map_or("#".to_string(), |letter| letter.to_uppercase().to_string());
            index
                .entry(initial)
                .or_default()
                .push((name.to_lowercase(), id.clone()));
        }
        Value::Array(
            index
                .into_iter()
                .map(|(initial, mut artists)| {
                    artists.sort();
                    json!({
                        "name": initial,
                        "artist": artists.iter().map(|(_, id)| self.artist_json(id)).collect::<Vec<_>>(),
                    })
                })
                .collect(),
        )
    }
}

// ---------------------------------------------------------------------------------------------
// The methods.

async fn rest(
    State(service): State<Arc<Service>>,
    Path(method): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut pairs: Vec<(String, String)> =
        serde_urlencoded::from_str(query.as_deref().unwrap_or("")).unwrap_or_default();
    let form = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|kind| kind.starts_with("application/x-www-form-urlencoded"));
    if form {
        pairs.extend(serde_urlencoded::from_bytes::<Vec<(String, String)>>(&body).unwrap_or_default());
    }
    let params = Params(pairs);
    let method = method.trim_end_matches(".view").to_string();
    let person = match person(&service, &params) {
        Ok(person) => person,
        Err((code, message)) => return failed(&params, code, message),
    };
    match method.as_str() {
        "ping" => return ok(&params, json!({})),
        "getLicense" => return ok(&params, json!({ "license": { "valid": true } })),
        "getOpenSubsonicExtensions" => {
            return ok(
                &params,
                json!({ "openSubsonicExtensions": [
                    { "name": "apiKeyAuthentication", "versions": [1] },
                    { "name": "formPost", "versions": [1] }
                ] }),
            );
        }
        "getMusicFolders" => {
            return ok(
                &params,
                json!({ "musicFolders": { "musicFolder": [{ "id": 1, "name": "Library" }] } }),
            );
        }
        "getUser" => {
            return ok(
                &params,
                json!({ "user": {
                    "username": person.name,
                    "email": person.email,
                    "scrobblingEnabled": true,
                    "adminRole": person.role >= Role::Admin,
                    "settingsRole": false,
                    "downloadRole": true,
                    "uploadRole": false,
                    "playlistRole": false,
                    "coverArtRole": person.role >= Role::Editor,
                    "commentRole": false,
                    "podcastRole": false,
                    "streamRole": true,
                    "jukeboxRole": false,
                    "shareRole": false,
                    "videoConversionRole": false,
                    "folder": [1]
                } }),
            );
        }
        "getPlaylists" => return ok(&params, json!({ "playlists": { "playlist": [] } })),
        _ => {}
    }
    let Some(library) = service.library.clone() else {
        return failed(&params, 0, "this service has no library");
    };
    match method.as_str() {
        "stream" | "download" => {
            let at = {
                let library = Arc::clone(&library);
                let person = person.id;
                blocking(move || catalogue(&library, person)).await
            };
            let path = match (at, params.get("id")) {
                (Ok(catalogue), Some(id)) => catalogue.song_at(id).map(|at| catalogue.songs[at].0.path.clone()),
                _ => None,
            };
            let Some(path) = path else {
                return failed(&params, 70, "Song not found");
            };
            let viewer = jackbird_store::Viewer::of(person.id, person.settings.mine);
            let out = match blocking(move || library.outgoing_as(&path, viewer)).await {
                Ok(out) => out,
                Err(_) => return failed(&params, 70, "Song not found"),
            };
            return library_api::send(out, &headers, method == "download")
                .await
                .unwrap_or_else(IntoResponse::into_response);
        }
        "getCoverArt" => return cover(&library, &person, &params).await,
        "scrobble" => {
            if params.get("submission") == Some("false") {
                return ok(&params, json!({}));
            }
            let ids: Vec<String> = params.all("id").into_iter().map(str::to_string).collect();
            let who = person.id;
            let _ = blocking(move || {
                let catalogue = catalogue(&library, who)?;
                for id in ids {
                    if let Some(at) = catalogue.song_at(&id) {
                        library.played(who, &catalogue.songs[at].0.path)?;
                    }
                }
                Ok(())
            })
            .await;
            return ok(&params, json!({}));
        }
        "star" | "unstar" => {
            let on = method == "star";
            let ids: Vec<String> = params.all("id").into_iter().map(str::to_string).collect();
            let albums: Vec<String> = params.all("albumId").into_iter().map(str::to_string).collect();
            let who = person.id;
            let _ = blocking(move || {
                let catalogue = catalogue(&library, who)?;
                let mut songs: Vec<usize> = ids.iter().filter_map(|id| catalogue.song_at(id)).collect();
                // An album starred is its songs starred: the library keeps favourite songs only.
                for album in albums.iter().filter_map(|id| catalogue.albums.get(id)) {
                    songs.extend(&album.songs);
                }
                for at in songs {
                    library.set_favourite(who, &catalogue.songs[at].0.path, on)?;
                }
                Ok(())
            })
            .await;
            return ok(&params, json!({}));
        }
        _ => {}
    }
    let who = person.id;
    let catalogue = match blocking(move || catalogue(&library, who)).await {
        Ok(catalogue) => catalogue,
        Err(error) => return failed(&params, 0, &error.1.message),
    };
    browse(&catalogue, &method, &params)
}

/// The methods that only read the catalogue.
fn browse(catalogue: &Catalogue, method: &str, params: &Params) -> Response {
    let id = params.get("id").unwrap_or_default();
    match method {
        "getArtists" => ok(
            params,
            json!({ "artists": { "ignoredArticles": "", "index": catalogue.index() } }),
        ),
        "getIndexes" => ok(
            params,
            json!({ "indexes": { "ignoredArticles": "", "lastModified": 0, "index": catalogue.index() } }),
        ),
        "getArtist" => match catalogue.artists.get(id) {
            Some((_, albums)) => {
                let mut artist = catalogue.artist_json(id);
                artist["album"] = Value::Array(
                    albums
                        .iter()
                        .map(|album| catalogue.album_json(&catalogue.albums[album]))
                        .collect(),
                );
                ok(params, json!({ "artist": artist }))
            }
            None => failed(params, 70, "Artist not found"),
        },
        "getAlbum" => match catalogue.albums.get(id) {
            Some(album) => {
                let mut value = catalogue.album_json(album);
                value["song"] = Value::Array(album.songs.iter().map(|at| catalogue.song_json(*at)).collect());
                ok(params, json!({ "album": value }))
            }
            None => failed(params, 70, "Album not found"),
        },
        "getSong" => match catalogue.song_at(id) {
            Some(at) => ok(params, json!({ "song": catalogue.song_json(at) })),
            None => failed(params, 70, "Song not found"),
        },
        "getAlbumList2" | "getAlbumList" => {
            let size = params.number("size", 10).min(500);
            let offset = params.number("offset", 0);
            let mut albums: Vec<&Album> = catalogue.albums.values().collect();
            match params.get("type").unwrap_or("alphabeticalByName") {
                "newest" | "recent" => albums.sort_by_key(|album| {
                    std::cmp::Reverse(album.songs.iter().map(|at| catalogue.songs[*at].0.added).max())
                }),
                "alphabeticalByArtist" => {
                    albums.sort_by_key(|album| (album.artist.to_lowercase(), album.name.to_lowercase()));
                }
                "starred" => albums.retain(|album| {
                    album
                        .songs
                        .iter()
                        .any(|at| catalogue.starred.contains(&catalogue.songs[*at].0.path))
                }),
                _ => albums.sort_by_key(|album| album.name.to_lowercase()),
            }
            let list: Vec<Value> = albums
                .into_iter()
                .skip(offset)
                .take(size)
                .map(|album| catalogue.album_json(album))
                .collect();
            let key = if method == "getAlbumList" {
                "albumList"
            } else {
                "albumList2"
            };
            ok(params, json!({ key: { "album": list } }))
        }
        "getRandomSongs" => {
            // Not random: spread over the library by a step, which is enough for a shuffle to start.
            let size = params.number("size", 10).min(500);
            let count = catalogue.songs.len();
            let step = (count / size.max(1)).max(1);
            let songs: Vec<Value> = (0..count)
                .step_by(step)
                .take(size)
                .map(|at| catalogue.song_json(at))
                .collect();
            ok(params, json!({ "randomSongs": { "song": songs } }))
        }
        "getStarred2" | "getStarred" => {
            let songs: Vec<Value> = (0..catalogue.songs.len())
                .filter(|at| catalogue.starred.contains(&catalogue.songs[*at].0.path))
                .map(|at| catalogue.song_json(at))
                .collect();
            let key = if method == "getStarred" { "starred" } else { "starred2" };
            ok(params, json!({ key: { "artist": [], "album": [], "song": songs } }))
        }
        "getGenres" => {
            let mut genres: BTreeMap<String, usize> = BTreeMap::new();
            for (_, fields) in &catalogue.songs {
                if !fields.genre.trim().is_empty() {
                    *genres.entry(fields.genre.trim().to_string()).or_default() += 1;
                }
            }
            let list: Vec<Value> = genres
                .into_iter()
                .map(|(name, count)| json!({ "value": name, "songCount": count, "albumCount": 0 }))
                .collect();
            ok(params, json!({ "genres": { "genre": list } }))
        }
        "search3" | "search2" => search(catalogue, method, params),
        _ => failed(params, 0, "This method is not part of jackbird's OpenSubsonic"),
    }
}

/// search3: every word in the name; an empty query (`""`) lists everything, as apps that copy the
/// library ask it.
fn search(catalogue: &Catalogue, method: &str, params: &Params) -> Response {
    let query = params
        .get("query")
        .unwrap_or_default()
        .trim()
        .trim_matches('"')
        .to_lowercase();
    let words: Vec<&str> = query.split_whitespace().collect();
    let matches = |text: &str| {
        let text = text.to_lowercase();
        words.iter().all(|word| text.contains(word))
    };
    let page = |kind: &str, default: usize| {
        (
            params.number(&format!("{kind}Offset"), 0),
            params.number(&format!("{kind}Count"), default),
        )
    };
    let (artist_offset, artist_count) = page("artist", 20);
    let (album_offset, album_count) = page("album", 20);
    let (song_offset, song_count) = page("song", 20);
    let artists: Vec<Value> = catalogue
        .artists
        .iter()
        .filter(|(_, (name, _))| matches(name))
        .skip(artist_offset)
        .take(artist_count)
        .map(|(id, _)| catalogue.artist_json(id))
        .collect();
    let albums: Vec<Value> = catalogue
        .albums
        .values()
        .filter(|album| matches(&format!("{} {}", album.name, album.artist)))
        .skip(album_offset)
        .take(album_count)
        .map(|album| catalogue.album_json(album))
        .collect();
    let songs: Vec<Value> = (0..catalogue.songs.len())
        .filter(|at| {
            let fields = &catalogue.songs[*at].1;
            matches(&format!("{} {} {}", fields.title, fields.artist, fields.album))
        })
        .skip(song_offset)
        .take(song_count)
        .map(|at| catalogue.song_json(at))
        .collect();
    let key = if method == "search2" {
        "searchResult2"
    } else {
        "searchResult3"
    };
    ok(
        params,
        json!({ key: { "artist": artists, "album": albums, "song": songs } }),
    )
}

async fn cover(library: &Arc<Library>, person: &Person, params: &Params) -> Response {
    let id = params.get("id").unwrap_or_default().to_string();
    let library = Arc::clone(library);
    let viewer = jackbird_store::Viewer::of(person.id, person.settings.mine);
    let who = person.id;
    let found = blocking(move || {
        let catalogue = catalogue(&library, who)?;
        let Some(at) = catalogue.cover_song(&id) else {
            return Ok(None);
        };
        let path = catalogue.songs[at].0.path.clone();
        let inspection = library.inspect_as(&path, None, viewer)?;
        Ok(inspection.tags.and_then(|(_, cover)| cover))
    })
    .await;
    match found {
        Ok(Some(cover)) => ([(header::CONTENT_TYPE, cover.mime)], cover.data).into_response(),
        _ => (StatusCode::NOT_FOUND, "no cover").into_response(),
    }
}

/// The routes, outside `/api`: OpenSubsonic's own path.
pub fn routes() -> axum::Router<Arc<Service>> {
    axum::Router::new().route("/rest/{method}", axum::routing::get(rest).post(rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_iso_8601() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_762_700_000_000), "2025-11-09T14:53:20Z");
        assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn xml_follows_subsonic() {
        let mut xml = String::new();
        element(
            &mut xml,
            "subsonic-response",
            &json!({ "status": "ok", "album": { "id": "al-1", "name": "A & B", "song": [{ "id": "1" }, { "id": "2" }] } }),
            true,
        );
        assert_eq!(
            xml,
            "<subsonic-response xmlns=\"http://subsonic.org/restapi\" status=\"ok\"><album id=\"al-1\" name=\"A &amp; B\"><song id=\"1\"/><song id=\"2\"/></album></subsonic-response>"
        );
    }

    #[test]
    fn passwords_may_come_hex_encoded() {
        assert_eq!(from_hex("6162"), Some("ab".to_string()));
        assert_eq!(from_hex("6"), None);
    }
}
