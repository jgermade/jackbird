/**
 * Text compared as `a.localeCompare(b, locale)` does, by a collator made once per locale: Safari's
 * JavaScriptCore (the desktop app's web view, and Safari) makes a new one on each such call, which
 * made sorting ten thousand titles take 380 ms instead of 8 and changing the library's view slow.
 */
const collators = new Map<string, Intl.Collator>();

export function compareText(left: string, right: string, locale: string): number {
  let collator = collators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale);
    collators.set(locale, collator);
  }
  return collator.compare(left, right);
}
