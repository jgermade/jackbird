// Who is using the service (S3): the state it starts from (sign-in on or
// off, the profiles to pick, the person in), signing in by a code sent by
// email or with a passkey, picking a profile on an open instance with
// several people, and one's own account (name, sessions, passkeys). With no
// service behind the page (the browser's own folders, the desktop app's own
// backend) there are no people and everything is allowed. The views are
// views/signin-dialog.html and the preferences' "Account". See
// RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-09, 10:45 to 11:57).

import { $reactive } from "jq79";
import { creationOptions, credentialJson, passkeyProblem, requestOptions, type BrowserCredential } from "../helpers/passkeys";
import { atLeast, type Role } from "../helpers/roles";
import { t } from "./i18n";
import { isDesktop, isService } from "./platform";
import { preferences } from "./preferences";
import { onUnauthorized, post, serviceJson, setServiceToken, usesToken } from "./sources/service";

export type Me = { id: number; name: string; email: string | null; confirmed: boolean; role: Role; enabled: boolean };
export type Profile = { id: number; name: string; role: Role };
export type SessionInfo = { id: number; agent: string; created: number; seen: number };
export type PasskeyInfo = { id: number; name: string; created: number; used: number | null };

type State = { signin: boolean; me: Me | null; profiles: Profile[] | null; smtp: boolean; address: string };

export const account = $reactive({
  /** Whether the page works through the service, which has people. */
  active: false,
  signin: false,
  me: null as Me | null,
  profiles: null as Profile[] | null,
  smtp: false,
  address: "",
  /** Whether the sign-in dialog (or the profiles) is shown. */
  needed: false,
  step: "email" as "email" | "code",
  email: "",
  attempt: "",
  busy: false,
  error: "",
  sessions: [] as SessionInfo[],
  passkeys: [] as PasskeyInfo[],
  /** Keys for other apps (OpenSubsonic, E6's spike), and the one just made, shown once. */
  keys: [] as AppKey[],
  newKey: ""
});

/** A key another app signs in with. */
export type AppKey = { id: number; name: string; created: number; used: number | null };

/** Whether the person may do what `role` may: always, with no service behind the page. */
export function can(role: Role): boolean {
  return !account.active || atLeast(account.me?.role, role);
}

/** Whether this browser can use passkeys here: they need a secure context (HTTPS, or localhost). */
export function passkeysHere(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && "PublicKeyCredential" in window && !isDesktop;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

let signedIn: (() => void) | null = null;

function apply(state: State): void {
  account.signin = state.signin;
  account.me = state.me;
  account.profiles = state.profiles;
  account.smtp = state.smtp;
  account.address = state.address;
}

async function loadState(): Promise<void> {
  apply(await serviceJson<State>("auth/state"));
}

function welcome(me: Me, token?: string | null): void {
  if (token) setServiceToken(token);
  account.me = me;
  account.needed = false;
  account.step = "email";
  account.attempt = "";
  account.error = "";
  signedIn?.();
  signedIn = null;
}

/**
 * Finds out who is using the service, and resolves once someone is: at
 * once with no service, or with one person and sign-in off; after signing
 * in or picking a profile otherwise.
 */
export async function startAccount(): Promise<void> {
  const served = isDesktop ? await (await import("./desktop-service")).desktopUsesService() : await isService();
  if (!served) return;
  account.active = true;
  onUnauthorized(() => {
    if (account.me) {
      // The session ended (signed out elsewhere, sign-in turned on or off): start again.
      location.reload();
      return;
    }
    account.needed = true;
  });
  await loadState().catch((error) => {
    account.error = message(error);
  });
  if (account.me) return;
  account.needed = true;
  await new Promise<void>((resolve) => {
    signedIn = resolve;
  });
}

async function busy<T>(work: () => Promise<T>): Promise<T | undefined> {
  account.busy = true;
  account.error = "";
  try {
    return await work();
  } catch (error) {
    account.error = message(error);
    return undefined;
  } finally {
    account.busy = false;
  }
}

type SignedIn = { me: Me; token?: string | null };

/** Picks who is listening, on an open instance with several people. */
export async function pickProfile(id: number): Promise<void> {
  const answer = await busy(() => serviceJson<SignedIn>("auth/profile", post({ id, token: usesToken() })));
  if (answer) welcome(answer.me, answer.token);
}

/** Asks for a code at an address; the code is then typed in. */
export async function askCode(email: string): Promise<void> {
  const answer = await busy(() => serviceJson<{ attempt: string }>("auth/code", post({ email, lang: preferences.language })));
  if (answer) {
    account.email = email;
    account.attempt = answer.attempt;
    account.step = "code";
  }
}

/** Types the code sent by email. */
export async function checkCode(code: string): Promise<void> {
  const answer = await busy(() =>
    serviceJson<SignedIn>("auth/code/check", post({ attempt: account.attempt, code, token: usesToken() }))
  );
  if (answer) welcome(answer.me, answer.token);
}

/** Back to the address, for another one or a new code. */
export function otherAddress(): void {
  account.step = "email";
  account.attempt = "";
  account.error = "";
}

type Ceremony = { options: { publicKey: Record<string, unknown> & { challenge: string } }; ceremony: string };

/** Signs in with a passkey, with no address first. */
export async function passkeySignIn(): Promise<void> {
  await busy(async () => {
    const start = await serviceJson<Ceremony>("auth/passkey/options", post({}));
    let credential: BrowserCredential;
    try {
      credential = (await navigator.credentials.get({ publicKey: requestOptions(start.options) } as unknown as CredentialRequestOptions)) as unknown as BrowserCredential;
    } catch (error) {
      const problem = passkeyProblem(error);
      if (problem) throw new Error(t(problem));
      return;
    }
    const answer = await serviceJson<SignedIn>("auth/passkey", post({ ceremony: start.ceremony, credential: credentialJson(credential), token: usesToken() }));
    welcome(answer.me, answer.token);
  });
}

/** Signs out (or, open, stops being this profile): the page starts again. */
export async function signOut(): Promise<void> {
  await serviceJson("auth/signout", post()).catch(() => undefined);
  setServiceToken(null);
  location.reload();
}

/** One's own sessions and passkeys, for "Account". */
export async function loadMine(): Promise<void> {
  const mine = await serviceJson<{ me: Me; sessions: SessionInfo[]; passkeys: PasskeyInfo[] }>("me").catch(() => null);
  if (mine) {
    account.me = mine.me;
    account.sessions = mine.sessions;
    account.passkeys = mine.passkeys;
  }
  account.keys = await serviceJson<AppKey[]>("me/keys").catch(() => []);
}

/** Changes one's own name. */
export async function renameMe(name: string): Promise<void> {
  await busy(() => serviceJson("me", post({ name })));
  await loadMine();
}

/** Ends one of one's sessions (another device). */
export async function endSession(id: number): Promise<void> {
  await busy(() => serviceJson("me/sessions/end", post({ id })));
  await loadMine();
}

/** Adds a passkey on this device. */
export async function addPasskey(name: string): Promise<void> {
  await busy(async () => {
    const start = await serviceJson<Ceremony>("me/passkeys/options", post({}));
    let credential: BrowserCredential;
    try {
      credential = (await navigator.credentials.create({ publicKey: creationOptions(start.options) } as unknown as CredentialCreationOptions)) as unknown as BrowserCredential;
    } catch (error) {
      const problem = passkeyProblem(error);
      if (problem) throw new Error(t(problem));
      return;
    }
    await serviceJson("me/passkeys", post({ ceremony: start.ceremony, name, credential: credentialJson(credential) }));
  });
  await loadMine();
}

/** Renames one of one's passkeys. */
export async function renamePasskey(id: number, name: string): Promise<void> {
  await busy(() => serviceJson("me/passkeys/rename", post({ id, name })));
  await loadMine();
}

/** Removes one of one's passkeys. */
/** Makes a key for another app (an OpenSubsonic app on a phone); it is shown once. */
export async function addKey(name: string): Promise<void> {
  const made = await busy(() => serviceJson<{ secret: string }>("me/keys", post({ name })));
  if (made) account.newKey = made.secret;
  await loadMine();
}

export async function removeKey(id: number): Promise<void> {
  await busy(() => serviceJson("me/keys/remove", post({ id })));
  account.newKey = "";
  await loadMine();
}

export async function removePasskey(id: number): Promise<void> {
  await busy(() => serviceJson("me/passkeys/remove", post({ id })));
  await loadMine();
}
