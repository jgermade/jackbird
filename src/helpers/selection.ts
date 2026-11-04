/** Which tracks are selected, and the one a range extends from. */
export type Selection = {
  selected: readonly string[];
  anchor: string | null;
};

/**
 * The selection after a click on `trackId`. `toggle` (a plain click) adds or
 * removes it; `range` (Shift) adds every track between the anchor and it, in
 * `order`, the order the tracks are shown in. The anchor is the first track
 * clicked and stays until a selection starts afresh.
 */
export function nextSelection(current: Selection, trackId: string, mode: "toggle" | "range", order: readonly string[]): Selection {
  const anchor = current.anchor ?? trackId;
  if (mode === "toggle") {
    const selected = current.selected.includes(trackId)
      ? current.selected.filter((id) => id !== trackId)
      : [...current.selected, trackId];
    return { selected, anchor };
  }

  const from = order.indexOf(current.anchor ?? current.selected[0] ?? trackId);
  const to = order.indexOf(trackId);
  if (from === -1 || to === -1) {
    return { selected: [trackId], anchor };
  }
  const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
  return { selected: [...new Set([...current.selected, ...range])], anchor };
}
