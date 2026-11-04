// The metadata editor: the form being typed into, opening it on the
// selection, and saving it to the files, `.meta/` and the library. The save
// is the former React view's `handleSave` as it was. See
// RECORD/2026-11-03.deck-design-system.WIP.md (steps 6 and 7).

import { $reactive, $toRaw } from "jq79";
import { computeCommonMetadata, emptyMetadata, getVariedFields, mergeDraft } from "../helpers/metadata";
import type { EditableMetadata, MetaSnapshot, Mp3Track } from "../types";
import { t, tn } from "./i18n";
import { calculateDualChecksums, writeTrackMetadataToBytes } from "./id3";
import { library } from "./library";
import { writeMetaSnapshot } from "./meta";
import { updateRoots } from "./roots";
import { ui } from "./ui";
import { activeRoot, selectedTracks } from "./workspace";

/**
 * The form. Filled when the editor opens and changed only by typing, so
 * nothing a background update writes to the roots resets what is being typed.
 */
export const editor = $reactive({
  form: emptyMetadata() as EditableMetadata
});

/** Opens the editor on the selection, with the values its tracks share. */
export function openEditor(): void {
  const tracks = selectedTracks.value.data;
  if (tracks.length === 0) {
    return;
  }
  editor.form = computeCommonMetadata(tracks);
  library.errorMessage = null;
  ui.editModalOpen = true;
}

export function closeEditor(): void {
  ui.editModalOpen = false;
}

/**
 * Writes the form to every selected track: a field the selection varied in
 * and the form left empty keeps each track's own value (see mergeDraft). Each
 * file gets its new tags and checksums, `.meta/` is written once at the end,
 * and the library takes the new tracks. Says what was saved, or why not, and
 * closes the editor when it worked.
 */
export async function saveEdits(): Promise<void> {
  const root = activeRoot.value.data;
  const tracks = selectedTracks.value.data;
  if (!root || tracks.length === 0 || library.saving) {
    return;
  }

  const draft: EditableMetadata = { ...$toRaw(editor).form };
  library.saving = true;
  library.errorMessage = null;
  library.infoMessage = null;

  try {
    const varied = getVariedFields(tracks);
    const nextRecords = { ...root.metaSnapshot.tracks };
    const saved = new Map<string, Mp3Track>();

    for (const track of tracks) {
      const metadata = mergeDraft(track.metadata, draft, varied);
      const bytes = await writeTrackMetadataToBytes(await root.vfs.read(track.relativePath), metadata);
      await root.vfs.write(track.relativePath, bytes);
      const { fullChecksum, audioChecksum } = await calculateDualChecksums(bytes);
      const nowIso = new Date().toISOString();
      const lastModified = Date.now();
      const checked = { checksum: fullChecksum, fullChecksum, audioChecksum, size: bytes.byteLength, lastModified, lastVerifiedAt: nowIso, metadata };

      nextRecords[track.relativePath] = { ...checked, updatedAt: nowIso };
      saved.set(track.id, { ...track, ...checked });
    }

    const snapshot: MetaSnapshot = { ...root.metaSnapshot, tracks: nextRecords };
    await writeMetaSnapshot(root.vfs, snapshot);

    updateRoots((roots) =>
      roots.map((item) =>
        item.id === root.id ? { ...item, metaSnapshot: snapshot, tracks: item.tracks.map((one) => saved.get(one.id) ?? one) } : item
      )
    );

    const target = tracks.length === 1 ? tracks[0].name : tn("tracks.count", tracks.length);
    library.infoMessage = t("message.saved", { target });
    ui.editModalOpen = false;
  } catch (error) {
    library.errorMessage = error instanceof Error ? error.message : t("message.saveFailed");
  } finally {
    library.saving = false;
  }
}
