/**
 * The sample music a demo offers (`samples/index.json`, served beside the app on GitHub Pages and by
 * the dev server): a label for the folder it becomes, and its files. See
 * RECORD/2026-11-12.landing-page.WIP.md (2026-11-13 05:00).
 */

export type SampleList = { label: string; files: string[] };

/**
 * The sample list in `value` (the index's JSON), or null when it is not one: a label, and at least
 * one file, each a plain name (no folder, nothing to climb out of the folder with) of a track.
 */
export function parseSampleList(value: unknown): SampleList | null {
  if (!value || typeof value !== "object") return null;
  const { label, files } = value as { label?: unknown; files?: unknown };
  if (typeof label !== "string" || !label.trim() || /[\\/]/.test(label)) return null;
  if (!Array.isArray(files) || files.length === 0) return null;
  const plain = (name: unknown): name is string =>
    typeof name === "string" && name.trim() !== "" && !/[\\/]/.test(name) && name !== "." && name !== ".." && /\.(mp3|flac)$/i.test(name);
  return files.every(plain) ? { label: label.trim(), files } : null;
}
