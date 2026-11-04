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
- **A metadata engine over bytes.** `src/lib/id3.ts` reads and writes ID3 tags on `Uint8Array`
  buffers, not on files, so it does not depend on where the bytes come from.
- **Several roots at once.** Each open folder keeps its own tracks, selection, expanded folders
  and grouping.

## From a folder to a saved tag

1. **Pick.** `openFolder()` (`src/lib/roots.ts`) asks for a folder with `FSAAdapter.pick()`.
2. **Render what is known.** `hydrateRoot()` reads `.meta/mp3-manager.json` (`src/lib/meta.ts`)
   and shows its tracks at once.
3. **Walk.** In the background, `walk()` lists the folder's `.mp3` files.
4. **Read.** New and changed files are read as bytes; `readTrackMetadataFromBytes()` parses their
   tags (with `jsmediatags`) and `calculateDualChecksums()` hashes the whole file and its audio
   alone (without the ID3 tag). The snapshot in `.meta/` is written again.
5. **Edit.** The edit dialog fills the `editor` store (`src/lib/editor.ts`) with the values the
   selected tracks share.
6. **Serialize.** `saveEdits()` merges the form into each track's tags, and
   `writeTrackMetadataToBytes()` writes them into the file's bytes (with `browser-id3-writer`).
7. **Write.** The bytes go back through the root's VFS, and the library and `.meta/` record the
   new tags and checksums.

Beside that flow, `src/main.ts` starts three things:

- **The session** (`src/lib/session.ts`): the open roots and the active one are kept in IndexedDB
  and reopened on load, when the browser still grants permission.
- **The verifier** (`src/lib/verifier.ts`): re-reads, one at a time, the tracks whose checksums are
  missing or more than a day old.
- **The root view** (`src/views/app.html`).

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
