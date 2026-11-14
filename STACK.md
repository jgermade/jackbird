# Technology Stack & Architecture

This document describes the technical stack and codebase architecture implemented in the
`musikmatch` project.

---

## 1. Core Architecture & Design Principles

- **100% Client-Side / Zero Backend**: Operates strictly inside the user's browser using the
  Chromium **File System Access API** (`showDirectoryPicker`, `FileSystemDirectoryHandle`).
  Files are never uploaded to any remote server.
- **VFS Abstraction**: All file access goes through the `VFSAdapter` interface exported by
  `@cloudauthn/vfs-sync` — path-based (`list`, `read`, `write`, `delete`, `rename`, `stat`,
  optional streaming). The UI is typed against the interface, never against a concrete adapter,
  so the same seam already serves OPFS, Google Drive, Node fs and the sync engine. Today the only
  implementation used is `FSAAdapter` (File System Access API).
- **Metadata engine over bytes**: `src/lib/id3.ts` reads/writes ID3 tags on `Uint8Array`
  buffers, not on file handles, so it stays decoupled from the VFS implementation.
- **Multi-root workspaces**: Several folders ("roots") can be open at once as tabs; each root
  keeps its own track list, metadata draft, and grouping mode.
- **Small, reusable components / stateful views**: `src/components/` holds presentational
  components with no store coupling; `src/views/LibraryView.tsx` owns state and composes
  them.

---

## 2. Technology Stack

### Frontend & UI
- **Language**: TypeScript (`^5.6.2`).
- **UI Library**: React 18 (`^18.3.1`) with `react-dom`.
- **Styling**: a single vanilla CSS file (`src/styles.css`) using CSS custom properties
  (`:root` variables) for colors, spacing and fonts.

### Web APIs & Metadata
- **File System Access API**: directory picking, permission re-authorisation, file streaming and
  in-place writes, through `FSAAdapter` from `@cloudauthn/vfs-sync`.
- **ID3 tagging**: `jsmediatags` (`^3.9.7`, imported from
  `jsmediatags/dist/jsmediatags.min.js` to avoid Vite resolution issues with the package
  root) for reading tags, and `browser-id3-writer` (`^6.3.0`) for writing them back.
- **Session persistence**: `src/lib/rootSessionStore.ts` persists open root handles and
  their grouping mode in IndexedDB (database name still `mp3-manager`, kept deliberately so
  existing sessions keep restoring) so workspaces survive a reload.

### Build Tools & Tooling
- **Bundler & Dev Server**: Vite (`^5.4.8`).
- **Type checking**: `tsc --noEmit` (the `build` script runs it before `vite build`; the
  project has `"noEmit": true` in `tsconfig.json`, so `tsc` never writes `.js` files —
  Vite/esbuild handles all transpilation).
- **Scripts Runtime**: Node.js, `"type": "module"`.

---

## 3. Project Structure & Layering

```
musikmatch/
├── src/
│   ├── App.tsx                  # Root component, renders LibraryView
│   ├── main.tsx                 # DOM mounting & root entrypoint
│   ├── types.ts                 # Track / TrackMetadata / EditableMetadata types
│   ├── styles.css               # Single stylesheet, CSS variables in :root
│   ├── components/              # Presentational, store-free UI components
│   │   ├── LibraryLanding.tsx   # Empty state: "open a folder"
│   │   ├── FolderPicker.tsx     # "Open folder" button + loading state
│   │   ├── RootTabs.tsx         # Tab bar for open root workspaces
│   │   ├── TrackWizardList.tsx  # Library pane: album/disc/track tree rows
│   │   ├── AlbumOverview.tsx    # Detail pane: album/disc listing with play actions
│   │   ├── DetailActionBar.tsx  # Actions for the current multi-selection
│   │   ├── MetadataEditor.tsx   # ID3 field editor (single track or batch)
│   │   ├── MetadataEditModal.tsx# Modal wrapper around MetadataEditor
│   │   ├── TrackInfoModal.tsx   # Technical details: checksums, sizes, verification
│   │   ├── PlaybackBar.tsx      # Persistent player + queue controls
│   │   ├── PreferencesModal.tsx # Preferences surface
│   │   ├── ThemeToggle.tsx      # Light/dark switch
│   │   └── CoverDropzone.tsx    # Drag & drop / pick cover art
│   ├── views/
│   │   └── LibraryView.tsx      # Owns all state: roots, tabs, session restore,
│   │                            # metadata drafts, library tree, saving, playback
│   ├── lib/
│   │   ├── id3.ts               # readTrackMetadataFromBytes / writeTrackMetadataToBytes
│   │   │                        # + dual checksums (SHA-1 today) and sha256Hex
│   │   ├── metaStore.ts         # `.meta` v2: sidecars, image store, v1 migration, gate
│   │   └── rootSessionStore.ts  # IndexedDB persistence of open roots
│   └── services/
│       └── ThemeService.ts      # Light/dark theme, persisted + system preference
└── SESSIONS/                    # Chronological session specifications & audit trail
```

Storage access lives outside `src/`: the adapter contract and its FSA implementation are
imported from `@cloudauthn/vfs-sync`.

---

## 4. Applied Functional Requirements

### Root workspaces & tabs
- Multiple folders can be opened as roots simultaneously; each has its own tab
  (`RootTabs`), track list, and independent grouping mode (`flat` or `wizard`).
- Open roots (their directory handles) and grouping mode are persisted in IndexedDB via
  `rootSessionStore.ts` and restored on reload if read/write permission is still granted.

### Track identification & metadata
- Tracks are discovered with `walk(adapter)` (vfs-sync) filtered to `.mp3`, read as bytes with
  `adapter.read(path)`, and parsed into `TrackMetadata` (title, artist, album, year,
  genre, track number, cover) via `jsmediatags`.
- Because the adapter is path-based, a track's `id` and `relativePath` are the same string; there
  is no separate opaque file id to keep in sync.
- Dual checksums (`fullChecksum` over the file, `audioChecksum` over the audio payload with
  ID3v2/ID3v1/APE stripped) are computed per track and stored in the track's `.meta` sidecar.
- Metadata lives in **`.meta` v2** (`src/lib/metaStore.ts`): `library.json` carries the schema,
  `tracks/<track_id>.json` holds one record per track (named by identity, so a rename is an edit),
  and `images/<sha256>.front.<ext>` is the content-addressed artwork store. Editing a track rewrites
  one small file, never the library. The v1 `.meta/mp3-manager.json` is read once and migrated, then
  left untouched.
- Edits are written back as ID3 tags with `browser-id3-writer`, serialized to bytes, and persisted
  through `adapter.write(path, bytes)`.

### Explorer modes
- **Wizard mode** (`TrackWizardList`): the library pane renders an album/disc/track tree
  (`WizardTreeRow`), with expand/collapse state per album and disc.
- **Flat mode** is still a persisted `groupingMode` value but no longer reachable from the UI: the
  library pane always renders the tree. The field survives only in the stored session.

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
