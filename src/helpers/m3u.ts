/**
 * Playlists as M3U / M3U8 files: what one says (its entries, their paths
 * resolved against the playlist's own folder, inside the root), and the text
 * of one jackbird writes, which other players read too. See
 * RECORD/2026-11-04.github-actions-workflows.WIP.md (22:00, 22:12 and W8's
 * plan).
 */

import type { PlaylistEntry } from "../types.ts";

/** The folder a path is in ("" at the root). */
export function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/** A playlist's name: its file name without the extension. */
export function playlistName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * A path in the root from one written relative to `folder` (backslashes read
 * as slashes, `.` and `..` resolved); null for an absolute path, a URL, or
 * one leaving the root.
 */
export function resolvePath(folder: string, written: string): string | null {
  const path = written.trim().replace(/\\/g, "/");
  if (!path || path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return null;
  }
  const parts = folder ? folder.split("/") : [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length > 0 ? parts.join("/") : null;
}

/**
 * The file of the root a path written outside it stands for: an absolute
 * path (`/home/me/Music/Jazz/x.mp3`, `C:\Music\Jazz\x.mp3`, `\\nas\Music\x.mp3`),
 * a `file:` URL (its escapes read), or a relative one that leaves the root,
 * as other players write them (VLC writes absolute paths). The browser does
 * not know where the root is on disk, so the longest tail of the path that
 * is one of `files` wins ("Jazz/x.mp3" for a root opened at "Music"), the
 * same case before another. Null for a URL of another kind, or no match.
 */
export function matchPath(written: string, files: FileIndex): string | null {
  let path = written.trim();
  if (/^file:/i.test(path)) {
    try {
      path = decodeURIComponent(path.replace(/^file:(\/\/[^/]*)?/i, ""));
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) {
    return null;
  }
  const parts = path
    .replace(/\\/g, "/")
    .replace(/^\/?[a-z]:\//i, "/")
    .split("/")
    .filter((part) => part !== "" && part !== "." && part !== "..");
  const name = parts.at(-1)?.toLowerCase();
  let best: { path: string; score: number } | null = null;
  for (const candidate of (name && files.get(name)) || []) {
    const tail = candidate.split("/");
    if (tail.length > parts.length) continue;
    const end = parts.slice(-tail.length);
    if (!end.every((part, at) => part.toLowerCase() === tail[at].toLowerCase())) continue;
    const score = tail.length * 2 + (end.join("/") === candidate ? 1 : 0);
    if (!best || score > best.score) best = { path: candidate, score };
  }
  return best?.path ?? null;
}

/** The root's files by name (without case), for matchPath. */
export type FileIndex = ReadonlyMap<string, readonly string[]>;

/** Indexes the root's files by name (without case). */
export function indexFiles(files: readonly string[]): FileIndex {
  const index = new Map<string, string[]>();
  for (const file of files) {
    const name = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
    index.set(name, [...(index.get(name) ?? []), file]);
  }
  return index;
}

/** `path` (in the root) as a playlist in `folder` writes it: relative, with forward slashes. */
export function relativePath(folder: string, path: string): string {
  const from = folder ? folder.split("/") : [];
  const to = path.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;
  return [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/");
}

/**
 * The entries of a playlist file's text, at `playlistPath` in the root: a
 * byte order mark, `#EXTM3U` and the other directives are skipped, but an
 * `#EXTINF:seconds,title` gives the next entry its title and length. With
 * `files` (the root's), a path that is not one of them is read again as a
 * URL (its escapes), and one written outside the root (absolute, a `file:`
 * URL, leaving it) is looked for among them (see matchPath).
 */
export function parseM3u(text: string, playlistPath: string, files: readonly string[] = []): PlaylistEntry[] {
  const folder = folderOf(playlistPath);
  const index = indexFiles(files);
  const known = new Set(files);
  // Where a line points in the root: as written; else, when that is not one
  // of the root's files, its escapes read (VLC writes relative URLs:
  // "Jazz/So%20What.mp3"); else by its tail (matchPath).
  const locate = (written: string): string | null => {
    const direct = resolvePath(folder, written);
    if (direct && (known.size === 0 || known.has(direct))) return direct;
    if (direct && /%[0-9a-f]{2}/i.test(direct)) {
      try {
        const decoded = decodeURIComponent(direct);
        if (known.has(decoded)) return decoded;
      } catch {
        // Not an escape after all: as written.
      }
    }
    return matchPath(written, index) ?? direct;
  };
  const entries: PlaylistEntry[] = [];
  let info: { title?: string; duration?: number } = {};
  for (const line of text.replace(/^﻿/, "").split(/\r?\n|\r/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      const extinf = trimmed.match(/^#EXTINF:\s*(-?\d+(?:\.\d+)?)[^,]*,(.*)$/i);
      if (extinf) {
        const duration = Number(extinf[1]);
        info = { title: extinf[2].trim() || undefined, duration: duration >= 0 ? duration : undefined };
      }
      continue;
    }
    entries.push({ path: locate(trimmed), raw: trimmed, ...info });
    info = {};
  }
  return entries;
}

/**
 * The text of a playlist at `playlistPath` holding `entries`: `#EXTM3U`, then
 * for each an `#EXTINF` with its length (-1 unknown) and title, and its path
 * relative to the playlist's folder; an entry that never resolved keeps the
 * line it had. UTF-8, as `.m3u8` is.
 */
export function serializeM3u(entries: readonly PlaylistEntry[], playlistPath: string): string {
  const folder = folderOf(playlistPath);
  const lines = ["#EXTM3U"];
  for (const entry of entries) {
    if (entry.title !== undefined || entry.duration !== undefined) {
      lines.push(`#EXTINF:${Math.round(entry.duration ?? -1)},${entry.title ?? ""}`);
    }
    lines.push(entry.path ? relativePath(folder, entry.path) : entry.raw);
  }
  return `${lines.join("\n")}\n`;
}
