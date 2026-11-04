// Translation: `t(key, params)` and `tn(key, count, params)` in the chosen
// language, English as the fallback. The catalogues are ./locales/; English
// is the source. Views import them; components, which may not import lib/,
// take their texts as props (see "Layers" in AGENTS.md).

import { translate, translatePlural, type Params } from "../helpers/i18n";
import type { Language } from "../types";
import { en, type MessageKey, type PluralKey } from "./locales/en";
import { es } from "./locales/es";
import { preferences } from "./preferences";

export type { MessageKey, PluralKey };

const CATALOGUES: Record<Language, Readonly<Record<string, string>>> = { en, es };

export type Translate = ((key: MessageKey, params?: Params) => string) & {
  /** A counted message: `key.one` / `key.other`, with `{count}` filled. */
  n: (key: PluralKey, count: number, params?: Params) => string;
  /** The language this translator speaks, for dates and numbers. */
  language: Language;
};

export function createTranslate(language: Language): Translate {
  const messages = CATALOGUES[language];
  return Object.assign((key: MessageKey, params?: Params) => translate(messages, en, key, params), {
    n: (key: PluralKey, count: number, params?: Params) => translatePlural(messages, en, language, key, count, params),
    language
  });
}

/** A language's name in itself ("English", "Español"), whatever the interface language. */
export function languageName(language: Language): string {
  return CATALOGUES[language]["language.self"];
}

/** A text in the current language. Read in a jq79 binding, it re-renders when the language changes. */
export function t(key: MessageKey, params?: Params): string {
  return createTranslate(preferences.language)(key, params);
}

/** A counted text in the current language (`key.one` / `key.other`). */
export function tn(key: PluralKey, count: number, params?: Params): string {
  return createTranslate(preferences.language).n(key, count, params);
}
