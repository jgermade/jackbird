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
  components with no store coupling; `src/views/Mp3ManagerView.tsx` owns state and composes
  them.

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

### Build Tools & Tooling
- **Bundler & Dev Server**: Vite (`^5.4.8`), with two entries: the app (`index.html`) and the
  theme demo (`theme/default/index.html`).
- **Type checking**: `tsc --noEmit` (the `build` script runs it before `vite build`; the
  project has `"noEmit": true` in `tsconfig.json`, so `tsc` never writes `.js` files —
  Vite/esbuild handles all transpilation).
- **Scripts Runtime**: Node.js, `"type": "module"`.

---

## 3. Project Structure & Layering

```
mp3-manager/
├── src/
│   ├── App.tsx                  # Root component, renders Mp3ManagerView
│   ├── main.tsx                 # DOM mounting & root entrypoint
│   ├── types.ts                 # Track / TrackMetadata / EditableMetadata types
│   ├── styles.css               # Single stylesheet, CSS variables in :root
│   ├── components/              # Presentational, store-free UI components
│   │   ├── FolderPicker.tsx     # "Open folder" button + loading state
│   │   ├── RootTabs.tsx         # Tab bar for open root workspaces
│   │   ├── TrackTable.tsx       # Flat-mode track listing
│   │   ├── TrackWizardList.tsx  # Wizard-mode tree (album/disc/track rows)
│   │   ├── MetadataEditor.tsx   # ID3 field editor for the selected track
│   │   └── CoverDropzone.tsx    # Drag & drop / pick cover art
│   ├── views/
│   │   └── Mp3ManagerView.tsx   # Owns all state: roots, tabs, session restore,
│   │                            # metadata drafts, wizard tree building, saving
│   ├── lib/
│   │   ├── id3.ts               # readTrackMetadataFromBytes / writeTrackMetadataToBytes
│   │   └── rootSessionStore.ts  # IndexedDB persistence of open roots
│   ├── services/
│   │   └── ThemeService.ts      # Light/dark theme, persisted + system preference
│   └── vfs/
│       ├── types.ts             # VfsAdapter contract (mount/listFiles/readFile/writeFile)
│       └── browserVfs.ts        # File System Access API implementation
├── theme/default/               # Deck design system (served at /theme/default/)
│   ├── tokens.css               # Every --mm-* value, Silver and Graphite
│   ├── fonts.css, fonts/        # Self-hosted woff2 + OFL licences
│   ├── content.css              # Classes for plain markup (legend, table, display rows)
│   ├── components/*.html        # jq79: key, key-bank, display, meter, lamp, tabs, modal, …
│   └── index.html, demo.ts/.html # The demo page
├── RECORD/                      # Specs, plans, walkthroughs & audit trail (see AGENTS.md)
└── ROADMAP/                     # Dated roadmaps with Mermaid Gantt charts (see AGENTS.md)
```

---

## 4. Applied Functional Requirements

### Root workspaces & tabs
- Multiple folders can be opened as roots simultaneously; each has its own tab
  (`RootTabs`), track list, and independent grouping mode (`flat` or `wizard`).
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
- Light/dark theme toggle (`ThemeToggle`), defaulting to the OS `prefers-color-scheme`
  and persisted across reloads.
