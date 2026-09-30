import { describe, expect, it } from "vitest";
import type { ActiveEditorSnapshot, EditorContextSource } from "../../../../src/runtime/editor/editorContextSource";
import {
  getActiveFile,
  getSelection,
  MAX_SELECTION_CHARS,
  MAX_SELECTION_CHARS_LIMIT,
  parseMaxChars,
  type GetActiveFileResult,
  type GetSelectionResult,
} from "../../../../src/runtime/tools/editorTools";

function snapshot(overrides: Partial<ActiveEditorSnapshot> = {}): ActiveEditorSnapshot {
  return {
    languageId: "typescript",
    lineCount: 120,
    isDirty: false,
    version: 3,
    untitled: false,
    outsideWorkspace: false,
    relativePath: "src/index.ts",
    name: "index.ts",
    workspaceFolder: "spider",
    workspaceFolders: ["spider", "docs"],
    selections: [],
    ...overrides,
  };
}

function sourceFor(value: ActiveEditorSnapshot | undefined): EditorContextSource {
  return { getActiveEditor: async () => value };
}

describe("get_active_file", () => {
  it("is unavailable outside the extension host", async () => {
    await expect(getActiveFile({}, {})).rejects.toMatchObject({ code: "dependency_unavailable" });
  });

  it("reports no active editor as a structured result", async () => {
    const result = await getActiveFile({}, { editor: sourceFor(undefined) });
    expect(result).toEqual({ file: null, message: "No active editor is open." });
  });

  it("returns identity only, never file contents", async () => {
    const result = (await getActiveFile({}, { editor: sourceFor(snapshot()) })) as GetActiveFileResult;
    expect(result.file).toEqual({
      path: "src/index.ts",
      name: "index.ts",
      languageId: "typescript",
      lineCount: 120,
      isDirty: false,
      version: 3,
      workspaceFolder: "spider",
    });
    expect(result.file).not.toHaveProperty("content");
    expect(result.file).not.toHaveProperty("text");
  });

  it("includes workspace folders only when asked", async () => {
    const without = (await getActiveFile({}, { editor: sourceFor(snapshot()) })) as GetActiveFileResult;
    expect(without.workspaceFolders).toBeUndefined();

    const withFolders = (await getActiveFile(
      { includeWorkspaceFolders: true },
      { editor: sourceFor(snapshot()) },
    )) as GetActiveFileResult;
    expect(withFolders.workspaceFolders).toEqual(["spider", "docs"]);
  });

  it("propagates untitled and outside-workspace identity without a path", async () => {
    const untitled = (await getActiveFile(
      {},
      { editor: sourceFor(snapshot({ untitled: true, relativePath: undefined, name: "Untitled-1" })) },
    )) as GetActiveFileResult;
    expect(untitled.file).toMatchObject({ name: "Untitled-1", untitled: true });
    expect(untitled.file).not.toHaveProperty("path");

    const outside = (await getActiveFile(
      {},
      { editor: sourceFor(snapshot({ outsideWorkspace: true, relativePath: undefined })) },
    )) as GetActiveFileResult;
    expect(outside.file).toMatchObject({ outsideWorkspace: true });
  });
});

describe("get_selection", () => {
  const selection = (line: number, text: string) => ({
    start: { line, character: 0 },
    end: { line, character: text.length },
    text,
  });

  it("is unavailable outside the extension host", async () => {
    await expect(getSelection({}, {})).rejects.toMatchObject({ code: "dependency_unavailable" });
  });

  it("reports no active editor as a structured result", async () => {
    const result = await getSelection({}, { editor: sourceFor(undefined) });
    expect(result).toEqual({ selection: null, message: "No active editor is open." });
  });

  it("returns a single selection in the documented shape", async () => {
    const result = (await getSelection(
      {},
      { editor: sourceFor(snapshot({ selections: [selection(4, "const a = 1;")] })) },
    )) as GetSelectionResult;

    expect(result.selection).toMatchObject({
      path: "src/index.ts",
      name: "index.ts",
      start: { line: 4, column: 0 },
      end: { line: 4, column: 12 },
      text: "const a = 1;",
    });
    expect(result.selections).toBeUndefined();
  });

  it("preserves editor order for multiple selections", async () => {
    const result = (await getSelection(
      {},
      { editor: sourceFor(snapshot({ selections: [selection(1, "first"), selection(9, "second"), selection(3, "third")] })) },
    )) as GetSelectionResult;

    expect(result.selections?.map((view) => view.text)).toEqual(["first", "second", "third"]);
    expect(result.selection).toBeUndefined();
  });

  it("returns an empty text for an empty selection", async () => {
    const result = (await getSelection(
      {},
      { editor: sourceFor(snapshot({ selections: [selection(0, "")] })) },
    )) as GetSelectionResult;
    expect(result.selection?.text).toBe("");
  });

  it("redacts secret-looking text", async () => {
    const result = (await getSelection(
      {},
      { editor: sourceFor(snapshot({ selections: [selection(0, 'api_key = "supersecret"')] })) },
    )) as GetSelectionResult;
    expect(result.selection?.text).toContain("[REDACTED]");
    expect(result.selection?.text).not.toContain("supersecret");
  });

  it("returns no text at all for a sensitive file", async () => {
    const result = (await getSelection(
      {},
      { editor: sourceFor(snapshot({ relativePath: "config/.env", name: ".env", selections: [selection(0, "SECRET=abc")] })) },
    )) as GetSelectionResult;
    expect(result.selection?.text).toBe("");
    expect(result.selection?.redacted).toBe(true);
  });

  it("truncates each selection and reports it", async () => {
    const result = (await getSelection(
      { maxChars: 5 },
      { editor: sourceFor(snapshot({ selections: [selection(0, "0123456789")] })) },
    )) as GetSelectionResult;
    expect(result.selection?.text).toBe("01234");
    expect(result.selection?.truncated).toBe(true);
    expect(result.truncated).toBe(true);
  });
});

describe("parseMaxChars", () => {
  it("defaults, floors, and caps", () => {
    expect(parseMaxChars(undefined)).toBe(MAX_SELECTION_CHARS);
    expect(parseMaxChars(12)).toBe(12);
    expect(parseMaxChars(12.9)).toBe(12);
    expect(parseMaxChars(MAX_SELECTION_CHARS_LIMIT + 1000)).toBe(MAX_SELECTION_CHARS_LIMIT);
  });

  it("rejects invalid values with a typed error", () => {
    expect(() => parseMaxChars("lots")).toThrowError(/must be a number/);
    expect(() => parseMaxChars(0)).toThrowError(/at least 1/);
    try {
      parseMaxChars(0);
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
    }
  });
});
