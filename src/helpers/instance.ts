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
