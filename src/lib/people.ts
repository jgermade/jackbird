// The people of an instance and how they get in (S3), for owners and admins:
// the people (added with a name and a role; with sign-in on, invited by
// email), the log of changes, SMTP, and for owners the instance's address,
// the home network, and turning sign-in on (by a code sent to their own
// address) and off. The service decides what each role may; this only asks.
// The view is views/people-dialog.html. See
// RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-09, 10:45 to 11:57).

import { $reactive } from "jq79";
import type { Role } from "../helpers/roles";
import type { Me } from "./account";
import { preferences } from "./preferences";
import { post, serviceJson, setServiceToken, usesToken } from "./sources/service";

export type PeopleTab = "people" | "signin" | "log" | "trash" | "backups";
export type TrashedSong = { id: number; path: string; by: string; at: number };
export type JobState = { running: boolean; done: number; total: number; at: number | null; result: unknown; error: string | null };
export type Backups = { folder: string; snapshots: string[]; scrub: JobState; export: JobState };
export type Change = { at: number; person: string; action: string; root: string; path: string };
export type SmtpShown = { host: string; port: number; security: string; username: string; from: string; password: boolean };
export type Settings = { signin: boolean; address: string; network: boolean; proxies: string[] };

export const people = $reactive({
  open: false,
  tab: "people" as PeopleTab,
  list: [] as Me[],
  log: [] as Change[],
  smtp: null as SmtpShown | null,
  settings: null as Settings | null,
  busy: false,
  error: "",
  notice: "",
  /** The library's trash (F4). */
  trash: [] as TrashedSong[],
  /** Its snapshots, scrub and export (F4). */
  backups: null as Backups | null,
  /** Turning sign-in on: the address the code went to, and the attempt. */
  setupEmail: "",
  setupAttempt: ""
});

async function busy<T>(work: () => Promise<T>, notice = ""): Promise<T | undefined> {
  people.busy = true;
  people.error = "";
  people.notice = "";
  try {
    const answer = await work();
    people.notice = notice;
    return answer;
  } catch (error) {
    people.error = error instanceof Error ? error.message : String(error);
    return undefined;
  } finally {
    people.busy = false;
  }
}

/** Opens the dialog, loading what an owner or admin sees. */
export async function openPeople(owner: boolean): Promise<void> {
  people.open = true;
  people.error = "";
  people.notice = "";
  await Promise.all([
    loadPeople(),
    serviceJson<SmtpShown | null>("smtp").then((smtp) => (people.smtp = smtp)).catch(() => undefined),
    owner ? serviceJson<Settings>("settings").then((settings) => (people.settings = settings)).catch(() => undefined) : undefined
  ]);
}

export async function loadPeople(): Promise<void> {
  const list = await serviceJson<Me[]>("people").catch(() => null);
  if (list) people.list = list;
}

export async function loadLog(): Promise<void> {
  const log = await serviceJson<Change[]>("log").catch(() => null);
  if (log) people.log = log;
}

type Saved = { person: Me; invited: boolean; token?: string };

/** Adds someone: a profile with sign-in off, an invitation by email with it on. */
export async function addPerson(name: string, email: string, role: Role, invitedNotice: string): Promise<boolean> {
  const saved = await busy(() => serviceJson<Saved>("people", post({ name, email: email || null, role, lang: preferences.language })));
  if (saved) {
    // The one person of an open instance gets a session with the second (the desktop app keeps its token).
    if (saved.token && usesToken()) setServiceToken(saved.token);
    people.notice = saved.invited ? invitedNotice : "";
    await loadPeople();
  }
  return Boolean(saved);
}

/** Changes someone's name, address or role. */
export async function updatePerson(id: number, change: { name?: string; email?: string; role?: Role }, invitedNotice: string): Promise<void> {
  const saved = await busy(() => serviceJson<Saved>("people/update", post({ id, ...change, lang: preferences.language })));
  if (saved?.invited) people.notice = invitedNotice;
  await loadPeople();
}

export async function removePerson(id: number): Promise<void> {
  await busy(() => serviceJson("people/remove", post({ id })));
  await loadPeople();
}

export type SmtpForm = { host: string; port: number; security: string; username: string; password: string; from: string };

/** Saves SMTP; an empty password keeps the one there is. */
export async function saveSmtp(form: SmtpForm, savedNotice: string): Promise<void> {
  const body: Record<string, unknown> = { ...form };
  if (!form.password) delete body.password;
  const smtp = await busy(() => serviceJson<SmtpShown>("smtp", post(body)), savedNotice);
  if (smtp) people.smtp = smtp;
}

export async function testSmtp(to: string, sentNotice: string): Promise<void> {
  await busy(() => serviceJson("smtp/test", post({ to })), sentNotice);
}

/** Saves the instance's address and whether the home network reaches it. */
export async function saveSettings(change: Partial<Settings>, savedNotice: string): Promise<void> {
  const settings = await busy(() => serviceJson<Settings>("settings", post(change)), savedNotice);
  if (settings) people.settings = settings;
}

/** Turning sign-in on, first step: a code to the owner's own address. */
export async function sendSetupCode(email: string): Promise<void> {
  const answer = await busy(() => serviceJson<{ attempt: string }>("setup/email", post({ email, lang: preferences.language })));
  if (answer) {
    people.setupEmail = email;
    people.setupAttempt = answer.attempt;
  }
}

/** Turning sign-in on, second step: the code typed back. Sessions end, so the page starts again. */
export async function confirmSetupCode(code: string): Promise<void> {
  const answer = await busy(() => serviceJson("setup/code", post({ attempt: people.setupAttempt, code, lang: preferences.language })));
  if (answer) location.reload();
}

export function cancelSetup(): void {
  people.setupAttempt = "";
  people.setupEmail = "";
}

/** Turns sign-in off: people are profiles again, and it answers on the machine only. */
export async function signinOff(): Promise<void> {
  const answer = await busy(() => serviceJson("signin", post({ on: false })));
  if (answer) location.reload();
}

// ─── The library's safety (F4) ───────────────────────────────────────────────

export async function loadTrash(): Promise<void> {
  const trash = await serviceJson<TrashedSong[]>("library/trash").catch(() => null);
  if (trash) people.trash = trash;
}

export async function restoreSong(id: number, restoredNotice: string): Promise<void> {
  await busy(() => serviceJson("library/trash/restore", post({ id })), restoredNotice);
  await loadTrash();
}

export async function emptyTrash(emptiedNotice: string): Promise<void> {
  await busy(() => serviceJson("library/trash/empty", post()), emptiedNotice);
  await loadTrash();
}

export async function loadBackups(): Promise<void> {
  const backups = await serviceJson<Backups>("library/backups").catch(() => null);
  if (backups) people.backups = backups;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Follows the scrub and the export while either runs. */
async function follow(): Promise<void> {
  do {
    await wait(500);
    await loadBackups();
  } while (people.open && (people.backups?.scrub.running || people.backups?.export.running));
}

export async function takeSnapshot(takenNotice: string): Promise<void> {
  const backups = await busy(() => serviceJson<Backups>("library/backups/snapshot", post()), takenNotice);
  if (backups) people.backups = backups;
}

export async function startScrub(): Promise<void> {
  await busy(() => serviceJson("library/backups/scrub", post()));
  await follow();
}

export async function exportLibrary(path: string): Promise<void> {
  await busy(() => serviceJson("library/export", post({ path })));
  await follow();
}
