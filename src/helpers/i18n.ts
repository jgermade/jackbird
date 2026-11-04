/** A catalogue of messages by key. */
export type Messages = Readonly<Record<string, string>>;

/** Values for a message's `{name}` placeholders. */
export type Params = Readonly<Record<string, string | number>>;

/** Fills `{name}` placeholders from `params`; one with no value stays as written. */
export function fill(message: string, params: Params = {}): string {
  return message.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** The message for `key` in `messages`, else in `fallback`, else the key itself, filled. */
export function translate(messages: Messages, fallback: Messages, key: string, params?: Params): string {
  return fill(messages[key] ?? fallback[key] ?? key, params);
}

/** The plural category of `count` in `language`: `one` or `other` in English and Spanish. */
export function pluralCategory(language: string, count: number): Intl.LDMLPluralRule {
  return new Intl.PluralRules(language).select(count);
}

/**
 * A counted message: `key.one`, `key.other` (or whatever category the
 * language gives `count`), falling back to `key.other`. `{count}` is filled
 * with the count.
 */
export function translatePlural(
  messages: Messages,
  fallback: Messages,
  language: string,
  key: string,
  count: number,
  params?: Params
): string {
  const exact = `${key}.${pluralCategory(language, count)}`;
  const chosen = exact in messages || exact in fallback ? exact : `${key}.other`;
  return translate(messages, fallback, chosen, { count, ...params });
}

/**
 * The first of the user's preferred languages (BCP 47 tags, in order) whose
 * primary subtag is supported, else `fallback`.
 */
export function pickLanguage<T extends string>(preferred: readonly string[], supported: readonly T[], fallback: T): T {
  for (const tag of preferred) {
    const primary = tag.toLowerCase().split("-")[0];
    const match = supported.find((language) => language === primary);
    if (match) {
      return match;
    }
  }
  return fallback;
}
