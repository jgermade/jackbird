/**
 * The album lookup of the rename tab (RECORD/2026-11-03.deck-design-system.WIP.md, 2026-11-25,
 * "the album lookup", L1): MusicBrainz's and Discogs' answers read into one `Release`, how well a
 * release fits the files, which file is which of its tracks, and per file the tags that would
 * change. No requests here: `lib/lookup.ts` makes them.
 */

import type { Track, TrackMetadata } from "../types.ts";

export type LookupSource = "musicbrainz" | "discogs";

/** One track of a release, where it is on it. */
export type ReleaseTrack = {
  disc: number;
  number: number;
  title: string;
  /** Its own artist (a guest's, a compilation's), else the release's. */
  artist: string;
  lengthMs: number | null;
  /** MusicBrainz's recording. */
  recordingId?: string;
};

/** A release as either source gives it: a search's summary (no `tracks`) or the whole of it. */
export type Release = {
  source: LookupSource;
  id: string;
  title: string;
  artist: string;
  /** "" when not known. */
  year: string;
  country: string;
  /** "CD", "2×Vinyl", … */
  format: string;
  /** How many tracks, when known (a Discogs search does not say). */
  trackCount: number | null;
  discCount: number;
  /** One genre, the one most said; "" when none. */
  genre: string;
  /** Empty in a search's summary. */
  tracks: ReleaseTrack[];
  /** MusicBrainz's release group and album artist. */
  releaseGroupId?: string;
  artistId?: string;
};

// What the answers hold, as far as they are read: anything may be missing.
type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const whole = (value: unknown): number | null => {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.trunc(number) : null;
};
const yearOf = (value: unknown): string => /^\d{4}/.exec(text(value))?.[0] ?? "";
const titled = (name: string): string => name.replace(/(^|[\s-])(\p{Ll})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());

/** "4:44" or "1:02:03" in milliseconds; null for anything else. */
export function parseDuration(value: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000;
}

/** MusicBrainz's artist credit as it is written: each name and what joins it to the next. */
function credit(value: unknown): string {
  return list(value)
    .map((one) => text(one.name) + (typeof one.joinphrase === "string" ? one.joinphrase : ""))
    .join("")
    .trim();
}

/** The genre most said, its words capitalised ("alternative rock" → "Alternative Rock"). */
function topGenre(...lists: unknown[]): string {
  for (const genres of lists) {
    const best = list(genres).sort((left, right) => (whole(right.count) ?? 0) - (whole(left.count) ?? 0))[0];
    if (best && text(best.name)) return titled(text(best.name));
  }
  return "";
}

/** The media's formats, "CD" or "2×CD" or "CD + DVD". */
function formatOf(media: Json[]): string {
  const counts = new Map<string, number>();
  for (const medium of media) {
    const name = text(medium.format) || "?";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => (count > 1 ? `${count}×${name}` : name)).join(" + ");
}

/** MusicBrainz's release search (`/ws/2/release/?query=…&fmt=json`): summaries, its own order. */
export function musicBrainzSearch(json: unknown): Release[] {
  return list(record(json).releases).map((release) => {
    const media = list(release.media);
    return {
      source: "musicbrainz",
      id: text(release.id),
      title: text(release.title),
      artist: credit(release["artist-credit"]),
      year: yearOf(release.date),
      country: text(release.country),
      format: formatOf(media),
      trackCount: whole(release["track-count"]),
      discCount: Math.max(1, media.length),
      genre: "",
      tracks: [],
      releaseGroupId: text(record(release["release-group"]).id) || undefined,
      artistId: text(record(list(release["artist-credit"])[0]?.artist).id) || undefined
    };
  });
}

/** A MusicBrainz release with its recordings (`inc=recordings+artist-credits+release-groups+genres`). */
export function musicBrainzRelease(json: unknown): Release {
  const release = record(json);
  const artist = credit(release["artist-credit"]);
  const media = list(release.media);
  const tracks = media.flatMap((medium, at) =>
    list(medium.tracks).map((track, index): ReleaseTrack => {
      const recording = record(track.recording);
      const length = whole(track.length) ?? whole(recording.length);
      return {
        disc: whole(medium.position) ?? at + 1,
        number: whole(track.position) ?? whole(track.number) ?? index + 1,
        title: text(track.title) || text(recording.title),
        artist: credit(track["artist-credit"]) || credit(recording["artist-credit"]) || artist,
        lengthMs: length,
        ...(text(recording.id) ? { recordingId: text(recording.id) } : {})
      };
    })
  );
  const group = record(release["release-group"]);
  return {
    source: "musicbrainz",
    id: text(release.id),
    title: text(release.title),
    artist,
    year: yearOf(release.date) || yearOf(group["first-release-date"]),
    country: text(release.country),
    format: formatOf(media),
    trackCount: tracks.length,
    discCount: Math.max(1, media.length),
    genre: topGenre(release.genres, group.genres),
    tracks,
    releaseGroupId: text(group.id) || undefined,
    artistId: text(record(list(release["artist-credit"])[0]?.artist).id) || undefined
  };
}

/** Discogs' name without the number that tells two artists of one name apart ("Nirvana (2)"). */
const discogsName = (name: string): string => name.replace(/\s+\(\d+\)$/, "").replace(/\*$/, "").trim();

/** Discogs' artists as written: each (its alias when credited so) and what joins it to the next. */
function discogsArtists(value: unknown): string {
  const artists = list(value);
  return artists
    .map((one, at) => {
      const name = discogsName(text(one.anv) || text(one.name));
      if (at === artists.length - 1) return name;
      const join = text(one.join);
      return !join || join === "," ? `${name}, ` : `${name} ${join} `;
    })
    .join("")
    .trim();
}

/**
 * A Discogs track's place: "7" (disc 1), "A1" (a side: disc 1, numbered through the sides), "2-3",
 * "CD2-3" or "2.3" (disc 2, track 3). Null for a heading or an index (no place of its own).
 */
export function parseDiscogsPosition(position: string): { disc: number; side?: string; number: number } | null {
  const value = position.trim();
  const disc = /^(?:CD|DVD|LP|Disc|Disk)?\s*(\d+)\s*[-.]\s*(\d+)$/i.exec(value);
  if (disc) return { disc: Number(disc[1]), number: Number(disc[2]) };
  const plain = /^(\d+)$/.exec(value);
  if (plain) return { disc: 1, number: Number(plain[1]) };
  const side = /^([A-Z])(\d*)$/i.exec(value);
  if (side) return { disc: 1, side: side[1].toUpperCase(), number: Number(side[2] || 1) };
  return null;
}

/** Discogs' search (`/database/search?type=release&…`): summaries, its own order. */
export function discogsSearch(json: unknown): Release[] {
  return list(record(json).results)
    .filter((result) => text(result.type) === "release" || !result.type)
    .map((result) => {
      // Its title is "Artist - Title".
      const full = text(result.title);
      const cut = full.indexOf(" - ");
      const formats = Array.isArray(result.format) ? result.format.map(text) : [];
      return {
        source: "discogs",
        id: text(result.id),
        title: cut === -1 ? full : full.slice(cut + 3),
        artist: cut === -1 ? "" : discogsName(full.slice(0, cut)),
        year: yearOf(result.year),
        country: text(result.country),
        format: formats.slice(0, 2).join(", "),
        trackCount: null,
        discCount: Math.max(1, whole(result.format_quantity) ?? 1),
        genre: text((Array.isArray(result.style) ? result.style : [])[0]) || text((Array.isArray(result.genre) ? result.genre : [])[0]),
        tracks: []
      };
    });
}

/** A Discogs release (`/releases/{id}`). A side-numbered one (A1, B1…) is numbered through its sides. */
export function discogsRelease(json: unknown): Release {
  const release = record(json);
  const artist = discogsArtists(release.artists);
  const tracks: ReleaseTrack[] = [];
  const counted = new Map<number, number>();
  for (const track of list(release.tracklist)) {
    if (text(track.type_) && text(track.type_) !== "track") continue;
    const place = parseDiscogsPosition(text(track.position));
    if (!place) continue;
    const number = place.side ? (counted.get(place.disc) ?? 0) + 1 : place.number;
    counted.set(place.disc, number);
    tracks.push({
      disc: place.disc,
      number,
      title: text(track.title),
      artist: discogsArtists(track.artists) || artist,
      lengthMs: parseDuration(text(track.duration))
    });
  }
  const formats = list(release.formats);
  const discs = Math.max(1, ...tracks.map((track) => track.disc));
  return {
    source: "discogs",
    id: text(release.id),
    title: text(release.title),
    artist,
    year: yearOf(release.released) || yearOf(release.year),
    country: text(release.country),
    format: formats.map((format) => ((whole(format.qty) ?? 1) > 1 ? `${whole(format.qty)}×${text(format.name)}` : text(format.name))).join(" + "),
    trackCount: tracks.length,
    discCount: discs,
    genre: text((Array.isArray(release.styles) ? release.styles : [])[0]) || text((Array.isArray(release.genres) ? release.genres : [])[0]),
    tracks
  };
}

/** What the lookup needs of a file. */
export type LookupFile = Pick<Track, "id" | "name" | "relativePath" | "metadata" | "audio">;

/** How close two lengths must be to be one track's. */
export const LENGTH_SLACK_MS = 3000;

const numberOf = (value: string): number | null => {
  const match = /^\s*(\d+)/.exec(value);
  return match ? Number(match[1]) : null;
};
const fold = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const lengthOf = (file: LookupFile): number | null => file.audio?.durationMs ?? null;
const near = (left: number | null, right: number | null): boolean => left !== null && right !== null && Math.abs(left - right) <= LENGTH_SLACK_MS;

/** One file and the release's track it is, if any; `by`, what told them. */
export type TrackPair = { file: LookupFile; track: ReleaseTrack | null; by: "number" | "title" | "length" | "order" | null };

/**
 * Which file is which track: by the files' track and disc numbers where they all have one and
 * the release has it; the rest by title (the same once folded), else by a length within 3 s,
 * else, with as many files as tracks and nothing paired yet, by the files' order. In the files'
 * order.
 */
export function pairTracks(files: readonly LookupFile[], release: Pick<Release, "tracks">): TrackPair[] {
  const free = new Set(release.tracks);
  const pairs = new Map<LookupFile, TrackPair>();
  const take = (file: LookupFile, track: ReleaseTrack, by: TrackPair["by"]) => {
    free.delete(track);
    pairs.set(file, { file, track, by });
  };
  const places = files.map((file) => ({ file, disc: numberOf(file.metadata.discNumber) ?? 1, number: numberOf(file.metadata.trackNumber) }));
  const unique = new Set(places.map((place) => `${place.disc}/${place.number}`)).size === places.length;
  if (unique && places.every((place) => place.number !== null)) {
    for (const place of places) {
      const track = [...free].find((one) => one.disc === place.disc && one.number === place.number);
      if (track) take(place.file, track, "number");
    }
  }
  for (const file of files) {
    if (pairs.has(file)) continue;
    const title = fold(file.metadata.title || file.name.replace(/\.[^.]+$/, "").replace(/^\s*\d+\s*[-.]?\s*/, ""));
    const byTitle = title ? [...free].filter((track) => fold(track.title) === title) : [];
    const track = byTitle.find((one) => near(one.lengthMs, lengthOf(file))) ?? byTitle[0];
    if (track) take(file, track, "title");
  }
  for (const file of files) {
    if (pairs.has(file)) continue;
    const close = [...free].filter((track) => near(track.lengthMs, lengthOf(file)));
    if (close.length === 1) take(file, close[0], "length");
  }
  if (pairs.size === 0 && files.length === release.tracks.length) {
    const ordered = [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    ordered.forEach((file, at) => take(file, release.tracks[at], "order"));
  }
  return files.map((file) => pairs.get(file) ?? { file, track: null, by: null });
}

/**
 * How well a release fits the files, 0 to 1: as many tracks as files (a summary is judged by
 * that alone), and with its tracks, how many of the files are paired with one of a length within
 * 3 s (where the lengths are known).
 */
export function scoreRelease(files: readonly LookupFile[], release: Release): number {
  const count = release.trackCount ?? (release.tracks.length || null);
  const countScore = count === null || files.length === 0 ? 0.5 : Math.max(0, 1 - Math.abs(count - files.length) / Math.max(count, files.length));
  if (release.tracks.length === 0) return round(countScore);
  const pairs = pairTracks(files, release).filter((pair) => pair.track && lengthOf(pair.file) !== null && pair.track.lengthMs !== null);
  if (pairs.length === 0) return round(countScore);
  const lengthScore = pairs.filter((pair) => near(pair.track!.lengthMs, lengthOf(pair.file))).length / files.length;
  return round(0.4 * countScore + 0.6 * lengthScore);
}
const round = (value: number): number => Math.round(value * 1000) / 1000;

/** The tags a release gives, and only those: each file keeps the rest. */
export type LookupField = "title" | "artist" | "album" | "albumArtist" | "trackNumber" | "discNumber" | "year" | "genre";
export type LookupChange = { field: LookupField; from: string; to: string };
export type LookupPlan = { trackId: string; track: ReleaseTrack | null; changes: LookupChange[] };

/**
 * Per file, what its tags would become with the release: title, artist, album, album artist,
 * track (`n/total` of its disc), disc (`n/total`, only for a release of several discs), year and
 * genre; only where the release says something and it differs from the file's. A file not paired
 * changes nothing.
 */
export function lookupPlan(pairs: readonly TrackPair[], release: Release): LookupPlan[] {
  const onDisc = new Map<number, number>();
  for (const track of release.tracks) onDisc.set(track.disc, (onDisc.get(track.disc) ?? 0) + 1);
  return pairs.map(({ file, track }) => {
    if (!track) return { trackId: file.id, track: null, changes: [] };
    const wanted: Record<LookupField, string> = {
      title: track.title,
      artist: track.artist,
      album: release.title,
      albumArtist: release.artist,
      trackNumber: `${track.number}/${onDisc.get(track.disc) ?? track.number}`,
      discNumber: release.discCount > 1 ? `${track.disc}/${release.discCount}` : "",
      year: release.year,
      genre: release.genre
    };
    const changes = (Object.keys(wanted) as LookupField[]).flatMap((field): LookupChange[] => {
      const to = wanted[field].trim();
      const from = (file.metadata[field as keyof TrackMetadata] as string).trim();
      return to && to !== from ? [{ field, from, to }] : [];
    });
    return { trackId: file.id, track, changes };
  });
}

/** MusicBrainz's web service, its JSON. */
export const MUSICBRAINZ = "https://musicbrainz.org/ws/2";

/** A value as a phrase of a Lucene query: in quotes, its quotes and backslashes escaped. */
const phrase = (value: string): string => `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`;

/** The address of MusicBrainz's release search for an album (and its artist, if known). */
export function musicBrainzSearchUrl(album: string, artist: string, limit = 10): string {
  const query = [album.trim() && `release:${phrase(album.trim())}`, artist.trim() && `artist:${phrase(artist.trim())}`].filter(Boolean).join(" AND ");
  return `${MUSICBRAINZ}/release/?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`;
}

/** The address of a MusicBrainz release with what `musicBrainzRelease` reads. */
export function musicBrainzReleaseUrl(id: string): string {
  return `${MUSICBRAINZ}/release/${encodeURIComponent(id)}?inc=recordings+artist-credits+release-groups+genres&fmt=json`;
}

/**
 * What to look up for the files: the album and artist they share (the album artist before each
 * track's), else, with no album tag, the name of the folder that holds them all.
 */
export function lookupTerms(files: readonly Pick<Track, "relativePath" | "metadata">[]): { album: string; artist: string } {
  const shared = (read: (file: (typeof files)[number]) => string): string => {
    const values = new Set(files.map((file) => read(file).trim()).filter(Boolean));
    return values.size === 1 ? [...values][0] : "";
  };
  const folders = new Set(files.map((file) => file.relativePath.split("/").slice(0, -1).pop() ?? ""));
  const folder = folders.size === 1 ? [...folders][0] : "";
  return {
    album: shared((file) => file.metadata.album) || folder,
    artist: shared((file) => file.metadata.albumArtist) || shared((file) => file.metadata.artist)
  };
}

/** A file's tags with the plan's changes of the fields ticked. */
export function withChanges(metadata: TrackMetadata, changes: readonly LookupChange[], fields: readonly LookupField[]): TrackMetadata {
  const next = { ...metadata };
  for (const change of changes) if (fields.includes(change.field)) next[change.field] = change.to;
  return next;
}

/** The fields some file of the plan would change, in the plan's order. */
export function changedFields(plans: readonly LookupPlan[]): LookupField[] {
  const order: LookupField[] = ["title", "artist", "album", "albumArtist", "trackNumber", "discNumber", "year", "genre"];
  const changed = new Set(plans.flatMap((plan) => plan.changes.map((change) => change.field)));
  return order.filter((field) => changed.has(field));
}

/** Discogs' API. */
export const DISCOGS = "https://api.discogs.com";

/** The address of Discogs' release search for an album (and its artist, if known). */
export function discogsSearchUrl(album: string, artist: string, limit = 10): string {
  const query = new URLSearchParams({ type: "release" });
  if (album.trim()) query.set("release_title", album.trim());
  if (artist.trim()) query.set("artist", artist.trim());
  query.set("per_page", String(limit));
  return `${DISCOGS}/database/search?${query}`;
}

/** The address of a Discogs release. */
export function discogsReleaseUrl(id: string): string {
  return `${DISCOGS}/releases/${encodeURIComponent(id)}`;
}

/** Discogs' header for a personal token; none without one. */
export function discogsHeaders(token: string): Record<string, string> {
  return token.trim() ? { Authorization: `Discogs token=${token.trim()}` } : {};
}

/** How long to wait between two requests to a source: MusicBrainz one a second; Discogs 25 a minute, 60 with a token. */
export function paceOf(source: LookupSource, token = ""): number {
  if (source === "musicbrainz") return 1100;
  return token.trim() ? 1050 : 2450;
}

/**
 * The candidates of several sources in one list: the best fit first, each source's own order among
 * equals, the sources taking turns where their fits are equal.
 */
export function mergeCandidates<T extends { fit: number }>(lists: readonly (readonly T[])[]): T[] {
  return lists
    .flatMap((list) => list.map((item, at) => ({ item, at })))
    .sort((left, right) => right.item.fit - left.item.fit || left.at - right.at)
    .map(({ item }) => item);
}

/** The Cover Art Archive's front picture of a MusicBrainz release (250, 500 or 1200 pixels wide). */
export function coverArtUrl(releaseId: string, size: 250 | 500 | 1200 = 1200): string {
  return `https://coverartarchive.org/release/${encodeURIComponent(releaseId)}/front-${size}`;
}

/** Whether a release's cover is offered ticked: only when none of the files has one. */
export function coverWanted(files: readonly Pick<Track, "metadata">[]): boolean {
  return files.every((file) => !file.metadata.coverDataUrl);
}

/** The side a picture is scaled to, at most `max` on its longer side, never larger than it is. */
export function scaledSize(width: number, height: number, max: number): { width: number; height: number } {
  const ratio = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}
