import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "mp3-manager.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function readSystemTheme(): Theme {
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures (private browsing, sandboxed context): the
    // choice still applies for the current session.
  }
}

/**
 * Manages the light/dark theme: starts from the stored preference, falling
 * back to the OS `prefers-color-scheme`, applies it to the document as
 * `data-theme`, and keeps following system changes until the user picks a
 * theme explicitly via the returned toggle function.
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme() ?? readSystemTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (readStoredTheme() !== null || typeof matchMedia !== "function") {
      return;
    }

    const query = matchMedia(DARK_QUERY);
    const handleChange = (event: MediaQueryListEvent) => setTheme(event.matches ? "dark" : "light");
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  function toggleTheme(): void {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      persistTheme(next);
      return next;
    });
  }

  return [theme, toggleTheme];
}
