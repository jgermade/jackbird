# Technology Stack & Architecture

This document describes the technical stack and codebase architecture implemented in the
`mp3-manager` project (shown to users as "jackbird").

---

## 1. Core Architecture & Design Principles

- **100% Client-Side / Zero Backend**: Operates strictly inside the user's browser using the
  Chromium **File System Access API** (`showDirectoryPicker`, `FileSystemDirectoryHandle`).
  Files are never uploaded to any remote server.
- **VFS Abstraction**: All file access goes through a `VFSAdapter` from
  [`@cloudauthn/vfs-sync`](https://www.npmjs.com/package/@cloudauthn/vfs-sync) (`FSAAdapter`
  over a directory handle, `walk` to list a folder). Each open root keeps its adapter
  (`RootWorkspace.vfs`), so the rest of the app never touches file handles directly and a
  different backend can be plugged in later.
- **Metadata engine over bytes**: `src/lib/tags/` reads and writes tags on `Uint8Array`
  buffers, not on file handles, so it stays decoupled from the storage backend.
- **Multi-root workspaces**: Several folders ("roots") can be open at once as tabs; each root
  keeps its own track list, selection, expanded folders and grouping mode.
- **Layers**: pure functions in `src/helpers/`, stores and services in `src/lib/`, store-free
  jq79 components in `src/components/` and `theme/default/components/`, and jq79 views in
  `src/views/` that bring them together. The rules, and the check that enforces them, are in
  `AGENTS.md` ("Layers").

---

## 2. Technology Stack

### Frontend & UI
- **Language**: TypeScript (`^5.6.2`).
- **UI Library**: [jq79](https://github.com/jgermade/jq79) (`^0.7.7`): single-file `.html`
  components with TypeScript setup scripts, imported through its Vite plugin (`jq79/vite`, with
  `safeEval`, so no `'unsafe-eval'` is needed). The root view is `src/views/app.html`, mounted by
  `src/main.ts`. No other UI framework.
- **Design system**: "Deck", the default theme in `theme/default/`: `tokens.css` (every
  `--mm-*` value, Silver light tone and Graphite dark tone), `fonts.css` with self-hosted
  woff2 files (IBM Plex Sans/Mono, Archivo, Doto; SIL OFL), `content.css` (classes for plain
  markup: `.mm-legend`, `.mm-table`, the display's rows), `base.css` (box sizing and the body's
  ground, ink and type), and jq79 components that draw only with the tokens. Every view and
  component styles itself with scoped styles over these tokens; there is no app-wide stylesheet.
  Sizes are in rem; on phones (≤ 480px) the root font size is `4vw`, so the interface scales
  linearly with the screen. Its demo is served at `/theme/default/`.

### Web APIs & Metadata
- **File System Access API**: directory picking, permission checks, file reads and in-place
  writes, through the VFS adapter. The player plays a track from its file's own object URL
  (`src/lib/media.ts`), not from its bytes, and reopens the file when it is rewritten.
- **Web Audio API**: the player's audio element goes through an `AnalyserNode` on its way to the
  speakers, for the display's spectrum analyser (above 640px wide), in an `AudioContext` at the
  device's rate with `latencyHint: "playback"`; the bands span 40 Hz–16 kHz whatever the rate.
- **Tagging**: jackbird's own tag crates in `crates/` (below), with no tag dependency, built
  for the web as WebAssembly (`crates/tags-wasm`, no bindings crate: a few exports over two
  buffers and ~80 lines of hand-written glue in `src/lib/tags/wasm.ts`). The module (~100 KB,
  ~40 KB gzipped) is built by `scripts/build-wasm.mjs` before `dev`, `test` and `build`, is not
  committed, and is loaded only when a file has to be read, written or hashed. Checksums stay
  SHA-1 through WebCrypto, over the engine's audio region.
- **Session persistence**: `src/lib/session.ts` restores the open roots on load and saves them
  whenever they change; `src/lib/rootSessionStore.ts` keeps their handles and grouping mode in
  IndexedDB (`mp3-manager` database).
- **State**: jq79 `$reactive` stores in `src/lib/`: `library` (roots, active root, loading and
  saving flags, messages), `playback` (the queue, of tracks of any open roots, position, playing), `ui` (open dialogs),
  `editor` (the metadata form) and `preferences` (theme and language, saved under the keys in
  `src/lib/storage.ts`). Derived values (`src/lib/workspace.ts`) are `$computed`.
- **Languages**: English (source and fallback) and Spanish. `src/lib/i18n.ts` gives `t` and
  `tn` (plurals via `Intl.PluralRules`) over the catalogues in `src/lib/locales/`. The
  language follows the browser until one is chosen in Preferences, and sets `<html lang>`.

### Build Tools & Tooling
- **Bundler & Dev Server**: Vite (`^5.4.8`), with two entries: the app (`index.html`) and the
  theme demo (`theme/default/index.html`).
- **Type checking**: `tsc --noEmit` (the `build` script runs it before `vite build`; the
  project has `"noEmit": true` in `tsconfig.json`, so `tsc` never writes `.js` files —
  Vite/esbuild handles all transpilation). Templates are not type-checked, so setup scripts stay
  thin and the logic lives in helpers and `lib/`.
- **Scripts Runtime**: Node.js, `"type": "module"`.
- **Makefile**: `make up`, `make test` and `make build` run `npm run dev`, `npm test` and
  `npm run build`, installing the dependencies first (`npm ci`) when they are missing or older
  than `package-lock.json`.
- **Rust** (stable; only to work on `crates/` until E2 builds them into the app): a Cargo
  workspace at the root with jackbird's tag crates, `jackbird-id3` (ID3v2 tags as frames kept byte
  for byte, text and picture codecs), `jackbird-flac` (FLAC metadata blocks, Vorbis comment
  entries, pictures) and `jackbird-tags` (the six fields and the cover over both, the audio region,
  safe writes). No I/O and no dependencies but each other; `cargo test` runs them on the shared
  fixtures in `fixtures/tags/`, and CI (`tags.yml`) adds `rustfmt` and `clippy`. `src-tauri/` is
  its own Cargo project until E4.
- **Tests**: `npm test`, with no test framework: the layer check (`scripts/check-layers.mjs`),
  a type check of the helpers and their tests (`tsconfig.test.json`), Node's own runner on
  `src/helpers/**/*.test.ts` with type stripping, and a per-file coverage floor of 90% of lines,
  branches and functions (`scripts/check-coverage.mjs`, reading the LCOV report the runner
  writes to `.tmp/coverage/`).

---

## 3. Project Structure & Layering

```
mp3-manager/
├── index.html                   # The app's page: #app and src/main.ts
├── src/
│   ├── main.ts                  # Theme sheets, mounts views/app.html, starts session and verifier
│   ├── types.ts                 # Track, metadata, tree row, root and .meta snapshot types
│   ├── html-modules.d.ts        # *.html imports are jq79 components
│   ├── helpers/                 # Pure functions, each with a .test.ts beside it:
│   │                            # metadata, tracks, tree, snapshot, format, i18n,
│   │                            # selection, scope, albums, session, queue, rename, views, m3u,
│   │                            # playlists, spectrum, id3v2
│   ├── assets/brand/            # jackbird-metal.svg: the logo (faceplate, landing, favicon)
│   ├── components/
│   │   └── cover-drop.html      # Store-free: a cover to drop, choose or remove
│   ├── views/
│   │   ├── app.html             # Root: faceplate, workspace, the dialogs
│   │   ├── faceplate.html       # Brand, the deck's keys (the panel selector on phones), display,
│   │   │                        # root tabs (one tab with a picker on phones), folder key, selection
│   │   ├── deck-keys.html       # Transport, list and preferences keys (header, or phones' footer)
│   │   ├── workspace.html       # The two panes (swipeable on phones, the keys in a footer), Escape
│   │   ├── library.html         # The tree (or a view), its head (view keys, count), messages, scan meter
│   │   ├── album-sheet.html     # Landing, albums and discs
│   │   ├── selection-dialog.html # The selection: Info, Edit, Rename and Delete tabs
│   │   ├── queue-dialog.html    # The queue on a computer: its list, Save as playlist, Clear upcoming
│   │   ├── playlist-dialog.html # The playlist dialog as a Modal: add to one, delete one, save the queue
│   │   ├── playlist-form.html   # Its form (also the queue dialog's SubModal); playlist-keys.html its keys
│   │   ├── queue-panel.html     # The queue on a phone: a panel above the footer
│   │   ├── queue-list.html      # The queue's tracks: covers, drag, play, remove
│   │   └── preferences-dialog.html # Tone and language
│   └── lib/
│       ├── id3.ts               # readTrackMetadataFromBytes / writeTrackMetadataToBytes
│       ├── meta.ts              # Reads and writes .meta/mp3-manager.json; flushMeta queues writes
│       ├── roots.ts             # hydrateRoot, openFolder, selectRoot, closeRoot, …
│       ├── workspace.ts         # The active root: tree, scope, selection, and actions
│       ├── editor.ts            # The metadata form; openEditor, saveEdits
│       ├── player.ts            # The one Audio element; nowPlaying, the queue's actions and entries
│       ├── opaque.ts            # Opaque: derived values handed to views boxed
│       ├── menus.ts             # The rows' ⋮ menus: track, folder, playlist, entry; and doing it
│       ├── playlists.ts         # Playlists over PlaylistStore (.m3u8 files now): make, add, move, delete
│       ├── rename.ts            # Renaming the selection by a %field% pattern; the library follows
│       ├── media.ts             # A track's file as a URL to play, without reading it
│       ├── session.ts           # restoreSession, keepSessionSaved
│       ├── rootSessionStore.ts  # IndexedDB persistence of open roots
│       ├── verifier.ts          # Background checksum verification of stale tracks
│       ├── library.ts, playback.ts, ui.ts  # jq79 stores for the app's state
│       ├── preferences.ts       # Theme and language: saved, else from the system
│       ├── storage.ts           # Every localStorage key, in one place
│       └── i18n.ts              # t(), tn(); locales/en.ts (source), locales/es.ts
├── theme/default/               # Deck design system (served at /theme/default/)
│   ├── tokens.css               # Every --mm-* value, Silver and Graphite
│   ├── fonts.css, fonts/        # Self-hosted woff2 + OFL licences
│   ├── content.css              # Classes for plain markup (legend, table, display rows)
│   ├── base.css                 # Box sizing; the body's ground, ink and type
│   ├── components/*.html        # jq79: key, key-bank (its recess shaped to the keys), display, meter,
│   │                            # lamp, tabs, modal, sub-modal, menu, …
│   └── index.html, demo.ts/.html # The demo page
├── crates/                      # Rust: jackbird's tag engine (Cargo.toml at the root is its workspace)
│   ├── id3/                     # jackbird-id3: ID3v2 frames, text and picture codecs
│   ├── flac/                    # jackbird-flac: FLAC blocks, Vorbis comments, pictures
│   └── tags/                    # jackbird-tags: fields, cover, audio region, safe writes
├── fixtures/tags/               # Shared tag fixtures, cases.json, and make.mjs that makes them
├── src-tauri/                   # The Tauri v2 shell (E0), its own Cargo project
├── scripts/                     # check-layers.mjs, check-coverage.mjs (run by npm test)
├── RECORD/                      # Specs, plans, walkthroughs & audit trail (see AGENTS.md)
└── ROADMAP/                     # Dated roadmaps with Mermaid Gantt charts (see AGENTS.md)
```

---

## 4. Applied Functional Requirements

### Root workspaces & tabs
- Multiple folders can be opened as roots simultaneously; each has its own tab
  (the faceplate's `Tabs`), track list, and grouping mode.
- Open roots (their directory handles) and grouping mode are persisted in IndexedDB and
  restored on reload if read/write permission is still granted.

### Track identification & metadata
- Tracks are found by walking the root through the VFS, read as bytes, and parsed into
  `TrackMetadata` (title, artist, album, year, genre, track number, cover) by the tag engine.
- A full checksum and an audio-only checksum (without the ID3 tag) are computed per track for
  change detection and cached in a per-root `.meta/mp3-manager.json` snapshot
  (`MetaSnapshot` / `MetaRecord`). A background verifier re-checks tracks whose checksums are
  missing or more than a day old, re-reading the tags of a file changed outside the app. It
  holds off while a save is under way and never records over what a save recorded; `.meta/` is
  written through one queue per root (`flushMeta`), always from the library's latest state.
- Edits are written into the file's bytes by the tag engine, which keeps every frame it does not
  edit and refuses a write that fails its safeguards, and written in place through the VFS;
  `.meta/` is updated with the new checksums. A save of several tracks that one refuses stops
  there: the tracks before it stay saved and recorded.

### The library
- The active root is shown as a folder tree (folders, discs, tracks) next to an album sheet
  with what the active folder holds, grouped into albums and discs.

---

## 5. Applied UI / UX Requirements & Features

- Tabs for multiple open roots, each showing a loaded/total track count while metadata is
  still being read.
- In the tree and the album sheet, a click (or Enter) on a track plays it, and a box at its left
  selects it (Shift-click for a range, Space and Shift+Space, Escape to clear).
- The selection's key in the tab bar opens one dialog with Info, Edit, Rename and Delete tabs (green, orange, orange, red on top). The editor
  works on one track or many: a field that varies across the selection keeps each track's value
  unless typed over or its "Override" box is ticked (then even an empty value is written); cover art by
  drag & drop or file choice. Delete removes the tracks from the library (not from disk).
- Session restore on load: previously opened roots (with granted permission) reopen
  automatically, keeping the last active tab, each root's open folders and current row, and (for
  the tab, in `sessionStorage`) the phone's panel, the panes' scroll and the music: the same track
  at the same second, playing again, or on the first interaction when autoplay is not allowed.
- Light (Silver) and dark (Graphite) tone, from the faceplate's switch or Preferences,
  defaulting to the OS `prefers-color-scheme` and persisted across reloads.
- Interface in English or Spanish, chosen in Preferences, defaulting to the browser's
  language (English when it is neither) and persisted across reloads.
- On phones, the faceplate stays on top with the panel selector, the tree and the album sheet are
  full-screen panes that are swiped between, the deck's keys sit in a footer, and dialogs are bottom
  sheets that can be dragged down to close.
