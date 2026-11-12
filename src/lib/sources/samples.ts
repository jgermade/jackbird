// The demo's sample music: tracks served beside the app (`samples/`, with an `index.json`; on GitHub
// Pages and from the dev server, never in a release's build or the apps), copied into the page's
// origin-private file system and opened from there as a browser folder, so the app reads, plays and
// edits them as any folder of the person's. A track already there is kept, edits and all; one
// missing is fetched. See RECORD/2026-11-12.landing-page.WIP.md (2026-11-13 05:00).

import { FSAAdapter } from "@cloudauthn/vfs-sync";
import { parseSampleList, type SampleList } from "../../helpers/samples";
import type { RootSource } from "../../types";
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

/** The sample music as a folder: copied into the page's private storage, then opened. */
export async function openSampleSource(list: SampleList): Promise<RootSource> {
  const storage = await navigator.storage.getDirectory();
  const folder = await storage.getDirectoryHandle(list.label, { create: true });
  for (const name of list.files) {
    const there = await folder.getFileHandle(name).then(
      () => true,
      () => false
    );
    if (there) continue;
    const response = await fetch(BASE + encodeURIComponent(name));
    if (!response.ok || !response.body) throw new Error(`${name}: ${response.status}`);
    const file = await folder.getFileHandle(name, { create: true });
    await response.body.pipeTo(await file.createWritable());
  }
  return browserSource(FSAAdapter.fromHandle(folder, list.label));
}
