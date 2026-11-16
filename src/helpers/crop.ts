// The picture crop's sums (lib/picture.ts, views/picture-crop.html): a picture laid over a square
// frame, scaled and moved, always covering it. Its sums, apart from the page, so they are tested.
// See RECORD/2026-11-03.deck-design-system.WIP.md (25).

/** A picture's natural size. */
export type Size = { width: number; height: number };

/** How the picture lies over a square frame of `frame` pixels: `zoom` (1 = it just covers the frame) and its centre's offset from the frame's centre, in frame pixels. */
export type CropView = { zoom: number; x: number; y: number };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/** The scale at which the picture just covers a square frame of `frame` pixels (its shorter side the frame's). */
export function coverScale(size: Size, frame: number): number {
  return frame / Math.min(size.width, size.height);
}

/** The view kept within bounds: the zoom between MIN_ZOOM and MAX_ZOOM, and the picture's edges never inside the frame. */
export function clampView(size: Size, frame: number, view: CropView): CropView {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom));
  const scale = coverScale(size, frame) * zoom;
  const spareX = Math.max(0, (size.width * scale - frame) / 2);
  const spareY = Math.max(0, (size.height * scale - frame) / 2);
  return { zoom, x: Math.min(spareX, Math.max(-spareX, view.x)), y: Math.min(spareY, Math.max(-spareY, view.y)) };
}

/** The view after zooming by `factor` round the frame's centre, kept within bounds. */
export function zoomView(size: Size, frame: number, view: CropView, zoom: number): CropView {
  const ratio = zoom / view.zoom;
  return clampView(size, frame, { zoom, x: view.x * ratio, y: view.y * ratio });
}

/** The part of the picture the frame shows, in the picture's pixels: what `drawImage` takes. */
export function sourceRect(size: Size, frame: number, view: CropView): { sx: number; sy: number; side: number } {
  const { zoom, x, y } = clampView(size, frame, view);
  const scale = coverScale(size, frame) * zoom;
  const side = frame / scale;
  return { sx: size.width / 2 - x / scale - side / 2, sy: size.height / 2 - y / scale - side / 2, side };
}
