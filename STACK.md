# Technology Stack & Architecture

This document describes the technical stack and codebase architecture implemented in the
`mp3-manager` project.

---

## 1. Core Architecture & Design Principles

- **100% Client-Side / Zero Backend**: Operates strictly inside the user's browser using the
  Chromium **File System Access API** (`showDirectoryPicker`, `FileSystemDirectoryHandle`).
  Files are never uploaded to any remote server.
- **VFS Abstraction**: All file access goes through the `VfsAdapter` interface
  (`src/vfs/types.ts`), implemented today by `BrowserVfs` (`src/vfs/browserVfs.ts`) on top of
  the File System Access API. The UI never depends on `FileSystemFileHandle` directly, so a
  different backend (e.g. remote sync) can be plugged in later.
- **Metadata engine over bytes**: `src/lib/id3.ts` reads/writes ID3 tags on `Uint8Array`
  buffers, not on file handles, so it stays decoupled from the VFS implementation.
- **Multi-root workspaces**: Several folders ("roots") can be open at once as tabs; each root
  keeps its own track list, metadata draft, and grouping mode.
- **Small, reusable components / stateful views**: `src/components/` holds presentational
  components with no store coupling; views compose them over the `src/lib/` stores. The top bar
  and the library (tree and album sheet) are jq79 views (`src/views/faceplate.html`,
  `src/views/workspace.html`); the React `src/views/Mp3ManagerView.tsx` mounts them through
  `Jq79Island` and keeps the dialogs, saving and the session until they move too.

---

## 2. Technology Stack

### Frontend & UI
- **Language**: TypeScript (`^5.6.2`).
- **UI Library**: React 18 (`^18.3.1`) with `react-dom`, moving screen by screen to
  [jq79](https://github.com/jgermade/jq79) (`^0.7.7`): single-file `.html` components with
  TypeScript setup scripts, imported through its Vite plugin (`jq79/vite`, with `safeEval`, so
  no `'unsafe-eval'` is needed). See the layers in `AGENTS.md`.
- **Styling**: a single vanilla CSS file (`src/styles.css`) using CSS custom properties
  (`:root` variables) for colors, spacing and fonts.
- **Design system**: "Deck", the default theme in `theme/default/`: `tokens.css` (every
  `--mm-*` value, Silver light tone and Graphite dark tone), `fonts.css` with self-hosted
  woff2 files (IBM Plex Sans/Mono, Archivo, Doto; SIL OFL), `content.css` (classes for plain
  markup: `.mm-legend`, `.mm-table`, the display's rows), and jq79 components that draw only
  with the tokens. Sizes are in rem; on phones (≤ 480px) the root font size is `4vw`, so the
  interface scales linearly with the screen. Its demo is served at `/theme/default/`. The
  app's screens move over to it one at a time (see `ROADMAP/2026-11-03/deck-design-system.md`).

### Web APIs & Metadata
- **File System Access API**: directory picking, permission checks, file streaming and
  in-place writes (`src/vfs/browserVfs.ts`).
- **ID3 tagging**: `jsmediatags` (`^3.9.7`, imported from
  `jsmediatags/dist/jsmediatags.min.js` to avoid Vite resolution issues with the package
  root) for reading tags, and `browser-id3-writer` (`^6.3.0`) for writing them back.
- **Session persistence**: `src/lib/rootSessionStore.ts` persists open root handles and
  their grouping mode in IndexedDB (`mp3-manager` database) so workspaces survive a reload.
- **State**: jq79 `$reactive` stores in `src/lib/`: `library` (roots, active root, loading and
  saving flags, messages), `playback` (queue, position, playing), `ui` (open dialogs) and
  `preferences` (theme and language, saved under the keys in `src/lib/storage.ts`). The React
  view reads them through `useStoreValue` (`src/lib/react-store.ts`), which hands React plain
  objects, until its screens become jq79 views.
- **Languages**: English (source and fallback) and Spanish. `src/lib/i18n.ts` gives `t` and
  `t.n` (plurals via `Intl.PluralRules`) over the catalogues in `src/lib/locales/`. The
  language follows the browser until one is chosen in Preferences, and sets `<html lang>`.

### Build Tools & Tooling
- **Bundler & Dev Server**: Vite (`^5.4.8`), with two entries: the app (`index.html`) and the
  theme demo (`theme/default/index.html`).
- **Type checking**: `tsc --noEmit` (the `build` script runs it before `vite build`; the
  project has `"noEmit": true` in `tsconfig.json`, so `tsc` never writes `.js` files —
  Vite/esbuild handles all transpilation).
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
├── src/
│   ├── App.tsx                  # Root component, renders Mp3ManagerView
│   ├── main.tsx                 # DOM mounting & root entrypoint
│   ├── types.ts                 # Track, metadata, tree row and .meta snapshot types
│   ├── html-modules.d.ts        # *.html imports are jq79 components
│   ├── helpers/                 # Pure functions, each with a .test.ts beside it:
│   │                            # metadata, tracks, tree, snapshot, format, i18n,
│   │                            # selection, scope, albums
│   ├── styles.css               # Single stylesheet, CSS variables in :root
│   ├── assets/brand/            # jackbird-metal.svg: the logo (faceplate, favicon)
│   ├── components/              # Presentational, store-free UI components (React, until moved)
│   │   ├── MetadataEditor.tsx   # ID3 field editor for the selected track
│   │   └── CoverDropzone.tsx    # Drag & drop / pick cover art
│   ├── views/
│   │   ├── faceplate.html       # jq79: brand, transport, display, root tabs + folder key
│   │   ├── workspace.html       # jq79: the two panes (swipeable on phones), Escape
│   │   ├── library.html         # jq79: the tree, its head, messages and scan meter
│   │   ├── album-sheet.html     # jq79: landing, action bar, albums and discs
│   │   ├── Jq79Island.tsx       # Mounts a jq79 view inside React (until React goes)
│   │   └── Mp3ManagerView.tsx   # React: dialogs, saving, session restore, verifier
│   ├── lib/
│   │   ├── id3.ts               # readTrackMetadataFromBytes / writeTrackMetadataToBytes
│   │   ├── rootSessionStore.ts  # IndexedDB persistence of open roots
│   │   ├── meta.ts              # Reads and writes .meta/mp3-manager.json in a root
│   │   ├── roots.ts             # hydrateRoot, openFolder, selectRoot, closeRoot, …
│   │   ├── player.ts            # The one Audio element; nowPlaying, playQueue, next, …
│   │   ├── workspace.ts         # The active root: tree, scope, selection, and actions
│   │   ├── library.ts, playback.ts, ui.ts  # jq79 stores for the app's state
│   │   ├── preferences.ts       # Theme and language: saved, else from the system
│   │   ├── storage.ts           # Every localStorage key, in one place
│   │   ├── i18n.ts              # t(), t.n(), useT(); locales/en.ts (source), locales/es.ts
│   │   └── react-store.ts       # useStoreValue: React reads the stores (until React goes)
│   └── vfs/
│       ├── types.ts             # VfsAdapter contract (mount/listFiles/readFile/writeFile)
│       └── browserVfs.ts        # File System Access API implementation
├── theme/default/               # Deck design system (served at /theme/default/)
│   ├── tokens.css               # Every --mm-* value, Silver and Graphite
│   ├── fonts.css, fonts/        # Self-hosted woff2 + OFL licences
│   ├── content.css              # Classes for plain markup (legend, table, display rows)
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
  (the faceplate's `Tabs`), track list, and independent grouping mode (`flat` or `wizard`).
- Open roots (their directory handles) and grouping mode are persisted in IndexedDB via
  `rootSessionStore.ts` and restored on reload if read/write permission is still granted.

### Track identification & metadata
- Tracks are scanned via the VFS (`BrowserVfs.listFiles`), read as bytes
  (`BrowserVfs.readFile`), and parsed into `TrackMetadata` (title, artist, album, year,
  genre, track number, cover) via `jsmediatags`.
- A `checksum` is computed per track for change detection and cached in a per-root
  `.meta/mp3-manager.json` snapshot (`MetaSnapshot` / `MetaRecord`).
- Edits are written back as ID3 tags with `browser-id3-writer`, serialized to bytes, and
  persisted through `BrowserVfs.writeFile`; each write is recorded via
  `getWriteOperations()`.

### Explorer modes
- **Flat mode** (`TrackTable`): raw list of tracks in the root.
- **Wizard mode** (`TrackWizardList`): tracks folded into an album/disc tree
  (`WizardTreeRow`), with expand/collapse state per album and disc.

---

## 5. Applied UI / UX Requirements & Features

- Tabs for multiple open roots, each showing a loaded/total track count while metadata is
  still being read.
- Flat/Wizard mode switch scoped per active root.
- Metadata editor bound to the selected track, with cover art drag & drop
  (`CoverDropzone`).
- Session restore on load: previously opened roots (with granted permission) reopen
  automatically, keeping the last active tab.
- Light/dark theme in Preferences, defaulting to the OS `prefers-color-scheme` and
  persisted across reloads.
- Interface in English or Spanish, chosen in Preferences, defaulting to the browser's
  language (English when it is neither) and persisted across reloads.
