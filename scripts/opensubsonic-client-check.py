#!/usr/bin/env python3
"""An outside OpenSubsonic client against jackbird's service (E6-D4, E6's spike).

py-opensonic (https://github.com/khers/py-opensonic) is a client written by others: its calls
read our answers into its own types, so an answer it cannot read fails here. The check:

1. imports a folder of songs into the library of a running service (an open instance, on this
   machine, so its owner is the person asking) and makes the owner a key;
2. signs in with the key twice, as the apps do: `apiKey` (apiKeyAuthentication), and as the
   password of a "legacy" sign-in (`p=enc:…`) under the owner's name; and checks that a salted
   token (`t`, `s`) is refused with error 41;
3. browses (artists, an artist, an album, a song, album lists, random songs, genres, search),
   streams a song with a range and gets its cover, stars and unstars it, and scrobbles it.

    pip install py-opensonic==10.4.1
    python3 scripts/opensubsonic-client-check.py http://localhost:4646 path/to/folder

Exits non-zero on the first thing missing. See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md
(E6-D4).
"""

import json
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

import libopensonic
from libopensonic.errors import SonicError

base, folder = sys.argv[1].rstrip("/"), sys.argv[2]
address = urlsplit(base)


def api(path, body=None):
    """jackbird's own API, as its page asks it (changes carry the page's origin)."""
    request = urllib.request.Request(f"{base}/api/{path}")
    if body is not None:
        request.data = json.dumps(body).encode()
        request.add_header("content-type", "application/json")
        request.add_header("origin", base)
    with urllib.request.urlopen(request, timeout=30) as answer:
        text = answer.read()
        return json.loads(text) if text else None


def check(what, ok, detail=""):
    print(f"opensubsonic-client-check: {'ok' if ok else 'FAILED'}: {what}{f' ({detail})' if detail else ''}")
    if not ok:
        sys.exit(1)


# 1. The library and the key.
api("library/import", {"path": folder})
for _ in range(300):
    state = api("library/import")
    if not state["running"]:
        break
    time.sleep(0.1)
check("the folder imported", state["error"] is None and state["done"] > 0, json.dumps(state["report"]))
owner = api("me")["me"]["name"]
key = api("me/keys", {"name": "py-opensonic"})["secret"]


def connect(**how):
    return libopensonic.Connection(
        f"{address.scheme}://{address.hostname}", port=address.port, app_name="jackbird-check", **how
    )


# 2. The ways in.
by_key = connect(api_key=key)
check("ping with apiKey", by_key.ping())
extensions = {extension.name for extension in by_key.get_open_subsonic_extensions()}
check("apiKeyAuthentication announced", "apiKeyAuthentication" in extensions, ", ".join(sorted(extensions)))
legacy = connect(username=owner, password=key, legacy_auth=True)
check("ping with the key as a legacy password", legacy.ping())
salted = connect(username=owner, password=key)
try:
    salted.ping()
    check("a salted token refused", False, "it was accepted")
except SonicError as error:
    # The library keeps the message, not the code: jackbird's error 41 names token authentication.
    check("a salted token refused", "Token authentication is not supported" in str(error), str(error))

# 3. What an app does.
check("getLicense", bool(by_key.get_license()))
# py-opensonic 10.4.1 reads `musicFolders` as the list itself, where the specification (and
# jackbird) nest it as `musicFolders.musicFolder`: the answer's shape is checked here instead.
with urllib.request.urlopen(f"{base}/rest/getMusicFolders?apiKey={key}&f=json&c=jackbird-check&v=1.16.1") as answer:
    folders = json.loads(answer.read())["subsonic-response"]["musicFolders"]["musicFolder"]
check("getMusicFolders, as the specification nests it", len(folders) == 1, ", ".join(folder["name"] for folder in folders))
artists = [artist for index in by_key.get_artists().index for artist in index.artist]
check("getArtists", len(artists) > 0, ", ".join(artist.name for artist in artists))
artist = by_key.get_artist(artists[0].id)
check("getArtist", len(artist.album) > 0, f"{artist.name}: {len(artist.album)} albums")
album = by_key.get_album(artist.album[0].id)
check("getAlbum", len(album.song) > 0, f"{album.name}: {len(album.song)} songs")
song = by_key.get_song(album.song[0].id)
check("getSong", song.id == album.song[0].id, f"{song.title} ({song.suffix}, {song.size} bytes)")
for kind in ["newest", "alphabeticalByName", "alphabeticalByArtist"]:
    check(f"getAlbumList2 {kind}", len(by_key.get_album_list2(kind, size=50)) > 0)
check("getRandomSongs", len(by_key.get_random_songs(size=5)) > 0)
check("getGenres", isinstance(by_key.get_genres(), list))
found = by_key.search3("")
check("search3 with an empty query lists everything", len(found.song or []) > 0, f"{len(found.song or [])} songs")
check("getIndexes", by_key.get_indexes() is not None)
check("getPlaylists", isinstance(by_key.get_playlists(), list))

# The binary calls by plain HTTP: py-opensonic's synchronous wrapper hands back aiohttp's response,
# which only its event loop can read.
def rest(method, params="", headers=None):
    request = urllib.request.Request(f"{base}/rest/{method}?apiKey={key}&c=jackbird-check&v=1.16.1{params}", headers=headers or {})
    try:
        answer = urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    with answer:
        return answer.status, answer.read()


status, body = rest("stream", f"&id={song.id}")
check("stream", status == 200 and len(body) == song.size, f"HTTP {status}, {len(body)} of {song.size} bytes")
status, body = rest("stream", f"&id={song.id}", {"range": "bytes=0-99"})
check("stream with a range", status == 206 and len(body) == 100, f"HTTP {status}, {len(body)} bytes")
status, body = rest("getCoverArt", f"&id={song.cover_art or song.id}")
check("getCoverArt answers", status in (200, 404), f"HTTP {status}, {len(body)} bytes")

check("star", by_key.star(sids=[song.id]))
starred = by_key.get_starred2()
check("getStarred2 has it", any(entry.id == song.id for entry in starred.song or []))
check("unstar", by_key.unstar(sids=[song.id]))
check("getStarred2 no longer has it", not any(entry.id == song.id for entry in by_key.get_starred2().song or []))
check("scrobble", by_key.scrobble(song.id))
check("the same through the legacy sign-in", len(legacy.get_album(album.id).song) == len(album.song))
for connection in (by_key, legacy, salted):
    connection.cleanup()

print("opensubsonic-client-check: ok")
