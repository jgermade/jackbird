// How far a write over several files has gone (saving the edit dialog's tags, renaming): the file
// being written, and which of how many, for the dialog's foot to say (views/selection-dialog.html).
// See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-15).

import { $reactive } from "jq79";

/** The file being written (`name`), the `at`-th (from 1) of `total`; `total` 0 when none is. */
export const writing = $reactive({ at: 0, total: 0, name: "" });

/** The `at`-th file (from 1) of `total` is being written: `name`. */
export function writingFile(at: number, total: number, name: string): void {
  writing.at = at;
  writing.total = total;
  writing.name = name;
}

/** Nothing is being written any more. */
export function doneWriting(): void {
  writing.at = 0;
  writing.total = 0;
  writing.name = "";
}
