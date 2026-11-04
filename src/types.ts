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

export type Mp3Track = {
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
  tracks: Mp3Track[];
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
};

/** What is playing: tracks of one root, in order, and where they came from. */
export type PlaybackQueue = {
  rootId: string;
  trackIds: string[];
  sourceLabel: string;
};
