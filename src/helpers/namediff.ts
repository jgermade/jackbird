/**
 * What changes between a file's name and its new one, for the rename preview: both names cut into
 * words, runs of spaces and single marks, and the longest run of pieces they share kept; the rest
 * marked, removed on the old name's side and added on the new one's. See
 * RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-13 17:55).
 */

export type Piece = { text: string; changed: boolean };

const tokens = (name: string): string[] => name.match(/[\p{L}\p{N}]+|\s+|[^\p{L}\p{N}\s]/gu) ?? [];

/**
 * Neighbouring pieces of the same kind as one; a space kept between two changes counts as changed,
 * so "Biffy Clyro" reads as one change, not two around a shared space.
 */
function joined(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  const marked = pieces.map((piece, at) =>
    !piece.changed && /^\s+$/.test(piece.text) && pieces[at - 1]?.changed && pieces[at + 1]?.changed ? { ...piece, changed: true } : piece
  );
  for (const piece of marked) {
    const last = out[out.length - 1];
    if (last && last.changed === piece.changed) last.text += piece.text;
    else out.push({ ...piece });
  }
  return out;
}

/** The old name's pieces (`changed`: removed) and the new one's (`changed`: added). */
export function nameDiff(before: string, after: string): { before: Piece[]; after: Piece[] } {
  const a = tokens(before);
  const b = tokens(after);
  // The longest common run of tokens, by the usual table (names are short).
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const left: Piece[] = [];
  const right: Piece[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      left.push({ text: a[i], changed: false });
      right.push({ text: b[j], changed: false });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      left.push({ text: a[i], changed: true });
      i += 1;
    } else {
      right.push({ text: b[j], changed: true });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) left.push({ text: a[i], changed: true });
  for (; j < b.length; j += 1) right.push({ text: b[j], changed: true });
  return { before: joined(left), after: joined(right) };
}
