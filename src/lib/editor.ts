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
import { t, tn, type MessageKey } from "./i18n";
import { en } from "./locales/en";
import { TagError } from "./tags";
import { library } from "./library";
import { flushMeta } from "./meta";
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
  scope: "family" as "family" | "mine"
});

/** Whether the active root is the family library, where anyone edits their own version (F3). */
function inLibrary(): boolean {
  return activeRoot.value.data?.source.kind === "library";
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
  library.errorMessage = null;
  // A listener sees the files' info only (S3); in the family library they edit their own version (F3).
  editor.scope = can("editor") ? "family" : "mine";
  ui.selectionTab = can("editor") || (inLibrary() && tab === "edit") ? tab : "info";
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
 * Writes the form to every selected track: a field the selection varied in
 * and the form left empty keeps each track's own value (see mergeDraft). Each
 * file gets its new tags and checksums; then the library takes the new
 * tracks and records, merged into the root as it is now, and `.meta/` is
 * written from it (flushMeta). `library.saving` is set throughout, which
 * holds the verifier off. A track the engine refuses stops the save there:
 * the tracks before it stay saved and are recorded, and the message names it
 * and why. Says what was saved, or why not, and closes the editor when it
 * all worked.
 */
export async function saveEdits(): Promise<void> {
  const root = activeRoot.value.data;
  const tracks = selectedTracks.value.data;
  if (!root || tracks.length === 0 || library.saving) {
    return;
  }

  const draft: EditableMetadata = { ...$toRaw(editor).form };
  const confirmed = [...$toRaw(editor).confirmed];
  library.saving = true;
  library.errorMessage = null;
  library.infoMessage = null;

  try {
    const varied = getVariedFields(tracks);
    const records: Record<string, MetaRecord> = {};
    const saved = new Map<string, Track>();
    // The track that could not be saved, and why: the ones before it are saved and recorded.
    let failed: { track: Track; reason: string; stale?: boolean } | null = null;

    for (const track of tracks) {
      const metadata = mergeDraft(track.metadata, draft, varied, confirmed);
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

        records[track.relativePath] = { ...checked, updatedAt: nowIso };
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
      return;
    }
    const target = tracks.length === 1 ? tracks[0].name : tn("tracks.count", tracks.length);
    library.infoMessage = t("message.saved", { target });
    ui.selectionOpen = false;
  } catch (error) {
    library.errorMessage = error instanceof Error ? error.message : t("message.saveFailed");
  } finally {
    library.saving = false;
  }
}
