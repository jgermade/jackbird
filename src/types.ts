import type { VFSAdapter, WalkedFile } from "@cloudauthn/vfs-sync";
import type { ServiceClient } from "./lib/sources/service";

export type TrackMetadata = {
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  trackNumber: string;
  /** The disc, `n` or `n/total`. */
  discNumber: string;
  /** The album's artist, when it is not each track's. */
  albumArtist: string;
  /** Part of a compilation: "1" (or as the file holds it); "" when not. */
  compilation: string;
  /** Who wrote the music. */
  composer: string;
  /** The comment (ID3's `COMM` with no description, Vorbis' `COMMENT`). */
  comment: string;
  /** The lyrics, unsynchronised (`USLT`, `LYRICS`). */
  lyrics: string;
  /** Beats per minute, a whole number as text (`TBPM`, `BPM`); "" when not known. */
  bpm: string;
  coverDataUrl: string | null;
};

export type Track = {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  checksum: string;
  fullChecksum?: string;
  audioChecksum?: string;
  lastModified?: number;
  lastVerifiedAt?: string;
  metadata: TrackMetadata;
  /** Its audio's length and rates (crates/tags `Audio`), when known. */
  audio?: AudioProps | null;
  /** Its tags not read yet: what its name says shown meanwhile (a folder opened with no `.meta/`). */
  pending?: boolean;
};

export type EditableMetadata = TrackMetadata;

/** One row of the library tree: a folder ("album"), a disc or a track. */
export type WizardTreeRow = {
  key: string;
  kind: "album" | "disc" | "track";
  /** A folder's path (Files), or a group's key (the other views): what opens and closes it. */
  album: string;
  label: string;
  parentKey: string | null;
  depth: number;
  disc?: string;
  expanded?: boolean;
  /** With the songs out of the tree (helpers/folders.ts): a folder or group that holds no other, which a phone opens in Details. */
  leaf?: boolean;
  trackId?: string;
  trackNumber?: string;
  artist?: string;
  relativePath?: string;
  /** A track's codec, as its mark shows it (`codecLabel`). */
  format?: string;
  /** Small text at the row's end; else a track's artist. */
  meta?: string;
  /** An album's line under its name (who it is by, its year), drawn there in place of `meta`. */
  sub?: string;
  /** An album's (or an album folder's) cover, as its tracks hold it (`jackbird-cover:<name>`). */
  cover?: string;
  /** Drawn with a cover's room, with or without one: every album row, and folders beside one with a cover, line up. */
  framed?: boolean;
  /** Its picture drawn round: an artist's. */
  round?: boolean;
  /** A view's group: its tracks' ids, in the order they play. */
  trackIds?: string[];
  /** The view a row belongs to, when it is not Files. */
  inView?: LibraryView;
  /** A playlist's path (its group and entries), and an entry's place in it. */
  playlist?: string;
  playlistIndex?: number;
  /** A playlist entry that is not in the library. */
  missing?: boolean;
  /** A track whose tags are not read yet (`Track.pending`). */
  pending?: boolean;
};

/** How the library lists a root: its folders, or grouped by tags, or its playlists. */
export type LibraryView = "files" | "playlists" | "artists" | "albumsByArtist" | "albums" | "compilations" | "songs";

/** One entry of a playlist: its path in the root when it resolves, and what the file said of it. */
export type PlaylistEntry = {
  /** The track's path in the root; null when it cannot be resolved (absolute, a URL, outside the root). */
  path: string | null;
  /** The line as the file had it. */
  raw: string;
  /** From `#EXTINF`, when there was one. */
  title?: string;
  duration?: number;
};

/** A playlist file of a root (`.m3u8`, `.m3u`). */
export type Playlist = {
  /** Its path in the root. */
  path: string;
  /** Its file name without the extension. */
  name: string;
  entries: PlaylistEntry[];
};

/** What `.meta/mp3-manager.json` keeps about one track, by relative path. */
/** A file's audio (crates/tags `Audio`): its length, rates, channels and depth. */
export type AudioProps = {
  durationMs: number;
  /** kbit/s; its average for a variable one. */
  bitrate: number;
  /** Hz; 0 where it is not known (an iPod's database keeps none). */
  sampleRate: number;
  channels: number;
  /** Bits per sample; 0 for MP3. */
  bits: number;
  vbr: boolean;
  /** Its type as an iPod's database names it ("Apple Lossless audio file"), where one does: the
   * codec an `.m4a` holds, which its name does not tell. */
  kind?: string;
};

export type MetaRecord = {
  checksum: string;
  fullChecksum?: string;
  audioChecksum?: string;
  size?: number;
  lastModified?: number;
  lastVerifiedAt?: string;
  metadata: TrackMetadata;
  /** Its audio; null when it cannot be told; absent in a record kept before it was read (read again then). */
  audio?: AudioProps | null;
  updatedAt: string;
};

/** The whole `.meta/mp3-manager.json` file. */
export type MetaSnapshot = {
  version: 1;
  tracks: Record<string, MetaRecord>;
  /** Each artist's picture, by the artist's name without case (helpers/views.ts `artistName`): a cover's reference. */
  artists?: Record<string, string>;
};

export type Theme = "light" | "dark";
/** How tall the lists' rows are (helpers/density.ts). */
export type Density = "compact" | "comfortable" | "spacious";

/** The interface languages; English is the source and the fallback. */
export type Language = "en" | "es";

/** How the display's spectrum draws its columns (helpers/spectrum.ts): stacked segments, or fine horizontal lines. */
export type SpectrumLook = "segments" | "lines";

/** How the display's spectrum's peaks fall (helpers/spectrum.ts), or none drawn. */
export type PeakFall = "none" | "fast" | "slow" | "very-slow";

export type GroupingMode = "flat" | "wizard";

/** One open folder ("root") and everything the library shows of it. */
export type RootWorkspace = {
  id: string;
  label: string;
  /** The storage seam for small files (`.meta/`, playlists) and renames: `source.vfs`. */
  vfs: VFSAdapter;
  /** Where the root lives (the browser's folder, or the desktop app's path), and the work done on its files. */
  source: RootSource;
  /**
   * An iPod's other library's tracks while this one is shown (W7: both share the root), so a song
   * playing from it keeps its name and can be shown again (`locatePlaying`).
   */
  shelved?: Track[];
  tracks: Track[];
  selectedTrackId: string | null;
  selectedTrackIds: string[];
  selectionAnchorTrackId: string | null;
  loadingMetadata: boolean;
  loadedCount: number;
  /** While loading, how many tracks the folder has (its walk's count): its tracks may not all be in the list yet. */
  total?: number;
  groupingMode: GroupingMode;
  metaSnapshot: MetaSnapshot;
  expandedAlbums: string[];
  expandedDiscs: string[];
  activeRowKey: string | null;
  /** How the library lists it (Files by default). */
  view: LibraryView;
  /** Its playlist files, as the walk found them. */
  playlists: Playlist[];
};

/** One track of the queue: which open root it is in, and its id there. */
export type QueueItem = {
  rootId: string;
  trackId: string;
};

/** What is playing: tracks of any open roots, in order, and where they came from. */
export type PlaybackQueue = {
  items: QueueItem[];
  sourceLabel: string;
};

/** A file as a source finds it: its size and date, both checksums, and its tags when they were read. */
export type Inspection = {
  size: number;
  lastModified: number | undefined;
  fullChecksum: string;
  audioChecksum: string;
  /** Null when the file still has the checksum the caller knew: its tags were not read again. */
  metadata: TrackMetadata | null;
  /** Its audio, when it can be told. */
  audio?: AudioProps | null;
};

/** What the player's <audio> element plays a track from. */
export type MediaHandle = {
  url: string;
  /** Whether the file was rewritten since it was opened (its size or date). */
  changed: () => Promise<boolean>;
  /** Gives the URL back; the media is no use after it. */
  release: () => void;
  /** In the desktop app, the file by its root and path, for the native player (E5). */
  native?: { root: string; path: string };
};

/** A file the bulk reads could not read, and why. */
export type Unread = { path: string; message: string };

/** Tags read in bulk: the files (covers by reference, or after them in `covered`), the covers met for the first time (base64), the files not read. */
export type TagsBatch = {
  done: boolean;
  tracks: { path: string; size: number; lastModified: number; metadata: TrackMetadata; audio?: AudioProps | null }[];
  /** The desktop scan's second pass: each file's cover by reference (its tags came without one). */
  covered?: { path: string; cover: string }[];
  /** Each cover's bytes come as base64 (`data`), or as they are (`bytes`, the web's iPod: no round trip through text). */
  covers: { name: string; data: string; bytes?: Uint8Array }[];
  unread: Unread[];
};

/** Checksums worked out in bulk, with each file's size and date then, and the files not read. */
export type SumsBatch = {
  done: boolean;
  sums: { path: string; size: number; lastModified: number; fullChecksum: string; audioChecksum: string }[];
  unread: Unread[];
};

/**
 * Where a root lives, and the work on its files, so that nothing above knows
 * whether it is the browser's folder (File System Access, the tag engine as
 * wasm) or the desktop app's (a path, the engine natively, no file bytes over
 * the IPC). See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E4-D1, E4-D2).
 */
/**
 * What an iPod says of itself and of its drive (W5, RECORD/2026-11-14.ipod-sync.WIP.md): from its
 * `SysInfo`, its copy of `SysInfoExtended` and Rockbox's `rockbox-info.txt`, its database's
 * checksum scheme, and its drive's size and free space (none in a browser, which cannot know them).
 */
export type IpodDeviceInfo = {
  modelNumber: string | null;
  familyId: string | null;
  firmware: string | null;
  serial: string | null;
  /** Rockbox's version when it is installed ("" when its file names none); null without Rockbox. */
  rockbox: string | null;
  checksum: number | null;
  total: number | null;
  free: number | null;
  /** The bytes of its covers (`iPod_Control/Artwork`), photos (`Photos`) and Rockbox (`.rockbox`): the desktop app's (W5b). */
  artworkBytes: number | null;
  photoBytes: number | null;
  rockboxBytes: number | null;
};

export type RootSource = {
  readonly kind: "browser" | "desktop" | "service" | "library";
  /** The small-file adapter: `.meta/`, playlists, renames, deletes. */
  readonly vfs: VFSAdapter;
  /** What the session keeps to reopen it: a directory handle, or a path (with its server's address, on a server other than the home one). */
  readonly saved: FileSystemDirectoryHandle | string;
  /** A folder the browser can only read (Safari, Firefox: lib/sources/picked.ts): it plays and its tags are read, nothing is written to it, and it is not reopened after a reload. */
  readonly readOnly?: boolean;
  /** The server it is on (E6b-D11); none for the browser's and the device's own folders. */
  readonly server?: ServiceClient;
  /** In a server's library, whose music it is when not one's own (SH-D6): their id. */
  readonly shelf?: number;
  /** Every file under it, with its size and date. */
  walk(): Promise<WalkedFile[]>;
  /**
   * Many files' tags at once, from their heads (no checksum), handed to `take` in batches; the
   * desktop app's (src-tauri/src/scan.rs). `knownCovers` are the covers' names the interface has,
   * not sent again. Where there is none, each file is inspected.
   */
  scanTags?(paths: string[], knownCovers: string[], take: (batch: TagsBatch) => void): Promise<void>;
  /** Many files' checksums at once, handed to `take` in batches; the desktop app's, as `scanTags`. */
  scanSums?(paths: string[], take: (batch: SumsBatch) => void): Promise<void>;
  /** One file's checksums, size and date; its tags too, unless its full checksum is still `known`. */
  inspect(path: string, known?: string): Promise<Inspection>;
  /** Writes `metadata` over the tags the library held (`previous`); the file as it is after. In the family library (F3), for everyone (`family`) or for oneself (`mine`), refused (`stale`, F4) when it changed since its full checksum was `expected`. */
  save(path: string, previous: TrackMetadata, metadata: TrackMetadata, scope?: "family" | "mine", expected?: string): Promise<Inspection>;
  /** Opens a track's file for playing, without reading it into memory. */
  openMedia(path: string): Promise<MediaHandle>;
  /** The root was closed: on the desktop, nothing under it can be reached any more. */
  close(): void;
  /** Which of its walked files are tracks; by extension (`isAudioFile`) when absent. An iPod's are all (its AAC songs too). */
  isTrack?(path: string): boolean;
  /**
   * An iPod's root (lib/sources/ipod.ts): its mount point, and each song's pid in its database. Its
   * files are not hashed. `web`: opened in a browser (lib/sources/ipod-web.ts), only read; its
   * `path` is its drive's name.
   */
  readonly ipod?: {
    path: string;
    pidOf(path: string): Promise<string | undefined>;
    web?: boolean;
    info(): Promise<IpodDeviceInfo>;
    /** Which of its libraries this root lists (W7): Apple's database, or the drive as Rockbox lists it. */
    library: "apple" | "rockbox";
    /** The same iPod's other library, as a source over the same drive (made once, then the same). */
    counterpart(): Promise<RootSource>;
    /** Drops what it read of the iPod, so it is read again the next time it is shown (its database changed). */
    forget?(): void;
  };
};
