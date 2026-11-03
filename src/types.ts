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
