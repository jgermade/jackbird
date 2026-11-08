import type { Track, TrackMetadata } from "../types.ts";

/** A track for tests: every field defaulted, any of them overridable. */
export function track(relativePath: string, metadata: Partial<TrackMetadata> = {}, id = relativePath): Track {
  return {
    id,
    name: relativePath.split("/").pop() ?? relativePath,
    relativePath,
    size: 1000,
    checksum: "",
    metadata: {
      title: "",
      artist: "",
      album: "",
      year: "",
      genre: "",
      trackNumber: "",
      coverDataUrl: null,
      ...metadata
    }
  };
}
