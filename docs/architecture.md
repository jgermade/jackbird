# Architecture

jackbird runs entirely in the browser: there is no backend. This page gives the overall shape;
[`STACK.md`](../STACK.md) has the detail, and [`THESAURUS.md`](../THESAURUS.md) defines the terms.

## Principles

- **Client-only.** Folders are opened with the File System Access API, and files are read and
  written in place. Nothing is uploaded.
- **File access behind a VFS.** Every read and write goes through a `VFSAdapter` from
  [`@cloudauthn/vfs-sync`](https://www.npmjs.com/package/@cloudauthn/vfs-sync): `FSAAdapter` over
  a directory handle, and `walk` to list a folder. Each open root keeps its adapter
  (`RootWorkspace.vfs`), so the rest of the app never touches a file handle, and another backend
  (a remote, synced store, for instance) can be plugged in later without touching the views. The
  one exception is playback: `src/lib/media.ts` gives the player the file itself, from the root's
  directory handle, so a track is not read into memory to be played.
- **A metadata engine over bytes.** `src/lib/tags/` reads and writes tags on `Uint8Array`
  buffers, not on files, so it does not depend on where the bytes come from.
- **Several roots at once.** Each open folder keeps its own tracks, selection, expanded folders
  and grouping.

## From a folder to a saved tag

1. **Pick.** `openFolder()` (`src/lib/roots.ts`) asks for a folder (`src/lib/sources/`): the
   browser's picker, or the desktop app's dialog. The root keeps its `RootSource`.
2. **Render what is known.** `hydrateRoot()` reads `.meta/mp3-manager.json` (`src/lib/meta.ts`)
   and shows its tracks at once.
3. **Walk.** In the background, `walk()` lists the folder's `.mp3` and `.flac` files (`src/helpers/formats.ts`), and its `.m3u8` and
   `.m3u` playlists, which `src/lib/playlists.ts` reads beside the tracks (see below).
4. **Read.** New and changed files go to the source's `inspect()`: in the browser they are read as
   bytes, `readTags()` (`src/lib/tags/`) parses their tags and `checksums()` hashes the whole file
   and its audio alone (without the tags); in the desktop app one command does it by path. The
   snapshot in `.meta/` is written again.
5. **Edit.** The edit dialog fills the `editor` store (`src/lib/editor.ts`) with the values the
   selected tracks share.
6. **Serialize.** `saveEdits()` merges the form into each track's tags, and `writeTags()` writes
   them into the file's bytes, or says why the engine refused (a save of several tracks stops
   there, and the ones before it are recorded).
7. **Write.** The bytes go back through the root's VFS, and the library and `.meta/` record the
   new tags and checksums.

## Playlists

`src/lib/playlists.ts` is what the library does with a root's playlists (make one, add to it, move
and take out its entries, delete it, save the queue as one), over one interface, `PlaylistStore`
(list, exists, save, delete), so the views do not know where a playlist lives. In a folder, local
or in the cloud, it is an M3U file over the root's `VFSAdapter` (`m3uPlaylists`): read and written
by `src/helpers/m3u.ts`, its entries' paths relative to its own folder. On the family instance it
will be rows of its database, behind the same interface. A playlist's change shows at once and its
file is written after the writes before it, so the last one written is what the library shows.

Beside that flow, `src/main.ts` starts three things:

- **The session** (`src/lib/session.ts`): the open roots and the active one are kept in IndexedDB
  and reopened on load, when the browser still grants permission.
- **The verifier** (`src/lib/verifier.ts`): re-reads, one at a time, the tracks whose checksums are
  missing or more than a day old.
- **The root view** (`src/views/app.html`).

## The tag engine

jackbird's tags are read and written by its own Rust crates in `crates/`: in the web app as
WebAssembly (since E2), in the desktop app natively (E4). The web app reaches them through
`src/lib/tags/` (`readTags`, `writeTags`, `checksums`), which loads the module the first time a
file has to be read, written or hashed, so a library that reopens from `.meta/` never fetches it.
The walk takes `.mp3` and `.flac` files (since E3); `src/helpers/formats.ts` is the one list of
formats, with the MIME type the player gives each file.

The engine never sees a file's audio (since E2b). `layout(head, tail, length)` says where the tags
end and where the audio region is, from the file's first bytes and its last 160 (for ID3v1 and
APEv2); when the head is too short for the tags, it says how many first bytes it needs, and the
caller asks again. `read_head` reads the tags alone, and `write_head` gives a splice: the file's
first `tags_end` bytes replaced with the new tags, the rest left as it is. The web app
(`src/lib/tags/engine.ts`) hands the module only those parts, so the module's memory follows the
size of the tags, not of the file; before it gives a saved file back, it checks that its audio
region hashes as the source's did. The desktop app (E4) will read those ranges from disk and write
the splice in place.

- **`jackbird-id3`** reads an ID3v2 tag (v2.2 to v2.4) into its frames as they are stored, and
  writes frames back; only the frames jackbird edits are decoded (text, pictures). A frame nobody
  edits goes back byte for byte, in its place.
- **`jackbird-flac`** does the same for FLAC's metadata blocks, and keeps Vorbis comments entry by
  entry, whatever bytes each holds.
- **`jackbird-tags`** is jackbird's layer: the six fields and the cover over both formats, the
  audio region the checksums hash (for MP3 exactly `getAudioFrameSlice`'s, so existing `.meta/`
  checksums stay valid), and writes that keep the audio where it was when the tag fits. Every
  write is checked before its bytes are given back: the new tags must read back as asked, end
  exactly where their own header or last block says the audio starts, and keep every frame, block
  and comment the edit did not touch, byte for byte and in order; otherwise the write is refused,
  with a code for the interface. Whole-file `read` and `write` are built on the same functions,
  and `write` also checks the whole result's audio region byte for byte. A cover can be
  set, or removed (the picture shown goes, the others stay).
- **`jackbird-tags-wasm`** is the WebAssembly module: no bindings crate, only a few exports over
  an input and an output buffer it owns (`tags_input`, `tags_layout`, `tags_read`, `tags_write`,
  `tags_output_ptr`, `tags_output_len`, `tags_release`) and a small wire format
  (`crates/tags-wasm/src/wire.rs`, mirrored by `src/helpers/tagwire.ts`). The glue on the web
  side is `src/lib/tags/wasm.ts`. A trap leaves the module unused and the next call loads it again.

## The desktop app

The desktop app (`src-tauri/`, Tauri v2, since E4) shows the same web build in the system's
webview. Where a root lives is the one difference, behind `RootSource` (`src/types.ts`,
`src/lib/sources/`): `browser.ts` is a folder chosen through the File System Access API, its tags
worked out by the engine as wasm; `desktop.ts` is a path, and every file operation is a command
of the app (`src-tauri/src/lib.rs`) over `crates/core`:

- **Only open folders**: a root is registered when the person picks it in the system's dialog, or
  when the app's own session reopens it; every path is relative to a root and refused if it
  leaves it (`..`, an absolute path, a link that leads out).
- **No file bytes over the IPC to read or hash**: `inspect` reads a file's head and tail for its
  tags and hashes it in 1 MiB chunks; `save` writes the engine's splice in place when the new tags
  are as long as the old ones, and otherwise a new file beside the old one, checked and renamed
  over it; either way the audio region is hashed again and must be the source's. Only small files
  (`.meta/`, playlists) cross whole.
- **Playback**: macOS and Windows play from Tauri's asset protocol, whose scope holds only the open
  roots; Linux's webview cannot, so a server on 127.0.0.1 (a random port, a token per run, only
  files the app handed out a URL for, byte ranges) gives them (`src-tauri/src/media.rs`).
- **The session keeps paths**, in the same IndexedDB store, and reopens them at start.
- `src/lib/sources/check.ts` is the unattended check `desktop.yml` runs; it does nothing unless
  the app is started for it.

`crates/core` has no Tauri in it: the service (S1, planned) will put it behind HTTP.

## The service

`jackbird-service` (`crates/service`, since S1) puts `crates/core` behind HTTP and serves the web
build from the same origin, so a browser on the machine uses folders of it with no File System
Access API. The page finds it by asking `/api/info` (`src/lib/platform.ts`); its roots are then
`src/lib/sources/service.ts`, and a folder is chosen in a dialog of the machine's folders
(`src/views/folder-dialog.html`). The JSON is `crates/api`'s, the same the desktop app speaks.

Open (sign-in off, as every installation starts), it keeps to the machine: it listens on the
loopback address only and refuses any other peer and any request a proxy forwarded; every request
must name it by its own address and port (`Host`), which keeps out a page that points its own name
at 127.0.0.1; a request from another site is refused (`Sec-Fetch-Site`, `Origin`), and one that
changes anything must come from its own page. Its configuration keeps its port (4646), its open
folders (reopened when it starts) and, since S3, how people reach it.

### People and sign-in (S3)

The service keeps its people in `jackbird.db` (SQLite, beside its configuration, readable by its
person alone): people (a name, an email, a role), sessions (kept as hashes), passkeys, and the log
of changes to the folders (`crates/service/src/people.rs`). Every installation starts with one
person, its owner, and two independent switches:

- **Several people**: with sign-in off they are profiles, picked in the browser ("Who's
  listening?"); roles decide what the interface offers and what the service accepts, but anyone
  at the machine can pick any profile.
- **Sign-in**: only an owner turns it on, by confirming their own address with a code sent there
  (from Preferences, or `jackbird-service setup` on the console). No role changes; everyone else is
  disabled until an owner or admin gives them an address and they sign in with the code sent
  there (sign-up is by invitation only). Turning it off again (an owner's) makes them profiles
  again and ends every session.

Roles (`access.rs`, checked on every route): **listeners** read and play; **editors** also change
the folders (tags, covers, renames, playlists); **admins** also add people up to editor, read the
log and set up email; **owners** also open and close folders, browse the machine's folders, set
the address and the network, turn sign-in on and off, and make other owners and admins (one owner
always remains). Codes (`auth.rs`) follow intergate's rules: six digits, ten minutes, bound to the
attempt that asked, five tries, five per address in 15 minutes and 20 per IP address in an hour,
and the same answer for an unknown address. Passkeys (`passkeys.rs`) are `webauthn-rs`'s:
discoverable, with user verification, on the instance's address (its host is the RP ID), a signed
ceremony answered once, a sign count going back refused. Email goes out by SMTP (`mail.rs`,
`lettre`).

With sign-in on, any `Host` is answered (behind a proxy, on the home network), since without a
session nothing but signing in is; the home network is an owner's switch, which listens on each
of the machine's addresses; `X-Forwarded-For` and `X-Forwarded-Proto` are believed only from the
listed proxies (loopback by default), and over HTTPS the session cookie is `__Host-`, `Secure`,
`HttpOnly`, `SameSite=Strict`. The desktop app, whose page is another origin, keeps a session token
and sends it as a bearer; its media URLs carry a short-lived media token. The interface's side is
`src/lib/account.ts` (who is in, the sign-in dialog, Account) and `src/lib/people.ts` (People and
sign-in); `can(role)` hides what a role may not do.

### The family library (F1)

`crates/store` keeps the service's own library in a folder (the person's data folder by
default): `blobs/ab/cd/<sha256>.<mp3|flac>`, each song the file as it was imported, whole and never
changed, named by the SHA-256 of its audio region (`jackbird_core::examine`, one pass); `covers/`,
the family's covers by their SHA-256; `files/`, the interface's small files; `catalogue.db`
(SQLite): the songs (their place in the library, their file's own tags, the family's layer and its
version) and the suggestions (other tags brought with the same audio). A save writes the family's
layer field by field (a value equal to the file's leaves the file's), tried first on the song's
head so the engine refuses what it would refuse for a file. A song leaves as
`jackbird_tags::write_head` of its head with the family's layer, then its blob from the end of its
own tags (`Outgoing`), streamed with byte ranges (`crates/service/src/library_api.rs`). To the
interface it is a root (`library` in `src/lib/sources/service.ts`, kept as `@library`): walk,
list, stat, inspect, save; renames and removals change the catalogue, not the blobs. Imports from a
folder of the machine run in the background (owners); uploads (editors) are streamed to `tmp/`
and moved in.

The desktop app carries the service's binary beside its own and installs it from its
Preferences (S2, `src-tauri/src/service.rs` running `jackbird-service install` and its kin;
`crates/service/src/install.rs` knows each system): at logon, or with the system through the
system's own prompt, always running as the person. While it is installed the app is only its
interface (`src/lib/desktop-service.ts`): its roots are the service's, reached over HTTP from the
app's page, which the service answers with CORS for that page alone; a stopped service is started,
never replaced by the app's own backend behind the person's back. When the app's copy is newer than
the installed one, it says so and offers Update.

## Layers

The UI is made of [jq79](https://github.com/jgermade/jq79) components, and the code lives in four
layers that may only import downwards:

| Folder | What |
| --- | --- |
| `src/helpers/` | Pure functions, each with its tests. |
| `src/lib/` | Stores (`$reactive`), services and the actions on them. |
| `src/components/`, `theme/default/components/` | Components that depend on no store. |
| `src/views/` | Components that bring the stores and the components together. |

`npm test` enforces the rule; [`AGENTS.md`](../AGENTS.md) has it in full, with the jq79 pitfalls
found so far.

## The Deck theme

`theme/default/` is the default theme: `tokens.css` (every colour, size and shadow, in a Silver and
a Graphite tone), self-hosted fonts, and the theme's components (keys, display, LEDs, tabs,
modal…), which draw only with the tokens. Every view and component styles itself over those
tokens; there is no app-wide stylesheet. Its demo page is built with the app; see
[Development](development.md#the-deck-theme).
