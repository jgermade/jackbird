// The server machine's load and temperatures, for its owners: asked every few seconds while
// Preferences, Server is open (`watchMachine(true)`), and not otherwise. The service's side is
// `GET /api/machine` (crates/service/src/machine.rs). See RECORD/2026-11-03.deck-design-system.WIP.md
// (2026-11-19 02:32, plan D).

import { $reactive } from "jq79";
import { isMachineReading, type MachineReading } from "../helpers/machine";
import { serviceJson } from "./sources/service";

/** How often it is asked while shown. */
const EVERY_MS = 3000;

export const machine = $reactive({
  reading: null as MachineReading | null
});

let timer: ReturnType<typeof setTimeout> | null = null;
let watching = false;

async function ask(): Promise<void> {
  const got = await serviceJson<unknown>("machine").catch(() => null);
  if (!watching) return;
  // An answer that is not one (an older service, a refusal) leaves the last reading, or none.
  if (isMachineReading(got)) machine.reading = got;
  timer = setTimeout(() => void ask(), EVERY_MS);
}

/** Starts asking (`true`), at once and then every few seconds, or stops (`false`). */
export function watchMachine(on: boolean): void {
  if (on === watching) return;
  watching = on;
  if (timer) clearTimeout(timer);
  timer = null;
  if (on) void ask();
}
