// Each artist's picture (RECORD/2026-11-03.deck-design-system.WIP.md, 23): no tag of any file, but
// the folder's own, in its `.meta/` (`MetaSnapshot.artists`, the bytes in `.meta/covers/` with the
// albums' covers, lib/covers.ts). Chosen and removed from the details' breadcrumb while it shows an
// artist (views/album-sheet.html); drawn round in the artist rows and beside their name.

import { $toRaw } from "jq79";
import { artistName } from "../helpers/views";
import { internCoverBytes } from "./covers";
import { t } from "./i18n";
import { library } from "./library";
import { flushMeta } from "./meta";
import { updateRoots } from "./roots";

/**
 * Gives `artist` in the root `rootId` a picture (`file`, an image: the dialog's crop), or takes it
 * away (`null`); then the folder's `.meta/` is written. A root that cannot be written (an iPod, a
 * folder Safari reads) keeps it for the session. Says why when the picture cannot be read or kept.
 */
export async function setArtistPicture(rootId: string, artist: string, file: Blob | null): Promise<void> {
  const key = artistName(artist);
  let ref: string | null = null;
  if (file) {
    if (!file.type.startsWith("image/")) return;
    try {
      ref = internCoverBytes({ mime: file.type, data: new Uint8Array(await file.arrayBuffer()) });
    } catch {
      library.errorMessage = t("artist.pictureFailed");
      return;
    }
  }
  updateRoots((roots) =>
    roots.map((root) => {
      if (root.id !== rootId) return root;
      const artists = { ...(root.metaSnapshot.artists ?? {}) };
      if (ref) artists[key] = ref;
      else delete artists[key];
      return { ...root, metaSnapshot: { ...root.metaSnapshot, artists } };
    })
  );
  const root = $toRaw(library).roots.find((item) => item.id === rootId);
  if (!root || root.source.readOnly) return;
  await flushMeta(rootId).catch(() => {
    library.errorMessage = t("artist.pictureNotKept");
  });
}
