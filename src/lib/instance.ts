// A phone's home instance: the address kept from E6's first dialog (before
// E6b, which replaced it with "Add to the library…", lib/adding.ts). The
// service is asked there from then on (./sources/service).
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E6).

import { $reactive } from "jq79";
import { useServiceAt } from "./sources/service";
import { STORAGE_KEYS, readStored, writeStored } from "./storage";

export const instance = $reactive({
  address: readStored(STORAGE_KEYS.instance) ?? ""
});

/**
 * Resolves with whether the phone has a home instance: one kept from before E6b (its first dialog). Otherwise the phone starts with an empty
 * library, and servers are added from "Add to the library…" (E6b-D11).
 */
export function phoneUsesInstance(): Promise<boolean> {
  if (!instance.address) return Promise.resolve(false);
  useServiceAt(instance.address);
  return Promise.resolve(true);
}

/** Forgets the home instance: the app starts again without it, and servers are added as sources. */
export function forgetInstance(): void {
  writeStored(STORAGE_KEYS.instance, "");
  location.reload();
}
