// The user's preferences: theme and language. Each starts from what was
// saved, else from the system (colour scheme, browser languages), is saved
// once chosen, and is applied to <html> (data-theme, lang). The theme follows
// the system until one is chosen. A jq79 store, so views can bind to it.

import { $reactive } from "jq79";
import { pickLanguage } from "../helpers/i18n";
import type { Language, Theme } from "../types";
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

export const preferences = $reactive({
  theme: storedTheme() ?? systemTheme(),
  language: storedLanguage() ?? browserLanguage()
});

function apply(): void {
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.lang = preferences.language;
}
apply();
preferences.$onAny(apply);

if (typeof matchMedia === "function") {
  matchMedia(DARK_QUERY).addEventListener("change", (event) => {
    if (storedTheme() === null) {
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
