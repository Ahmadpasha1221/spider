import { computeLineDiff } from "./lineDiff";

/**
 * Per-hunk review for the editor-integrated diff (A4).
 *
 * The agent's edit is already applied to disk, so "accept" is implicit and
 * "reject" is the only operation that mutates the file. This module is the
 * pure, testable core: it computes where each hunk lives in the *current*
 * document and can revert exactly one hunk back to the pre-change content,
 * leaving every other hunk untouched.
 *
 * It works from raw before/current text (not the summary), so it also works
 * when the user has hand-edited the file since the agent ran: the diff is
 * recomputed against the live content and a hunk is only offered where the
 * change is still present.
 */

export interface HunkLens {
  /** Index into the diff hunk list for this before/current pair. */
  readonly index: number;
  /** Unified-diff header, shown as the lens title suffix. */
  readonly header: string;
  /** 1-based first line of the hunk on the current side. */
  readonly startLine: number;
  /** 1-based last line of the hunk on the current side. */
  readonly endLine: number;
}

/** Where to place per-hunk lenses, given the raw before/current text. */
export function buildHunkLenses(before: string, current: string): HunkLens[] {
  const hunks = computeLineDiff(before, current);
  const lenses: HunkLens[] = [];
  hunks.forEach((hunk, index) => {
    const newSide = hunk.lines.filter((line) => line.type !== "del" && line.newLine !== undefined);
    if (newSide.length === 0) {
      // A deletion with no captured context cannot be placed safely; skip it
      // rather than offering a lens that would revert the wrong lines.
      return;
    }
    const start = Math.min(...newSide.map((line) => line.newLine as number));
    const end = Math.max(...newSide.map((line) => line.newLine as number));
    lenses.push({ index, header: hunk.header, startLine: start, endLine: end });
  });
  return lenses;
}

/**
 * Reverts a single hunk in `current` back to the corresponding lines in
 * `before`. Returns `current` unchanged when the hunk no longer exists (the
 * file changed underneath the review, or the index is out of range).
 *
 * The hunk's current-side span is replaced with its before-side lines (context
 * plus deletions, in original order). Context lines are identical on both
 * sides, so replacing them is a no-op; only the real change moves back.
 */
export function revertHunk(before: string, current: string, hunkIndex: number): string {
  const hunks = computeLineDiff(before, current);
  const hunk = hunks[hunkIndex];
  if (!hunk) {
    return current;
  }
  const newSide = hunk.lines.filter((line) => line.type !== "del" && line.newLine !== undefined);
  if (newSide.length === 0) {
    return current;
  }
  const firstNew = Math.min(...newSide.map((line) => line.newLine as number));
  const lastNew = Math.max(...newSide.map((line) => line.newLine as number));
  const oldSide = hunk.lines.filter((line) => line.type !== "add").map((line) => line.text);

  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingEol = /\r?\n$/.test(current);
  const lines = splitLines(current);
  const updated = [
    ...lines.slice(0, firstNew - 1),
    ...oldSide,
    ...lines.slice(lastNew),
  ];
  const joined = updated.join(eol);
  return hadTrailingEol && updated.length > 0 ? `${joined}${eol}` : joined;
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(/\r\n|\r|\n/);
  // A trailing newline terminates the last line; it does not start a new one.
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}
