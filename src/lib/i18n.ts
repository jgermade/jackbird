// Translation: `t(key, params)` and `t.n(key, count, params)` in the chosen
// language, English as the fallback. The catalogues are ./locales/; English
// is the source. React components get a `t` from the view, since components
// may not import lib/ (see "Layers" in AGENTS.md).

import { useMemo } from "react";
import { translate, translatePlural, type Params } from "../helpers/i18n";
import type { Language } from "../types";
import { en, type MessageKey, type PluralKey } from "./locales/en";
import { es } from "./locales/es";
import { preferences } from "./preferences";
import { useStoreValue } from "./react-store";

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

/** A translator in the current language. */
export function t(key: MessageKey, params?: Params): string {
  return createTranslate(preferences.language)(key, params);
}

/** A translator for React that changes when the language does. */
export function useT(): Translate {
  const [language] = useStoreValue(preferences, "language");
  return useMemo(() => createTranslate(language), [language]);
}
