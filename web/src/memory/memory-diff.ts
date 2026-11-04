/**
 * Side-by-side diff support for two memory versions. The service serves each
 * version's content; comparing is a presentation concern, so the comparison
 * lives here and never asks the backend for a rendered diff.
 */

export type DiffKind = "same" | "removed" | "added";

export interface DiffRow {
  kind: DiffKind;
  text: string;
}

export interface SideBySideDiff {
  base: DiffRow[];
  target: DiffRow[];
}

/** Marks which indices of `a` and `b` belong to one longest common subsequence. */
function longestCommonSubsequence(a: string[], b: string[]): { a: boolean[]; b: boolean[] } {
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const matchedA = new Array<boolean>(a.length).fill(false);
  const matchedB = new Array<boolean>(b.length).fill(false);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      matchedA[i] = true;
      matchedB[j] = true;
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return { a: matchedA, b: matchedB };
}

function coalesce(parts: Array<{ kind: DiffKind; text: string }>): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const part of parts) {
    const previous = rows[rows.length - 1];
    if (previous && previous.kind === part.kind) previous.text += part.text;
    else rows.push({ ...part });
  }
  return rows;
}

/**
 * Word-level comparison for the `statement`, which is usually one paragraph:
 * both sides keep their full text, with the tokens absent from the other side
 * marked so the change reads in place.
 */
export function diffWords(base: string, target: string): SideBySideDiff {
  if (base === target)
    return { base: [{ kind: "same", text: base }], target: [{ kind: "same", text: target }] };
  // Keep whitespace so reconstructed text stays readable; mark only the tokens.
  const split = (value: string): string[] => value.split(/(\s+)/).filter((token) => token !== "");
  const baseTokens = split(base);
  const targetTokens = split(target);
  const matched = longestCommonSubsequence(baseTokens, targetTokens);
  return {
    base: coalesce(
      baseTokens.map((text, index) => ({ kind: matched.a[index] ? "same" : "removed", text })),
    ),
    target: coalesce(
      targetTokens.map((text, index) => ({ kind: matched.b[index] ? "same" : "added", text })),
    ),
  };
}

/**
 * Line-level comparison for `preconditions`, where one entry is one unit. A
 * precondition that disappeared is marked on the base side and one that is new
 * is marked on the target side; unchanged entries render on both.
 */
export function diffLines(base: string[], target: string[]): SideBySideDiff {
  const matched = longestCommonSubsequence(base, target);
  return {
    base: base.map((text, index) => ({ kind: matched.a[index] ? "same" : "removed", text })),
    target: target.map((text, index) => ({ kind: matched.b[index] ? "same" : "added", text })),
  };
}
