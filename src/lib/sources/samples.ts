// The demo's sample music: tracks served beside the app (`samples/`, with an `index.json`; on GitHub
// Pages and from the dev server, never in a release's build or the apps), copied into the page's
// origin-private file system and opened from there as a browser folder, so the app reads, plays and
// edits them as any folder of the person's. A track already there is kept, edits and all; one
// missing is fetched. See RECORD/2026-11-12.landing-page.WIP.md (2026-11-13 05:00).
//
// The folder opens at once, with every track the index names: the downloads run in the background,
// one after another. Until a track is in, its row waits for its tags (`inspect()` waits for its download),
// and playing it streams it from the server (`openMedia()` gives the served URL, which the <audio>
// element reads as it plays); once in, it is played from the copy. See
// RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-13 14:10).

import { FSAAdapter, type WalkedFile } from "@cloudauthn/vfs-sync";
import { parseSampleList, type SampleList } from "../../helpers/samples";
import type { MediaHandle, RootSource } from "../../types";
import { browserSource } from "./browser";

const BASE = "samples/";

/** The sample music served beside the app, or null where there is none. */
export async function sampleList(): Promise<SampleList | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
  try {
    const response = await fetch(`${BASE}index.json`, { cache: "no-cache" });
    if (!response.ok || !/json/.test(response.headers.get("content-type") ?? "")) return null;
    return parseSampleList(await response.json());
  } catch {
    return null;
  }
}

const servedUrl = (name: string): string => new URL(BASE + encodeURIComponent(name), document.baseURI).href;

/** Copies one track into the folder, unless it is there already (a file left empty by an interrupted copy is not). */
async function fetchInto(folder: FileSystemDirectoryHandle, name: string): Promise<void> {
  const there = await folder
    .getFileHandle(name)
    .then((handle) => handle.getFile())
    .then(
      (file) => file.size > 0,
      () => false
    );
  if (there) return;
  const response = await fetch(servedUrl(name));
  if (!response.ok || !response.body) throw new Error(`${name}: ${response.status}`);
  const file = await folder.getFileHandle(name, { create: true });
  // A writable stream commits on close: the file holds the whole track, or what it held before.
  await response.body.pipeTo(await file.createWritable());
}

/** The sample music as a folder: opened at once, its tracks copied into the page's private storage meanwhile. */
export async function openSampleSource(list: SampleList): Promise<RootSource> {
  const storage = await navigator.storage.getDirectory();
  const folder = await storage.getDirectoryHandle(list.label, { create: true });
  const inner = browserSource(FSAAdapter.fromHandle(folder, list.label));
  const names = new Set(list.files);
  const ready = new Set<string>();
  // One download after another, so a track played meanwhile streams beside one download, not all
  // of them; each track's promise settles when it is in.
  let queue: Promise<unknown> = Promise.resolve();
  const downloads = new Map(
    list.files.map((name) => {
      const done = queue.then(() => fetchInto(folder, name)).then(() => {
        ready.add(name);
      });
      queue = done.catch(() => undefined);
      done.catch((error: unknown) => console.error(`jackbird: could not fetch the sample ${name}`, error));
      return [name, done] as const;
    })
  );
  const arrived = (path: string): Promise<void> => downloads.get(path) ?? Promise.resolve();

  return {
    ...inner,
    // The folder's files, and the tracks still on their way as empty ones (their tags wait for them).
    async walk(): Promise<WalkedFile[]> {
      const found = await inner.walk();
      const rest = found.filter((entry) => !names.has(entry.path));
      const tracks = list.files.map(
        (name) => (ready.has(name) && found.find((entry) => entry.path === name)) || { path: name, stat: { kind: "file" as const, size: 0, mtime: 0 } }
      );
      return [...rest, ...tracks];
    },
    async inspect(path, known) {
      await arrived(path);
      return inner.inspect(path, known);
    },
    async save(path, previous, metadata, scope, expected) {
      await arrived(path);
      return inner.save(path, previous, metadata, scope, expected);
    },
    // A track still on its way streams from the server; one in plays from its copy.
    async openMedia(path): Promise<MediaHandle> {
      if (ready.has(path) || !names.has(path)) return inner.openMedia(path);
      return { url: servedUrl(path), changed: async () => false, release: () => undefined };
    }
  };
}
