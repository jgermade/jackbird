// The metadata editor: the form being typed into, opening it on the
// selection, and saving it to the files, the library and `.meta/`. The save
// is the former React view's `handleSave`, except that it records into the
// root as it is when the save ends, not as it was when it began (the
// verifier may have recorded other tracks meanwhile). See
// RECORD/2026-11-03.deck-design-system.WIP.md (steps 6 and 7, and the
// verifier fix).

import { $reactive, $toRaw } from "jq79";
import { computeCommonMetadata, emptyMetadata, getVariedFields, mergeDraft } from "../helpers/metadata";
import type { EditableMetadata, MetaRecord, Mp3Track } from "../types";
import { t, tn } from "./i18n";
import { calculateDualChecksums, writeTrackMetadataToBytes } from "./id3";
import { library } from "./library";
import { flushMeta } from "./meta";
import { updateRoots } from "./roots";
import { ui, type SelectionTab } from "./ui";
import { activeRoot, selectedTracks } from "./workspace";

/**
 * The form. Filled when the dialog opens and changed only by typing, so
 * nothing a background update writes to the roots resets what is being typed.
 * `confirmed` holds the varied fields whose "All" box is ticked while empty:
 * those are cleared on every track (see mergeDraft).
 */
export const editor = $reactive({
  form: emptyMetadata() as EditableMetadata,
  confirmed: [] as string[]
});

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
  ui.selectionTab = tab;
  ui.selectionOpen = true;
}

export function closeSelection(): void {
  ui.selectionOpen = false;
}

/** The "All" box of a varied field: ticked, its value goes to every track; unticked, the field empties. */
export function confirmField(field: string, on: boolean): void {
  const rest = editor.confirmed.filter((one) => one !== field);
  editor.confirmed = on ? [...rest, field] : rest;
  if (!on) {
    editor.form = { ...editor.form, [field]: "" };
  }
}

/**
 * Writes the form to every selected track: a field the selection varied in
 * and the form left empty keeps each track's own value (see mergeDraft). Each
 * file gets its new tags and checksums; then the library takes the new
 * tracks and records, merged into the root as it is now, and `.meta/` is
 * written from it (flushMeta). `library.saving` is set throughout, which
 * holds the verifier off. Says what was saved, or why not, and closes the
 * editor when it all worked.
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
    const saved = new Map<string, Mp3Track>();

    for (const track of tracks) {
      const metadata = mergeDraft(track.metadata, draft, varied, confirmed);
      const bytes = await writeTrackMetadataToBytes(await root.vfs.read(track.relativePath), metadata);
      await root.vfs.write(track.relativePath, bytes);
      const { fullChecksum, audioChecksum } = await calculateDualChecksums(bytes);
      const nowIso = new Date().toISOString();
      // The date the disk gave the file, which the next load compares with:
      // one of our own would make it read every edited file again.
      const lastModified = (await root.vfs.stat(track.relativePath).catch(() => null))?.mtime ?? Date.now();
      const checked = { checksum: fullChecksum, fullChecksum, audioChecksum, size: bytes.byteLength, lastModified, lastVerifiedAt: nowIso, metadata };

      records[track.relativePath] = { ...checked, updatedAt: nowIso };
      saved.set(track.id, { ...track, ...checked });
    }

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

    const target = tracks.length === 1 ? tracks[0].name : tn("tracks.count", tracks.length);
    library.infoMessage = t("message.saved", { target });
    ui.selectionOpen = false;
  } catch (error) {
    library.errorMessage = error instanceof Error ? error.message : t("message.saveFailed");
  } finally {
    library.saving = false;
  }
}
