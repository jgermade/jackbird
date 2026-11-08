/**
 * Versions as jackbird's releases name them (`0.1.8`; `v0.1.8` too): whether
 * one is newer than another, part by part as numbers. The desktop app offers
 * to update an installed service older than its own copy (S2).
 */

const parts = (version: string): number[] => {
  const found = version.trim().replace(/^v/i, "").split(/[.+-]/);
  return [0, 1, 2].map((at) => Number.parseInt(found[at] ?? "", 10) || 0);
};

/** Whether `candidate` is newer than `installed`; false when either is missing. */
export function isNewerVersion(candidate: string | null | undefined, installed: string | null | undefined): boolean {
  if (!candidate || !installed) {
    return false;
  }
  const [a, b] = [parts(candidate), parts(installed)];
  for (let at = 0; at < 3; at += 1) {
    if (a[at] !== b[at]) {
      return a[at] > b[at];
    }
  }
  return false;
}
