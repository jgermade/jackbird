// Whom one shares one's own music with, on the server in front (SH-D3, RECORD/2026-08-11.
// musikmatch-rust-migration.WIP.md, 2026-11-13 03:33): everyone (newcomers included), or the people
// one picks. Each change is saved at once. The view is the "Share my music" part of
// views/preferences-dialog.html.

import { $reactive } from "jq79";
import { myShares, setMyShares } from "./sources/service";

export const sharing = $reactive({
  loaded: false,
  everyone: false,
  /** The people chosen, when not everyone. */
  people: [] as number[],
  /** Everyone else on the server, to choose from. */
  candidates: [] as { id: number; name: string }[],
  busy: false,
  error: ""
});

/** Reads whom one's music is shared with. */
export async function loadSharing(): Promise<void> {
  try {
    const shares = await myShares();
    sharing.everyone = shares.everyone;
    sharing.people = shares.people;
    sharing.candidates = shares.candidates;
    sharing.loaded = true;
    sharing.error = "";
  } catch {
    sharing.loaded = false;
  }
}

async function save(everyone: boolean, people: number[]): Promise<void> {
  const before = { everyone: sharing.everyone, people: sharing.people };
  sharing.everyone = everyone;
  sharing.people = people;
  sharing.busy = true;
  try {
    await setMyShares(everyone, people);
    sharing.error = "";
  } catch (error) {
    sharing.everyone = before.everyone;
    sharing.people = before.people;
    sharing.error = error instanceof Error ? error.message : String(error);
  } finally {
    sharing.busy = false;
  }
}

/** Shares with everyone, or (off) with the people chosen. */
export function shareWithEveryone(on: boolean): Promise<void> {
  return save(on, sharing.people);
}

/** Shares with one person more, or one less. */
export function shareWith(person: number, on: boolean): Promise<void> {
  const rest = sharing.people.filter((one) => one !== person);
  return save(false, on ? [...rest, person] : rest);
}
