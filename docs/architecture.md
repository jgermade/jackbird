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

1. **Pick.** `openFolder()` (`src/lib/roots.ts`) asks for a folder with `FSAAdapter.pick()`.
2. **Render what is known.** `hydrateRoot()` reads `.meta/mp3-manager.json` (`src/lib/meta.ts`)
   and shows its tracks at once.
3. **Walk.** In the background, `walk()` lists the folder's `.mp3` and `.flac` files (`src/helpers/formats.ts`), and its `.m3u8` and
   `.m3u` playlists, which `src/lib/playlists.ts` reads beside the tracks (see below).
4. **Read.** New and changed files are read as bytes; `readTags()` (`src/lib/tags/`) parses their
   tags and `checksums()` hashes the whole file and its audio alone (without the tags). The
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

- **`jackbird-id3`** reads an ID3v2 tag (v2.2 to v2.4) into its frames as they are stored, and
  writes frames back; only the frames jackbird edits are decoded (text, pictures). A frame nobody
  edits goes back byte for byte, in its place.
- **`jackbird-flac`** does the same for FLAC's metadata blocks, and keeps Vorbis comments entry by
  entry, whatever bytes each holds.
- **`jackbird-tags`** is jackbird's layer: the six fields and the cover over both formats, the
  audio region the checksums hash (for MP3 exactly `getAudioFrameSlice`'s, so existing `.meta/`
  checksums stay valid), and writes that keep the audio where it was when the tag fits. Every
  write is checked before its bytes are given back: the result must read back as asked, its audio
  must be byte-identical, and every frame, block and comment it did not touch must be there, byte
  for byte and in order; otherwise it is refused, with a code for the interface. A cover can be
  set, or removed (the picture shown goes, the others stay).
- **`jackbird-tags-wasm`** is the WebAssembly module: no bindings crate, only a few exports over
  an input and an output buffer it owns (`tags_input`, `tags_read`, `tags_write`, `tags_region`,
  `tags_output_ptr`, `tags_output_len`, `tags_release`) and a small wire format
  (`crates/tags-wasm/src/wire.rs`, mirrored by `src/helpers/tagwire.ts`). The glue on the web
  side is `src/lib/tags/wasm.ts`. A trap leaves the module unused and the next call loads it again.

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
