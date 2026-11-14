// The user's preferences: theme and language. Each starts from what was
// saved, else from the system (colour scheme, browser languages), is saved
// once chosen, and is applied to <html> (data-theme, lang). The theme follows
// the system until one is chosen. And whether the library's tree shows the
// songs (helpers/folders.ts), on until turned off. And how tall the lists' rows
// are (helpers/density.ts), applied to <html> as data-density. And the display spectrum's look
// and how its peaks fall (helpers/spectrum.ts). A jq79 store, so views can bind to it.

import { $reactive } from "jq79";
import { densityOf } from "../helpers/density";
import { pickLanguage } from "../helpers/i18n";
import { peakFallOf, spectrumLookOf } from "../helpers/spectrum";
import type { Density, Language, PeakFall, SpectrumLook, Theme } from "../types";
import { isEmbed } from "./platform";
import { STORAGE_KEYS, readStored, removeStored, writeStored } from "./storage";

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

/** The tone chosen: one of the two, or "auto", following the system's. */
export type ThemeChoice = Theme | "auto";

export const preferences = $reactive({
  theme: embeddedTheme() ?? storedTheme() ?? systemTheme(),
  themeChoice: (storedTheme() ?? "auto") as ThemeChoice,
  language: embeddedLanguage() ?? storedLanguage() ?? browserLanguage(),
  songsInTree: readStored(STORAGE_KEYS.songsInTree) !== "off",
  density: densityOf(readStored(STORAGE_KEYS.density)),
  spectrumLook: spectrumLookOf(readStored(STORAGE_KEYS.spectrumLook)),
  peakFall: peakFallOf(readStored(STORAGE_KEYS.peakFall))
});

function apply(): void {
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.lang = preferences.language;
  document.documentElement.dataset.density = preferences.density;
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
  preferences.themeChoice = theme;
  writeStored(STORAGE_KEYS.theme, theme);
}

/** The tone chosen in Settings: "auto" forgets the saved one and follows the system's. */
export function setThemeChoice(choice: ThemeChoice): void {
  if (choice !== "auto") return setTheme(choice);
  preferences.themeChoice = "auto";
  removeStored(STORAGE_KEYS.theme);
  if (!isEmbed) preferences.theme = systemTheme();
}

export function toggleTheme(): void {
  setTheme(preferences.theme === "dark" ? "light" : "dark");
}

/** Shows the songs in the library's tree, or only its folders and groups (a song reached through Details). */
export function setSongsInTree(on: boolean): void {
  preferences.songsInTree = on;
  writeStored(STORAGE_KEYS.songsInTree, on ? "on" : "off");
}

/** How tall the lists' rows are. */
export function setDensity(density: Density): void {
  preferences.density = density;
  writeStored(STORAGE_KEYS.density, density);
}

/** How the display's spectrum draws its columns. */
export function setSpectrumLook(look: SpectrumLook): void {
  preferences.spectrumLook = look;
  writeStored(STORAGE_KEYS.spectrumLook, look);
}

/** How the display spectrum's peaks fall, or none. */
export function setPeakFall(fall: PeakFall): void {
  preferences.peakFall = fall;
  writeStored(STORAGE_KEYS.peakFall, fall);
}

export function setLanguage(language: Language): void {
  preferences.language = language;
  writeStored(STORAGE_KEYS.language, language);
}
