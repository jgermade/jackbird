// The metadata editor: the form being typed into, opening it on the
// selection, and saving it to the files, the library and `.meta/`. The save
// is the former React view's `handleSave`, except that it records into the
// root as it is when the save ends, not as it was when it began (the
// verifier may have recorded other tracks meanwhile). See
// RECORD/2026-11-03.deck-design-system.WIP.md (steps 6 and 7, and the
// verifier fix).

import { $reactive, $toRaw } from "jq79";
import { computeCommonMetadata, emptyMetadata, getVariedFields, mergeDraft } from "../helpers/metadata";
import type { EditableMetadata, MetaRecord, Track } from "../types";
import { can } from "./account";
import { computeBpms } from "./bpm";
import { t, tn, type MessageKey } from "./i18n";
import { en } from "./locales/en";
import { TagError } from "./tags";
import { library } from "./library";
import { flushMeta } from "./meta";
import { doneWriting, writingFile } from "./progress";
import { updateRoots } from "./roots";
import { ui, type SelectionTab } from "./ui";
import { activeRoot, selectUnlessChosen, selectedTracks } from "./workspace";

/**
 * The form. Filled when the dialog opens and changed only by typing, so
 * nothing a background update writes to the roots resets what is being typed.
 * `confirmed` holds the varied fields whose "Override" box is ticked while empty:
 * those are cleared on every track (see mergeDraft).
 */
export const editor = $reactive({
  form: emptyMetadata() as EditableMetadata,
  confirmed: [] as string[],
  /** In the family library (F3): saved for everyone (editors and up) or only for oneself. */
  scope: "family" as "family" | "mine",
  /** The BPM worked out for each of several tracks, by ID: Save writes each its own, unless one is typed for them all. */
  bpms: {} as Record<string, string>
});

/** Whether the active root is the family library, where anyone edits their own version (F3). */
function inLibrary(): boolean {
  return activeRoot.value.data?.source.kind === "library";
}

/** Whether the root in view is someone's music shared with one (SH-D6). */
export function inSharedMusic(): boolean {
  return activeRoot.value.data?.source.shelf !== undefined;
}

/**
 * Whether the files of the root in view can be changed: by an editor (S3), and not in a folder the
 * browser can only read (lib/sources/picked.ts).
 */
export function canChange(): boolean {
  return can("editor") && !activeRoot.value.data?.source.readOnly;
}

/**
 * Opens the selection's dialog on `tab`, the form filled with the values its
 * tracks share. Switching tabs afterwards keeps what was typed.
 */
export function openSelection(tab: SelectionTab = "edit"): void {
  const tracks = selectedTracks.value.data;
  if (tracks.length === 0) {
    return;
  }
  editor.form = computeCommonMetadata(tracks);
  editor.confirmed = [];
  editor.bpms = {};
  library.errorMessage = null;
  // A listener sees the files' info only (S3); in the family library they edit their own version (F3).
  // In someone's music shared with one, one saves one's own version (SH-D4).
  editor.scope = can("editor") && !inSharedMusic() ? "family" : "mine";
  ui.selectionTab = canChange() || (inLibrary() && tab === "edit") ? tab : "info";
  ui.selectionOpen = true;
}

/**
 * Opens the selection's dialog on `tab` from a track's menu: on the
 * selection when the track is in it, else on that track alone, which becomes
 * the selection.
 */
export function openSelectionFor(trackId: string, tab: SelectionTab): void {
  selectUnlessChosen(trackId);
  openSelection(tab);
}

export function closeSelection(): void {
  ui.selectionOpen = false;
}

/** The "Override" box of a varied field: ticked, its value goes to every track; unticked, the field empties. */
export function confirmField(field: string, on: boolean): void {
  const rest = editor.confirmed.filter((one) => one !== field);
  editor.confirmed = on ? [...rest, field] : rest;
  if (!on) {
    editor.form = { ...editor.form, [field]: "" };
  }
}

/**
 * The "Compilation" box, in the album artist's field: ticked, every track is marked one ("1");
 * unticked, none is (the mark empties, on every track even where the selection varied).
 */
export function setCompilation(on: boolean): void {
  const rest = editor.confirmed.filter((one) => one !== "compilation");
  editor.confirmed = on ? rest : [...rest, "compilation"];
  editor.form = { ...editor.form, compilation: on ? "1" : "" };
}

/** Why a track could not be saved, in the interface's language. */
function reasonOf(error: unknown, metadata: EditableMetadata): string {
  if (error instanceof TagError) {
    const key = `tags.error.${error.code}`;
    if (key in en) {
      return t(key as MessageKey, { year: metadata.year });
    }
    return error.message;
  }
  return error instanceof Error ? error.message : t("message.saveFailed");
}

/**
 * A song someone else saved since it was read (F4): its tags as they are now, in the library and
 * in the form, for the person to apply theirs again.
 */
async function showAsItIsNow(rootId: string, track: Track): Promise<void> {
  const root = $toRaw(library).roots.find((item) => item.id === rootId);
  const now = await root?.source.inspect(track.relativePath).catch(() => null);
  if (!now?.metadata) return;
  const fresh: Track = { ...track, metadata: now.metadata, checksum: now.fullChecksum, fullChecksum: now.fullChecksum, audioChecksum: now.audioChecksum };
  updateRoots((roots) =>
    roots.map((item) => (item.id === rootId ? { ...item, tracks: item.tracks.map((one) => (one.id === track.id ? fresh : one)) } : item))
  );
  editor.form = computeCommonMetadata(selectedTracks.value.data);
  editor.confirmed = [];
}

/**
 * Writes `items` (each track with the tags it is to have) to the active root's files, one at a time
 * (the progress at the dialog's foot, lib/progress.ts): each file gets its new tags and checksums;
 * then the library takes the new tracks and records, merged into the root as it is now, and
 * `.meta/` is written from it (flushMeta). `library.saving` is set throughout, which holds the
 * verifier off. A track the engine refuses stops there: the ones before it stay saved and are
 * recorded, and the message names it and why. Resolves to whether every track was written. The
 * edit dialog's save and the rename tab's "name → tags" (lib/rename.ts) both write through it.
 */
export async function saveMetadata(items: readonly { track: Track; metadata: Track["metadata"] }[]): Promise<boolean> {
  const root = activeRoot.value.data;
  if (!root || items.length === 0 || library.saving) {
    return false;
  }
  library.saving = true;
  library.errorMessage = null;
  library.infoMessage = null;

  try {
    const records: Record<string, MetaRecord> = {};
    const saved = new Map<string, Track>();
    // The track that could not be saved, and why: the ones before it are saved and recorded.
    let failed: { track: Track; reason: string; stale?: boolean } | null = null;

    for (const [index, { track, metadata }] of items.entries()) {
      writingFile(index + 1, items.length, track.name);
      try {
        // In the family library (F4), the version read goes with it: a song changed since is refused.
        const expected = inLibrary() ? track.fullChecksum : undefined;
        const written = await root.source.save(track.relativePath, track.metadata, metadata, $toRaw(editor).scope, expected);
        const { fullChecksum, audioChecksum } = written;
        const nowIso = new Date().toISOString();
        // The date the disk gave the file, which the next load compares with:
        // one of our own would make it read every edited file again.
        const lastModified = written.lastModified ?? Date.now();
        const checked = { checksum: fullChecksum, fullChecksum, audioChecksum, size: written.size, lastModified, lastVerifiedAt: nowIso, metadata };

        // Its audio, unchanged by a tag's write, kept in the record (none there would read it again).
        records[track.relativePath] = { ...checked, audio: track.audio ?? null, updatedAt: nowIso };
        saved.set(track.id, { ...track, ...checked });
      } catch (error) {
        failed = { track, reason: reasonOf(error, metadata), stale: error instanceof TagError && error.code === "stale" };
        break;
      }
    }

    if (saved.size > 0) {
      // The files are written: the library shows them even if `.meta/` fails.
      updateRoots((roots) =>
        roots.map((item) =>
          item.id === root.id
            ? {
                ...item,
                tracks: item.tracks.map((one) => saved.get(one.id) ?? one),
                metaSnapshot: { ...item.metaSnapshot, tracks: { ...item.metaSnapshot.tracks, ...records } }
              }
            : item
        )
      );
      await flushMeta(root.id);
    }

    if (failed) {
      const message = t("message.saveFailedFor", { name: failed.track.name, reason: failed.reason });
      library.errorMessage = saved.size > 0 ? `${message} ${tn("message.savedBefore", saved.size)}` : message;
      if (failed.stale) await showAsItIsNow(root.id, failed.track);
      return false;
    }
    const target = items.length === 1 ? items[0].track.name : tn("tracks.count", items.length);
    library.infoMessage = t("message.saved", { target });
    return true;
  } catch (error) {
    library.errorMessage = error instanceof Error ? error.message : t("message.saveFailed");
    return false;
  } finally {
    doneWriting();
    library.saving = false;
  }
}

/** Saves the edit dialog's form to the selected tracks (saveMetadata), and closes it when it all worked. */
export async function saveEdits(): Promise<void> {
  const tracks = selectedTracks.value.data;
  if (tracks.length === 0 || library.saving) return;
  const draft: EditableMetadata = { ...$toRaw(editor).form };
  const confirmed = [...$toRaw(editor).confirmed];
  const varied = getVariedFields(tracks);
  // The BPM worked out for each, where none was typed for them all (nor the field emptied on purpose).
  const bpms = { ...$toRaw(editor).bpms };
  const ownBpm = !draft.bpm.trim() && !confirmed.includes("bpm");
  const metadataOf = (track: Track): Track["metadata"] => {
    const merged = mergeDraft(track.metadata, draft, varied, confirmed);
    return ownBpm && bpms[track.id] ? { ...merged, bpm: bpms[track.id] } : merged;
  };
  if (await saveMetadata(tracks.map((track) => ({ track, metadata: metadataOf(track) })))) {
    ui.selectionOpen = false;
  }
}

/**
 * Works out the selection's BPM (lib/bpm.ts): one track's into the field; several tracks' kept, each
 * its own, for Save. Says how many could not be told.
 */
export async function calculateBpm(): Promise<void> {
  const root = activeRoot.value.data;
  const tracks = selectedTracks.value.data;
  if (!root || tracks.length === 0) return;
  library.errorMessage = null;
  const single = tracks.length === 1;
  if (!single) editor.bpms = {};
  const failed = await computeBpms(root.source, tracks, (track, bpm) => {
    if (!bpm) return;
    if (single) editor.form = { ...editor.form, bpm };
    else editor.bpms = { ...editor.bpms, [track.id]: bpm };
  });
  if (failed > 0) library.errorMessage = tn("bpm.failed", failed);
}
