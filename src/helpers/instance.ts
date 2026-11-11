// A phone's instance (E6's spike): the address a person types, as the app
// will ask it. Pure: lib/instance.ts keeps it and asks the instance.

/**
 * An address as typed ("music.example.org", "https://music.example.org/",
 * "192.168.1.20:4646") as the app asks it: with its scheme (HTTPS unless
 * one is given) and without a trailing slash or path. Null when it is not
 * an address.
 */
export function normaliseAddress(typed: string): string | null {
  const trimmed = typed.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Whether an address is this device itself (the desktop app's own service, never a phone's instance). */
export function isLoopbackAddress(address: string): boolean {
  try {
    const host = new URL(address).hostname;
    return host === "localhost" || host === "[::1]" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** How the session keeps a root of a server other than the page's home one (E6b-D11). */
const ON_SERVER = "jackbird-server:";

/**
 * What the session keeps for a root of a server: its path alone on the home server (the page's own
 * origin, or the desktop's installed service, as before E6b), or its server's address with it on any
 * other, so the same path on two machines is two roots.
 */
export function savedOnServer(address: string | null, path: string): string {
  return address ? `${ON_SERVER}${address}#${path}` : path;
}

/** A root's kept form read back: its server's address (null: the home server) and its path. */
export function parseSaved(saved: string): { server: string | null; path: string } {
  if (!saved.startsWith(ON_SERVER)) return { server: null, path: saved };
  const rest = saved.slice(ON_SERVER.length);
  const at = rest.indexOf("#");
  if (at < 0) return { server: null, path: saved };
  return { server: rest.slice(0, at), path: rest.slice(at + 1) };
}
