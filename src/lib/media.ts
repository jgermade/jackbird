// The layouts that follow the window's width from a script (the narrow panes, the display's bands):
// told when a media query starts or stops matching. A MediaQueryList's `change` alone did not reach
// them in the desktop app on macOS (WebKit): resized, the window kept the layout it opened with.
// So each resize asks the query again, afresh, and either way the change is told once.
// See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-15).

/** Calls `onChange` when `query` starts or stops matching; returns what stops watching. */
export function watchMedia(query: string, onChange: (matches: boolean) => void): () => void {
  const list = matchMedia(query);
  let last = list.matches;
  const check = (): void => {
    const now = matchMedia(query).matches;
    if (now === last) return;
    last = now;
    onChange(now);
  };
  list.addEventListener("change", check);
  window.addEventListener("resize", check);
  return () => {
    list.removeEventListener("change", check);
    window.removeEventListener("resize", check);
  };
}
