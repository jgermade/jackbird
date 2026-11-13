// How much of the page's bottom a phone's on-screen keyboard covers, in a browser: `--mm-keyboard`
// on the page's root (0 while it is down), and `--mm-viewport`, the height left above it. A sheet
// (theme/default/components/modal.html) rests on the keyboard and fits in what is left.
//
// Chrome on Android shrinks the page itself (`interactive-widget=resizes-content`, index.html): the
// keyboard covers none of it. Safari on iOS lays the keyboard over the page and shrinks the visual
// viewport only, which may also be scrolled down the page: what the keyboard covers is the layout
// viewport's height less the visual one's bottom. In the Android app the plugin says it
// (lib/safe-area.ts). See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-14).

/** Follows the keyboard from now on. */
export function followKeyboard(): void {
  const view = window.visualViewport;
  if (!view) return;
  const root = document.documentElement.style;
  const apply = () => {
    const covered = Math.max(0, Math.round(window.innerHeight - (view.height + view.offsetTop)));
    root.setProperty("--mm-keyboard", `${covered}px`);
    root.setProperty("--mm-viewport", `${Math.round(view.height)}px`);
    document.dispatchEvent(new Event("mm-keyboard"));
  };
  view.addEventListener("resize", apply);
  view.addEventListener("scroll", apply);
  apply();
}
