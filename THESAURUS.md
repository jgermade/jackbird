# Project Thesaurus

This document defines the canonical terms and domain concepts used in the `musikmatch`
project to reduce ambiguity when discussing specifications, writing code, and
collaborating.

---

## Domain & Hierarchy

### Root (Root Workspace)
A folder opened by the user via the File System Access API, mounted through a `VFSAdapter`.
Each root is shown as its own tab (`RootTabs`) and keeps independent state: its track
list, selected track, metadata draft, grouping mode, and library tree expansion. Modeled
in code as `RootWorkspace`, which carries the adapter, the directory handle (for
re-authorising permission on reload) and the tracks.

### Track
A single audio file inside a root. Modeled as `Track`. On the current path-based adapter a
track's `id` and `relativePath` are the same string, so there is no opaque file id to keep
in step with the filesystem. Carries its `size`, `lastModified`, its parsed `metadata`, and
the dual checksums used to tell "changed" from "not changed".

### Metadata (ID3 tags)
The editable ID3 fields of a track: `title`, `artist`, `album`, `year`, `genre`,
`trackNumber`, and `coverDataUrl`. Modeled as `TrackMetadata`; `EditableMetadata` is the
same shape used for the in-progress editor draft.

### Checksum
Content hashes computed for a track, used to detect changes between scans and to key the
per-root metadata cache (`MetaRecord`). Two of them: `fullChecksum` covers the whole file,
`audioChecksum` covers only the audio payload with ID3v2/ID3v1/APE stripped, so a tag edit
does not change the audio identity. Computed with **SHA-1** today (`sha1Hex`, `id3.ts`). The `.meta`
v2 sidecars keep those values as `audio_sha1` / `full_sha1` and reserve `audio_sha256` (D7), which
stays `null` until the background verifier computes it. Not a cryptographic identity system
like rom-manager's DAT matching — here it only detects "has this file changed".

---

## VFS (Virtual File System)

### VFSAdapter
The interface every storage backend implements, imported from `@cloudauthn/vfs-sync`:
`list`, `read`, `write`, `delete`, `rename`, `stat`, plus optional streaming
(`readRange`, `readStream`, `writeStream`). Paths are relative to the adapter root, use `/`
and never start with one. The UI and the metadata engine depend only on this contract — and
it is the same contract the sync engine consumes, so nothing has to be translated between
"storage" and "sync".

### FSAAdapter
The adapter in use (`@cloudauthn/vfs-sync`): the Chromium File System Access API. Adds
`pick`, `fromHandle`, `hasPermission` and `ensurePermission` on top of the contract.
Another adapter (OPFS, Drive, Node) swaps in without touching any component.

### walk
Helper that lists everything under an adapter root recursively, skipping the `.vfs` control
folder. The library uses it plus an extension filter to find tracks.

---

## Explorer Modes (Grouping Mode)

### Wizard mode
The library pane (`TrackWizardList`) folds tracks into an album/disc tree. Each node is a
`WizardTreeRow` of `kind` `"album"`, `"disc"`, or `"track"`, with `expanded` state kept
per album/disc.

### Flat mode
A legacy value of `groupingMode` (`"flat"`). It is still persisted per root but no longer
rendered by anything: the library pane always shows the tree. Do not describe UI behaviour
in terms of it until it is either restored or removed from the persisted session.

---

## Persistence

### Root Session
The set of currently open roots and the active tab, persisted to IndexedDB
(`rootSessionStore.ts`) so they can be restored on reload if permission is still granted.
Modeled as `PersistedSession` / `PersistedRoot`. The database is still named `mp3-manager`:
renaming it would orphan every saved session, so it was left alone when the project was renamed and
needs its own copy-then-delete migration (together with the `mp3-manager.theme` key) before the name
can change.

### Meta Snapshot
The in-memory view of the `.meta` records for a root: a map of `relativePath` → `MetaRecord`.
Modeled as `MetaSnapshot`, `version: 2`. It is a projection — the on-disk truth is the sidecar.

### Meta Record
One track's entry inside a `MetaSnapshot`: `trackId`, the dual checksums, `size`, `lastModified`,
`lastVerifiedAt`, `metadata`, `updatedAt`.

### Sidecar (Track Record)
`.meta/tracks/<track_id>.json`, one per track, owned by `metaStore.ts`. Named by `track_id` rather
than by path, so renaming the audio is an edit to a file whose name does not change. Holds `path`,
`tags`, `images[]`, the legacy SHA-1 hashes, `audio_sha256`, `rev_id`, and reserved MusicBrainz
fields. One writer per file: a conflict costs one song, never the library.

### Image Store
`.meta/images/<sha256>.front.<ext>`. Content-addressed cover art, deduplicated across tracks. The
hash is the identity and equals the vfs-sync blob address; the role suffix is a browsing hint and
the record is the source of truth.

### Library Header
`.meta/library.json`: `{ schema, created_at }`. Written **last** during migration, so its presence is
what says the layout is complete. Checked on every load.

### Schema Gate
The check that refuses to load or write `.meta` when the header's `schema`, the v1 file's `version`,
or either file's contents are not understood (`UnsupportedMetaVersionError` /
`MetaFileCorruptError`). An old build must never overwrite a library it does not understand.

---

## Theming

### Theme
The light/dark visual mode of the app, managed by `ThemeService`. Defaults to the OS
`prefers-color-scheme` and is persisted (`localStorage`) once the user picks one
explicitly via `ThemeToggle`.
