// The user's preferences: theme and language. Each starts from what was
// saved, else from the system (colour scheme, browser languages), is saved
// once chosen, and is applied to <html> (data-theme, lang). The theme follows
// the system until one is chosen. And whether the library's tree shows the
// songs (helpers/folders.ts), in Files and in the other views apart, off until turned on. And how tall the lists' rows
// are (helpers/density.ts), applied to <html> as data-density. And the display spectrum's look
// and how its peaks fall (helpers/spectrum.ts). And how one song follows another, and the
// crossfade's length (helpers/transition.ts). A jq79 store, so views can bind to it.

import { $reactive } from "jq79";
import { densityOf } from "../helpers/density";
import { pickLanguage } from "../helpers/i18n";
import { peakFallOf, spectrumLookOf } from "../helpers/spectrum";
import { crossfadeSecondsOf, transitionOf } from "../helpers/transition";
import { shownViewsOf, toggledView } from "../helpers/shown-views";
import type { Density, Language, LibraryView, PeakFall, SpectrumLook, Theme, Transition } from "../types";
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

/**
 * Whether the songs are shown where `key` says: off until turned on (the owner, 2026-11-23), from
 * the one switch there was before when not saved; always in the landing page's demo.
 */
function songsShown(key: string): boolean {
  // The landing page's demo (`?embed`) lists its songs: its phone follows the row playing.
  if (isEmbed) return true;
  return (readStored(key) ?? readStored(STORAGE_KEYS.songsInTree)) === "on";
}

/** The tone chosen: one of the two, or "auto", following the system's. */
export type ThemeChoice = Theme | "auto";

export const preferences = $reactive({
  theme: embeddedTheme() ?? storedTheme() ?? systemTheme(),
  themeChoice: (storedTheme() ?? "auto") as ThemeChoice,
  language: embeddedLanguage() ?? storedLanguage() ?? browserLanguage(),
  songsInFolders: songsShown(STORAGE_KEYS.songsInFolders),
  songsInViews: songsShown(STORAGE_KEYS.songsInViews),
  /** The library's views whose keys are in its head (helpers/shown-views.ts). */
  shownViews: shownViewsOf(readStored(STORAGE_KEYS.shownViews)),
  density: densityOf(readStored(STORAGE_KEYS.density)),
  spectrumLook: spectrumLookOf(readStored(STORAGE_KEYS.spectrumLook)),
  peakFall: peakFallOf(readStored(STORAGE_KEYS.peakFall)),
  transition: transitionOf(readStored(STORAGE_KEYS.transition)),
  crossfadeSeconds: crossfadeSecondsOf(readStored(STORAGE_KEYS.crossfadeSeconds)),
  /** The mini player opened by itself when the tab is left while playing (lib/compact.ts): on until turned off. */
  autoMini: readStored(STORAGE_KEYS.autoMini) !== "off"
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

/** Shows the songs in Files, or only its folders (a song reached through Details). */
export function setSongsInFolders(on: boolean): void {
  preferences.songsInFolders = on;
  writeStored(STORAGE_KEYS.songsInFolders, on ? "on" : "off");
}

/** Shows the songs in the library's other views, or only their groups (a song reached through Details). */
export function setSongsInViews(on: boolean): void {
  preferences.songsInViews = on;
  writeStored(STORAGE_KEYS.songsInViews, on ? "on" : "off");
}

/** Whether the mini player opens by itself when the tab is left while playing. */
export function setAutoMini(on: boolean): void {
  preferences.autoMini = on;
  writeStored(STORAGE_KEYS.autoMini, on ? "on" : "off");
}

/** Shows a view's key in the library's head, or hides it; the last one shown stays. */
export function showView(view: LibraryView, on: boolean): void {
  const next = toggledView(preferences.shownViews, view, on);
  preferences.shownViews = next;
  writeStored(STORAGE_KEYS.shownViews, next.join(","));
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

/** How one song follows another (each player hears it: lib/player.ts). */
export function setTransition(transition: Transition): void {
  preferences.transition = transition;
  writeStored(STORAGE_KEYS.transition, transition);
}

/** The crossfade's length, in whole seconds from 1 to 12. */
export function setCrossfadeSeconds(seconds: number): void {
  preferences.crossfadeSeconds = crossfadeSecondsOf(seconds);
  writeStored(STORAGE_KEYS.crossfadeSeconds, String(preferences.crossfadeSeconds));
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
