import type { VFSAdapter } from "@cloudauthn/vfs-sync";

export type TrackMetadata = {
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  trackNumber: string;
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
  trackId?: string;
  trackNumber?: string;
  artist?: string;
  relativePath?: string;
  /** Small text at the row's end; else a track's artist. */
  meta?: string;
  /** A view's group: its tracks' ids, in the order they play. */
  trackIds?: string[];
  /** The view a row belongs to, when it is not Files. */
  inView?: LibraryView;
  /** A playlist's path (its group and entries), and an entry's place in it. */
  playlist?: string;
  playlistIndex?: number;
  /** A playlist entry that is not in the library. */
  missing?: boolean;
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
export type MetaRecord = {
  checksum: string;
  fullChecksum?: string;
  audioChecksum?: string;
  size?: number;
  lastModified?: number;
  lastVerifiedAt?: string;
  metadata: TrackMetadata;
  updatedAt: string;
};

/** The whole `.meta/mp3-manager.json` file. */
export type MetaSnapshot = {
  version: 1;
  tracks: Record<string, MetaRecord>;
};

export type Theme = "light" | "dark";

/** The interface languages; English is the source and the fallback. */
export type Language = "en" | "es";

export type GroupingMode = "flat" | "wizard";

/** One open folder ("root") and everything the library shows of it. */
export type RootWorkspace = {
  id: string;
  label: string;
  /** The storage seam. Nothing above this line knows which backend is behind it. */
  vfs: VFSAdapter;
  /** Kept here rather than on the adapter: it is what the session store persists. */
  rootHandle: FileSystemDirectoryHandle;
  tracks: Track[];
  selectedTrackId: string | null;
  selectedTrackIds: string[];
  selectionAnchorTrackId: string | null;
  loadingMetadata: boolean;
  loadedCount: number;
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
