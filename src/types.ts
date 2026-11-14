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
