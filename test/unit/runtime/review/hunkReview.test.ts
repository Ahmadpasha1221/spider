import { describe, expect, it } from "vitest";
import { buildHunkLenses, revertHunk } from "../../../../src/runtime/review/hunkReview";

describe("hunk review (A4)", () => {
  const before = [
    "line one",
    "line two",
    "line three",
    "line four",
    "line five",
    "line six",
    "line seven",
    "line eight",
    "line nine",
    "line ten",
  ].join("\n");

  it("reports one lens per changed hunk", () => {
    const current = before.replace("line two", "line TWO");
    const lenses = buildHunkLenses(before, current);
    expect(lenses).toHaveLength(1);
    expect(lenses[0]!.startLine).toBeGreaterThan(0);
    expect(lenses[0]!.endLine).toBeGreaterThanOrEqual(lenses[0]!.startLine);
  });

  it("reverts a single hunk and leaves the others intact", () => {
    const current = [
      before.replace("line two", "line TWO"),
    ][0]!
      .replace("line nine", "line NINE");
    // Two separated edits → two hunks.
    const lenses = buildHunkLenses(before, current);
    expect(lenses.length).toBe(2);

    const reverted = revertHunk(before, current, 0);
    expect(reverted).toContain("line two");
    expect(reverted).not.toContain("line TWO");
    // The later, unrelated change is untouched.
    expect(reverted).toContain("line NINE");
  });

  it("reverts a pure addition hunk", () => {
    const current = before.replace("line five", "line five\ninserted line");
    const reverted = revertHunk(before, current, 0);
    expect(reverted).toBe(before);
  });

  it("reverts a pure deletion hunk", () => {
    const current = before.replace("line four\n", "");
    const reverted = revertHunk(before, current, 0);
    expect(reverted).toBe(before);
  });

  it("reverts a replacement hunk", () => {
    const current = before.replace("line two\nline three", "line deuxtrois");
    const reverted = revertHunk(before, current, 0);
    expect(reverted).toBe(before);
  });

  it("is a no-op for an out-of-range hunk index", () => {
    const current = before.replace("line two", "line TWO");
    expect(revertHunk(before, current, 99)).toBe(current);
  });

  it("is a no-op when there is no diff", () => {
    expect(revertHunk(before, before, 0)).toBe(before);
  });

  it("preserves a trailing newline and CRLF endings", () => {
    const crlfBefore = "a\r\nb\r\nc\r\n";
    const crlfCurrent = "a\r\nB\r\nc\r\n";
    const reverted = revertHunk(crlfBefore, crlfCurrent, 0);
    expect(reverted).toBe(crlfBefore);
  });

  it("returns no lenses for identical content", () => {
    expect(buildHunkLenses(before, before)).toEqual([]);
  });
});
