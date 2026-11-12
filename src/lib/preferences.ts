// The user's preferences: theme and language. Each starts from what was
// saved, else from the system (colour scheme, browser languages), is saved
// once chosen, and is applied to <html> (data-theme, lang). The theme follows
// the system until one is chosen. A jq79 store, so views can bind to it.

import { $reactive } from "jq79";
import { pickLanguage } from "../helpers/i18n";
import type { Language, Theme } from "../types";
import { isEmbed } from "./platform";
import { STORAGE_KEYS, readStored, writeStored } from "./storage";

export const LANGUAGES: readonly Language[] = ["en", "es"];

const DARK_QUERY = "(prefers-color-scheme: dark)";

function storedTheme(): Theme | null {
  const value = readStored(STORAGE_KEYS.theme);
  return value === "light" || value === "dark" ? value : null;
}

function systemTheme(): Theme {
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function storedLanguage(): Language | null {
  const value = readStored(STORAGE_KEYS.language);
  return LANGUAGES.find((language) => language === value) ?? null;
}

function browserLanguage(): Language {
  const preferred = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return pickLanguage(preferred, LANGUAGES, "en");
}

/** Embedded in the landing page (`?embed`): its tone (`&tone=`) and its language (`&lang=`), not this browser's saved ones. */
const embedded = isEmbed ? new URLSearchParams(location.search) : null;
const embeddedTheme = (): Theme | null => {
  const tone = embedded?.get("tone");
  return tone === "light" || tone === "dark" ? tone : null;
};
const embeddedLanguage = (): Language | null => LANGUAGES.find((language) => language === embedded?.get("lang")) ?? null;

export const preferences = $reactive({
  theme: embeddedTheme() ?? storedTheme() ?? systemTheme(),
  language: embeddedLanguage() ?? storedLanguage() ?? browserLanguage()
});

function apply(): void {
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.lang = preferences.language;
}
apply();
preferences.$onAny(apply);

// The landing page turns its tone, and the embedded app's with it (saved nowhere).
if (isEmbed) {
  window.addEventListener("message", (event) => {
    const data = event.data as { type?: string; tone?: string } | null;
    if (event.origin !== location.origin || data?.type !== "jackbird:tone") return;
    if (data.tone === "light" || data.tone === "dark") preferences.theme = data.tone;
  });
}

if (typeof matchMedia === "function") {
  matchMedia(DARK_QUERY).addEventListener("change", (event) => {
    if (!isEmbed && storedTheme() === null) {
      preferences.theme = event.matches ? "dark" : "light";
    }
  });
}

export function setTheme(theme: Theme): void {
  preferences.theme = theme;
  writeStored(STORAGE_KEYS.theme, theme);
}

export function toggleTheme(): void {
  setTheme(preferences.theme === "dark" ? "light" : "dark");
}

export function setLanguage(language: Language): void {
  preferences.language = language;
  writeStored(STORAGE_KEYS.language, language);
}
