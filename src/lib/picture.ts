// The picture crop (views/picture-crop.html and picture-keys.html): an image pasted, dropped or
// chosen, framed in a square and given back as a JPEG, for whoever asks. An artist's picture asks
// in a dialog of its own (round, views/picture-dialog.html); a cover in the edit dialog asks in a
// sub-modal of it (square, views/selection-dialog.html). Asked with `openPicture`, which resolves to
// the crop, `null` when the picture is removed, or `undefined` when closed.
// See RECORD/2026-11-03.deck-design-system.WIP.md (25).

import { $reactive } from "jq79";
import { clampView, coverScale, sourceRect, zoomView, MAX_ZOOM, MIN_ZOOM, type CropView, type Size } from "../helpers/crop";
import { isPhone } from "./platform";

/** The frame's side, in CSS pixels. */
export const FRAME = 256;

/** What the crop is asked for. */
export type PictureAsk = {
  eyebrow: string;
  title: string;
  /** The mask round (an artist), else square (a cover). */
  round: boolean;
  /** Whether there is a picture to remove. */
  removable: boolean;
  /** The crop's largest side, in pixels; a smaller picture is not made larger. */
  max: number;
  /** Where it is asked: a dialog of its own, or a sub-modal of the edit dialog. */
  place: "modal" | "sub";
};

/** The crop's request while open, and what it shows: the picture's URL and size, how it is framed. */
export const picture = $reactive({
  ask: null as PictureAsk | null,
  src: null as string | null,
  size: null as Size | null,
  view: { zoom: 1, x: 0, y: 0 } as CropView,
  failed: false,
  /** The paste key found no picture in the clipboard (or could not read it). */
  noPaste: false,
  saving: false
});

// Kept out of the store: the loaded image (drawn when saving) and the object URL made for a file.
let image: HTMLImageElement | null = null;
let made: string | null = null;
let settle: ((result: Blob | null | undefined) => void) | null = null;

function show(url: string | null, own: boolean): void {
  if (made) URL.revokeObjectURL(made);
  made = own ? url : null;
  image = null;
  picture.failed = false;
  picture.noPaste = false;
  picture.size = null;
  picture.view = { zoom: 1, x: 0, y: 0 };
  picture.src = url;
  if (!url) return;
  const loading = new Image();
  loading.onload = () => {
    if (picture.src !== url) return;
    image = loading;
    picture.size = { width: loading.naturalWidth, height: loading.naturalHeight };
  };
  loading.onerror = () => {
    if (picture.src !== url) return;
    picture.src = null;
    picture.failed = true;
  };
  loading.src = url;
}

/** Brings a picture in (dropped, pasted, chosen): an image file; anything else is left. */
export function bringPicture(blob: Blob | null | undefined): void {
  if (!blob || !blob.type.startsWith("image/")) return;
  picture.noPaste = false;
  show(URL.createObjectURL(blob), true);
}

/**
 * The picture the clipboard holds: in the Android app, Android's own clipboard, read by the app's
 * plugin (its webview has no clipboard to read); elsewhere the browser's, which may ask first
 * (a phone's browser shows its own "Paste"). Null when it holds none.
 */
async function clipboardPicture(): Promise<Blob | null> {
  if (isPhone && /Android/.test(navigator.userAgent)) {
    const { invoke } = await import("@tauri-apps/api/core");
    const got = await invoke<{ type?: string | null; data?: string | null }>("plugin:jackbird-player|clipboard_image");
    if (!got.data || !got.type) return null;
    return new Blob([Uint8Array.from(atob(got.data), (char) => char.charCodeAt(0))], { type: got.type });
  }
  if (!navigator.clipboard?.read) return null;
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find((one) => one.startsWith("image/"));
    if (type) return item.getType(type);
  }
  return null;
}

/** The paste key (a phone has no ⌘V): the clipboard's picture, or why there is none. */
export async function pastePicture(): Promise<void> {
  picture.noPaste = false;
  const found = await clipboardPicture().catch(() => null);
  if (found) bringPicture(found);
  else picture.noPaste = true;
}

/** Opens the crop for `ask`, from `from` (the picture there is, as a URL, or a file dropped); resolves to the crop, `null` (removed) or `undefined` (closed). */
export function openPicture(ask: PictureAsk, from: string | Blob | null): Promise<Blob | null | undefined> {
  settle?.(undefined);
  picture.ask = ask;
  if (from instanceof Blob) bringPicture(from);
  else show(from, false);
  return new Promise((resolve) => {
    settle = resolve;
  });
}

function finish(result: Blob | null | undefined): void {
  const done = settle;
  settle = null;
  show(null, false);
  picture.ask = null;
  done?.(result);
}

/** Frames the picture at `view`, kept within bounds. */
export function placePicture(view: CropView): void {
  if (picture.size) picture.view = clampView(picture.size, FRAME, view);
}

/** Zooms the picture to `zoom` round the frame's centre. */
export function zoomPicture(zoom: number): void {
  if (picture.size) picture.view = zoomView(picture.size, FRAME, picture.view, Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)));
}

/** The picture's style in the frame: its size at the zoom, and where it lies. */
export function pictureStyle(): string {
  const { size, view } = picture;
  if (!size) return "visibility: hidden";
  const scale = coverScale(size, FRAME) * view.zoom;
  return `width: ${size.width * scale}px; height: ${size.height * scale}px; transform: translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))`;
}

/** Gives the crop back: what the frame shows, as a JPEG no larger than asked nor than that part of the picture. */
export async function savePicture(): Promise<void> {
  const { ask, size } = picture;
  if (!ask || !size || !image) return;
  picture.saving = true;
  try {
    const { sx, sy, side } = sourceRect(size, FRAME, picture.view);
    const out = Math.max(1, Math.min(ask.max, Math.round(side)));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = out;
    canvas.getContext("2d")!.drawImage(image, sx, sy, side, side, 0, 0, out, out);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw new Error("no picture");
    finish(blob);
  } catch {
    picture.failed = true;
  } finally {
    picture.saving = false;
  }
}

/** Removes the picture there is. */
export function removePicture(): void {
  finish(null);
}

/** Closes the crop, changing nothing. */
export function closePicture(): void {
  finish(undefined);
}

/** A picture as a data URL (a cover goes into the tags so). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
