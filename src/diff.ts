export type DiffKind = "same" | "removed" | "added";

export interface DiffPart {
  kind: DiffKind;
  text: string;
}

export interface WordDiff {
  before: DiffPart[];
  after: DiffPart[];
}

/** A cheap guard against pathological inputs. Word diffs are for prose, not dumps. */
const MAX_TOKENS = 1_200;

function tokens(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

function merge(parts: DiffPart[]): DiffPart[] {
  const merged: DiffPart[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    const last = merged[merged.length - 1];
    if (last && last.kind === part.kind) {
      last.text += part.text;
    } else {
      merged.push({ ...part });
    }
  }
  return merged;
}

/**
 * A word-level diff using a longest-common-subsequence alignment.
 *
 * This is deliberately small and deterministic. Very large inputs fall back to
 * one removed block and one added block rather than allocating a huge matrix.
 */
export function wordDiff(before: string, after: string): WordDiff {
  if (before === after) {
    return {
      before: merge([{ kind: "same", text: before }]),
      after: merge([{ kind: "same", text: after }]),
    };
  }

  const left = tokens(before);
  const right = tokens(after);
  if (left.length === 0 || right.length === 0) {
    return {
      before: before ? [{ kind: "removed", text: before }] : [],
      after: after ? [{ kind: "added", text: after }] : [],
    };
  }
  if (left.length > MAX_TOKENS || right.length > MAX_TOKENS) {
    return {
      before: [{ kind: "removed", text: before }],
      after: [{ kind: "added", text: after }],
    };
  }

  const rows = left.length + 1;
  const columns = right.length + 1;
  const table = Array.from({ length: rows }, () => new Uint32Array(columns));

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        left[i] === right[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const operations: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      operations.push({ kind: "same", text: left[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      operations.push({ kind: "removed", text: left[i] });
      i += 1;
    } else {
      operations.push({ kind: "added", text: right[j] });
      j += 1;
    }
  }
  while (i < left.length) {
    operations.push({ kind: "removed", text: left[i] });
    i += 1;
  }
  while (j < right.length) {
    operations.push({ kind: "added", text: right[j] });
    j += 1;
  }

  const beforeParts: DiffPart[] = [];
  const afterParts: DiffPart[] = [];
  for (const operation of operations) {
    if (operation.kind === "same") {
      beforeParts.push(operation);
      afterParts.push(operation);
    } else if (operation.kind === "removed") {
      beforeParts.push(operation);
    } else {
      afterParts.push(operation);
    }
  }

  return { before: merge(beforeParts), after: merge(afterParts) };
}
