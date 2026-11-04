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
- **Metadata engine over bytes**: `src/lib/id3.ts` reads/writes ID3 tags on `Uint8Array`
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
  writes, through the VFS adapter.
- **ID3 tagging**: `jsmediatags` (`^3.9.7`, imported from
  `jsmediatags/dist/jsmediatags.min.js` to avoid Vite resolution issues with the package
  root) for reading tags, and `browser-id3-writer` (`^6.3.0`) for writing them back.
- **Session persistence**: `src/lib/session.ts` restores the open roots on load and saves them
  whenever they change; `src/lib/rootSessionStore.ts` keeps their handles and grouping mode in
  IndexedDB (`mp3-manager` database).
- **State**: jq79 `$reactive` stores in `src/lib/`: `library` (roots, active root, loading and
  saving flags, messages), `playback` (queue, position, playing), `ui` (open dialogs),
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
│   │                            # selection, scope, albums, session
│   ├── assets/brand/            # jackbird-metal.svg: the logo (faceplate, landing, favicon)
│   ├── components/
│   │   └── cover-drop.html      # Store-free: a cover to drop, choose or remove
│   ├── views/
│   │   ├── app.html             # Root: faceplate, workspace, the three dialogs
│   │   ├── faceplate.html       # Brand, transport, display, root tabs + folder key
│   │   ├── workspace.html       # The two panes (swipeable on phones, footer selector), Escape
│   │   ├── library.html         # The tree, its head, messages and scan meter
│   │   ├── album-sheet.html     # Landing, action bar, albums and discs
│   │   ├── edit-dialog.html     # Metadata editor (one track or many)
│   │   ├── info-dialog.html     # File information (one track or totals)
│   │   └── preferences-dialog.html # Tone and language
│   └── lib/
│       ├── id3.ts               # readTrackMetadataFromBytes / writeTrackMetadataToBytes
│       ├── meta.ts              # Reads and writes .meta/mp3-manager.json in a root
│       ├── roots.ts             # hydrateRoot, openFolder, selectRoot, closeRoot, …
│       ├── workspace.ts         # The active root: tree, scope, selection, and actions
│       ├── editor.ts            # The metadata form; openEditor, saveEdits
│       ├── player.ts            # The one Audio element; nowPlaying, playQueue, next, …
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
│   ├── components/*.html        # jq79: key, key-bank, display, meter, lamp, tabs, modal, …
│   └── index.html, demo.ts/.html # The demo page
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
  `TrackMetadata` (title, artist, album, year, genre, track number, cover) via `jsmediatags`.
- A full checksum and an audio-only checksum (without the ID3 tag) are computed per track for
  change detection and cached in a per-root `.meta/mp3-manager.json` snapshot
  (`MetaSnapshot` / `MetaRecord`). A background verifier re-checks tracks whose checksums are
  missing or more than a day old.
- Edits are written back as ID3 tags with `browser-id3-writer`, serialized to bytes, and
  written in place through the VFS; `.meta/` is updated with the new checksums.

### The library
- The active root is shown as a folder tree (folders, discs, tracks) next to an album sheet
  with what the active folder holds, grouped into albums and discs.

---

## 5. Applied UI / UX Requirements & Features

- Tabs for multiple open roots, each showing a loaded/total track count while metadata is
  still being read.
- Selection in the tree and the album sheet (click, Shift-click for a range, arrows, Escape).
- Metadata editor for one track or many: a field that varies across the selection keeps each
  track's value unless typed over; cover art by drag & drop or file choice.
- Session restore on load: previously opened roots (with granted permission) reopen
  automatically, keeping the last active tab.
- Light (Silver) and dark (Graphite) tone, from the faceplate's switch or Preferences,
  defaulting to the OS `prefers-color-scheme` and persisted across reloads.
- Interface in English or Spanish, chosen in Preferences, defaulting to the browser's
  language (English when it is neither) and persisted across reloads.
- On phones, the faceplate stays on top and the tree and the album sheet are full-screen panes
  that are swiped between, with a selector in a footer at the bottom.
