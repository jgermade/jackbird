// A phone's family instance (E6's spike): the address the person types the
// first time, kept between visits, where the service is asked from then on
// (./sources/service). The way in after it is the instance's own (S3: a
// code by email, or a profile on an open instance). A debug build made for
// the unattended check (mobile.yml) carries its address instead.
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E6).

import { $reactive } from "jq79";
import { normaliseAddress } from "../helpers/instance";
import { t } from "./i18n";
import { phoneCheck } from "./phone-check";
import { useServiceAt } from "./sources/service";
import { STORAGE_KEYS, readStored, writeStored } from "./storage";

export const instance = $reactive({
  /** Whether the app waits for an address. */
  needed: false,
  busy: false,
  error: "",
  address: phoneCheck()?.address ?? readStored(STORAGE_KEYS.instance) ?? ""
});

let connected: ((value: boolean) => void) | null = null;

/** Resolves once the phone knows its instance; the service is asked there from then on. */
export function phoneUsesInstance(): Promise<boolean> {
  if (instance.address) {
    useServiceAt(instance.address);
    return Promise.resolve(true);
  }
  instance.needed = true;
  return new Promise((resolve) => {
    connected = resolve;
  });
}

/** Tries an address: it must answer as jackbird's service. */
export async function connectInstance(typed: string): Promise<void> {
  const address = normaliseAddress(typed);
  if (!address) {
    instance.error = t("instance.notAddress");
    return;
  }
  instance.busy = true;
  instance.error = "";
  try {
    const info = await fetch(`${address}/api/info`).then((response) => (response.ok ? response.json() : null));
    if ((info as { name?: string } | null)?.name !== "jackbird-service") {
      instance.error = t("instance.notJackbird", { address });
      return;
    }
    writeStored(STORAGE_KEYS.instance, address);
    instance.address = address;
    instance.needed = false;
    useServiceAt(address);
    connected?.(true);
    connected = null;
  } catch {
    instance.error = t("instance.unreachable", { address });
  } finally {
    instance.busy = false;
  }
}

/** Forgets the instance: the app asks for one again. */
export function forgetInstance(): void {
  writeStored(STORAGE_KEYS.instance, "");
  location.reload();
}
