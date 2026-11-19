// What one's own music takes on the server spoken to now, and one's quota (owners and admins set
// it: uploads past it are refused); owners also see the disk's size and room. Shown at the foot of
// a server library's Folders (views/server-foot.html) and in Preferences, Server. The service's
// side is `GET /api/library/usage`. See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-19, B).

import { $reactive } from "jq79";
import { serviceJson } from "./sources/service";

type UsageAnswer = { songs: number; bytes: number; quota: number | null; disk: { total: number; free: number } | null };

export const usage = $reactive({
  loaded: false,
  songs: 0,
  bytes: 0,
  quota: null as number | null,
  disk: null as { total: number; free: number } | null
});

/** Asks the server what one's music takes. */
export async function loadUsage(): Promise<void> {
  const got = await serviceJson<UsageAnswer>("library/usage").catch(() => null);
  if (!got) return;
  usage.songs = got.songs;
  usage.bytes = got.bytes;
  usage.quota = got.quota;
  usage.disk = got.disk;
  usage.loaded = true;
}
