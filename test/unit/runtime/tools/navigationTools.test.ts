import { describe, expect, it } from "vitest";
import {
  findReferences,
  goToDefinition,
  parsePosition,
  MAX_DEFINITIONS,
  MAX_REFERENCES,
} from "../../../../src/runtime/tools/navigationTools";
import type { LanguageSource, LocationEntry } from "../../../../src/runtime/lsp/languageSource";

const LOCATION_A: LocationEntry = {
  path: "src/runtime/runtimeManager.ts",
  range: { start: { line: 12, character: 2 }, end: { line: 12, character: 20 } },
};
const LOCATION_B: LocationEntry = {
  path: "src/runtime/tools/toolRouter.ts",
  range: { start: { line: 3, character: 9 }, end: { line: 3, character: 21 } },
};

function sourceWith(overrides: Partial<LanguageSource>): LanguageSource {
  return {
    documentSymbols: async () => [],
    workspaceSymbols: async () => [],
    definitions: async () => overrides.definitions ? overrides.definitions({ absolutePath: "a" } as never) : [],
    references: async () => overrides.references ? overrides.references({ absolutePath: "a" } as never) : [],
  };
}

const CTX = { workspacePath: "/ws" };
const DEPS = { language: sourceWith({}) };

describe("go_to_definition", () => {
  it("resolves a definition at a position", async () => {
    const deps = { language: sourceWith({ definitions: async () => [LOCATION_A] }) };
    const result = await goToDefinition({ path: "src/a.ts", line: 4, character: 10 }, CTX, deps);
    expect(result.definitions).toEqual([LOCATION_A]);
    expect(result.path).toBe("src/a.ts");
    expect(result.truncated).toBeUndefined();
  });

  it("supports multiple definitions and reports none cleanly", async () => {
    const deps = { language: sourceWith({ definitions: async () => [LOCATION_A, LOCATION_B] }) };
    const many = await goToDefinition({ path: "src/a.ts", line: 0, character: 0 }, CTX, deps);
    expect(many.definitions).toHaveLength(2);

    const none = await goToDefinition({ path: "src/a.ts", line: 0, character: 0 }, CTX, DEPS);
    expect(none.definitions).toEqual([]);
    expect(none.message).toMatch(/No definition/);
  });

  it("caps definitions", async () => {
    const locations: LocationEntry[] = Array.from({ length: MAX_DEFINITIONS + 3 }, (_v, i) => ({
      path: `src/f${i}.ts`,
      range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
    }));
    const deps = { language: sourceWith({ definitions: async () => locations }) };
    const result = await goToDefinition({ path: "src/a.ts", line: 1, character: 1 }, CTX, deps);
    expect(result.definitions).toHaveLength(MAX_DEFINITIONS);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("max_definitions");
  });

  it("validates path and position and never resolves outside the workspace", async () => {
    const created = await (await import("./toolTestUtils")).makeWorkspace({ "src/a.ts": "x\n" });
    await expect(goToDefinition({}, CTX, DEPS)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(goToDefinition({ path: "src/a.ts", line: "x", character: 0 }, CTX, DEPS)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(goToDefinition({ path: "src/a.ts", line: -1, character: 0 }, CTX, DEPS)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(goToDefinition({ path: "src/a.ts", line: 0, character: -2 }, CTX, DEPS)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(goToDefinition({ path: "../../outside.ts", line: 0, character: 0 }, { workspacePath: created.root }, DEPS)).rejects.toMatchObject({
      code: "workspace_violation",
    });
    await created.cleanup();
  });

  it("honours cancellation and reports dependency-unavailable", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      goToDefinition({ path: "src/a.ts", line: 0, character: 0 }, { ...CTX, signal: controller.signal }, DEPS),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(goToDefinition({ path: "src/a.ts", line: 0, character: 0 }, CTX, {})).rejects.toMatchObject({
      code: "dependency_unavailable",
    });
  });
});

describe("find_references", () => {
  it("returns references and includes the declaration by default", async () => {
    let captured: { includeDeclaration?: boolean } | undefined;
    const language: LanguageSource = {
      ...sourceWith({}),
      references: async (query) => {
        captured = query as unknown as { includeDeclaration?: boolean };
        return [LOCATION_A, LOCATION_B];
      },
    };
    const result = await findReferences({ path: "src/a.ts", line: 0, character: 0 }, CTX, { language });
    expect(result.references).toHaveLength(2);
    expect(result.includeDeclaration).toBe(true);
    expect(captured?.includeDeclaration).toBe(true);
  });

  it("supports includeDeclaration=false and empty results", async () => {
    let captured: { includeDeclaration?: boolean } | undefined;
    const language: LanguageSource = {
      ...sourceWith({}),
      references: async (query) => {
        captured = query as unknown as { includeDeclaration?: boolean };
        return [];
      },
    };
    const result = await findReferences({ path: "src/a.ts", line: 0, character: 0, includeDeclaration: false }, CTX, { language });
    expect(result.includeDeclaration).toBe(false);
    expect(captured?.includeDeclaration).toBe(false);
    expect(result.references).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("caps references and reports truncation", async () => {
    const locations: LocationEntry[] = Array.from({ length: MAX_REFERENCES + 1 }, (_v, i) => ({
      path: `src/f${i}.ts`,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }));
    const deps = { language: sourceWith({ references: async () => locations }) };
    const result = await findReferences({ path: "src/a.ts", line: 0, character: 0 }, CTX, deps);
    expect(result.references).toHaveLength(MAX_REFERENCES);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("max_references");
  });

  it("validates path/position and the workspace boundary", async () => {
    const created = await (await import("./toolTestUtils")).makeWorkspace({ "src/a.ts": "x\n" });
    await expect(findReferences({}, CTX, DEPS)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(findReferences({ path: "src/a.ts", line: 0 }, CTX, DEPS)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      findReferences({ path: "../../outside.ts", line: 0, character: 0 }, { workspacePath: created.root }, DEPS),
    ).rejects.toMatchObject({ code: "workspace_violation" });
    await created.cleanup();
  });

  it("parses positions strictly", () => {
    expect(parsePosition({ line: 3, character: 7 })).toEqual({ line: 3, character: 7 });
    expect(() => parsePosition({ line: "3", character: 0 })).toThrowError(/line/);
    expect(() => parsePosition({ line: -1, character: 0 })).toThrowError(/line/);
    expect(parsePosition({ line: 1.9, character: 2.5 })).toEqual({ line: 1, character: 2 });
  });
});
