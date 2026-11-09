# Project Thesaurus

This document defines the canonical terms and domain concepts used in the `mp3-manager`
project to reduce ambiguity when discussing specifications, writing code, and
collaborating.

---

## Domain & Hierarchy

### Root (Root Workspace)
A folder opened by the user via the File System Access API and mounted through the VFS.
Each root is shown as its own tab (`RootTabs`) and keeps independent state: its track
list, selected track, metadata draft, grouping mode, and wizard tree expansion. Modeled
in code as `RootWorkspace`.

### Track
A single audio file (MP3 or FLAC, `src/helpers/formats.ts`) inside a root, identified by `id`
(a VFS file id) and `relativePath`. Carries its `size`, a content `checksum`, and its parsed
`metadata`. Modeled as `Track` (`Mp3Track` until E3).

### Metadata (tags)
The editable tag fields of a track (ID3v2 frames in MP3, Vorbis comments in FLAC): `title`, `artist`, `album`, `year`, `genre`,
`trackNumber`, and `coverDataUrl`. Modeled as `TrackMetadata`; `EditableMetadata` is the
same shape used for the in-progress editor draft.

### Checksum
A content hash computed for a track, used to detect changes between scans and to key the
per-root metadata cache (`MetaRecord`). Not a cryptographic identity system like
rom-manager's DAT matching — here it only detects "has this file changed".

---

## VFS (Virtual File System)

### VfsAdapter
The interface (`src/vfs/types.ts`) all file access goes through: `mount`, `listFiles`,
`readFile`, `writeFile`, `getWriteOperations`. The UI and metadata engine depend only on
this contract, never on `FileSystemFileHandle` directly.

### BrowserVfs
The current `VfsAdapter` implementation (`src/vfs/browserVfs.ts`), backed by the
Chromium File System Access API.

### VfsFile
A lightweight file reference returned by `listFiles`: `id`, `name`, `relativePath`,
`size`.

### Write Operation
A record (`VfsWriteOperation`) of a completed write to a file, kept by the adapter for
auditing what has been persisted during the session.

---

## Explorer Modes (Grouping Mode)

### Flat mode
Raw listing of all tracks in a root, rendered by `TrackTable`, one row per track.

### Wizard mode
Tracks folded into an album/disc tree, rendered by `TrackWizardList`. Each node is a
`WizardTreeRow` of `kind` `"album"`, `"disc"`, or `"track"`, with `expanded` state kept
per album/disc.

---

## Persistence

### Root Session
The set of currently open roots and the active tab, persisted to IndexedDB
(`rootSessionStore.ts`) so they can be restored on reload if permission is still granted.
Modeled as `PersistedSession` / `PersistedRoot`.

### Meta Snapshot
The per-root cache of computed metadata and checksums, stored at
`.meta/mp3-manager.json` inside the root via the VFS. Modeled as `MetaSnapshot`
(a map of `relativePath` → `MetaRecord`).

### Meta Record
A single cached entry inside a `MetaSnapshot`: `checksum`, `metadata`, and `updatedAt`.

---

## People (the service, S3)

### Person
Someone with a place in an instance of jackbird's service: a name, a role, and, for sign-in, an
email. Every instance starts with one, its owner. Kept in `jackbird.db` (`crates/service/src/people.rs`).

### Profile
A person while sign-in is off: picked in the browser ("Who's listening?"), with no code or
passkey. Its role decides what is offered, not what is protected.

### Role
What a person may do, each including the ones before it: **listener** (plays), **editor**
(changes the folders), **admin** (adds editors and listeners, email, the log), **owner** (the
folders, the address, the network, sign-in, other owners and admins).

### Sign-in
The switch that makes people prove who they are: a one-time **code** sent by email, or a
**passkey**. Only an owner turns it on (by confirming their own address) or off. Sign-up is by
**invitation**: an owner or admin gives someone an address.

### Disabled
A person with sign-in on whose address is not confirmed yet: kept, with their role, but unable to
sign in until they type the code sent to it.

## Theming

### Theme
The light/dark visual mode of the app, managed by `ThemeService`. Defaults to the OS
`prefers-color-scheme` and is persisted (`localStorage`) once the user picks one
explicitly via `ThemeToggle`.
