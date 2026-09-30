import { describe, expect, it } from "vitest";
import { listSymbols, parseScope, MAX_SYMBOLS, type SymbolToolDeps } from "../../../../src/runtime/tools/symbolTools";
import type { LanguageSource, SymbolEntry } from "../../../../src/runtime/lsp/languageSource";

function makeSymbols(): SymbolEntry[] {
  return [
    {
      name: "RuntimeManager",
      kind: "class",
      path: "src/runtime/runtimeManager.ts",
      range: { start: { line: 10, character: 0 }, end: { line: 240, character: 1 } },
      children: [
        {
          name: "startTask",
          kind: "method",
          path: "src/runtime/runtimeManager.ts",
          range: { start: { line: 20, character: 2 }, end: { line: 40, character: 3 } },
        },
      ],
    },
  ];
}

function sourceWith(
  overrides: Partial<LanguageSource>,
  calls: { document: number; workspace: number } = { document: 0, workspace: 0 },
): LanguageSource {
  return {
    documentSymbols: async () => {
      calls.document += 1;
      return overrides.documentSymbols ? overrides.documentSymbols({ absolutePath: "x" }) : [];
    },
    workspaceSymbols: async () => {
      calls.workspace += 1;
      return overrides.workspaceSymbols ? overrides.workspaceSymbols({ query: "q", workspacePath: "w", max: 10 }) : [];
    },
    definitions: async () => [],
    references: async () => [],
  };
}

const CTX = { workspacePath: "/ws" };

describe("list_symbols", () => {
  it("returns document symbols with workspace-relative paths", async () => {
    const deps: SymbolToolDeps = { language: sourceWith({ documentSymbols: async () => makeSymbols() }) };
    const result = await listSymbols({ scope: "document", path: "src/runtime/runtimeManager.ts" }, CTX, deps);
    expect(result.scope).toBe("document");
    expect(result.path).toBe("src/runtime/runtimeManager.ts");
    expect(result.truncated).toBe(false);
    expect(result.symbols[0]).toMatchObject({ name: "RuntimeManager", kind: "class" });
    expect(result.symbols[0]?.children?.[0]?.name).toBe("startTask");
  });

  it("defaults to document scope and reports no symbols cleanly", async () => {
    const deps: SymbolToolDeps = { language: sourceWith({ documentSymbols: async () => [] }) };
    const result = await listSymbols({ path: "empty.ts" }, CTX, deps);
    expect(result.symbols).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("rejects document scope without a path and an invalid scope", async () => {
    const deps: SymbolToolDeps = { language: sourceWith({}) };
    await expect(listSymbols({}, CTX, deps)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(listSymbols({ scope: "galaxy", path: "a.ts" }, CTX, deps)).rejects.toMatchObject({ code: "invalid_input" });
    expect(parseScope(undefined)).toBe("document");
    expect(parseScope("workspace")).toBe("workspace");
  });

  it("keeps workspace scope bounded and reports truncation", async () => {
    const many: SymbolEntry[] = Array.from({ length: MAX_SYMBOLS + 5 }, (_v, i) => ({
      name: `sym${i}`,
      kind: "function",
      path: `src/f${i}.ts`,
      range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
    }));
    const deps: SymbolToolDeps = { language: sourceWith({ workspaceSymbols: async () => many }) };
    const result = await listSymbols({ scope: "workspace", query: "sym" }, CTX, deps);
    expect(result.symbols).toHaveLength(MAX_SYMBOLS);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBe("max_symbols");
  });

  it("rejects a workspace escape and reports dependency-unavailable", async () => {
    const created = await (await import("./toolTestUtils")).makeWorkspace({ "a.ts": "x\n" });
    const deps: SymbolToolDeps = { language: sourceWith({}) };
    await expect(listSymbols({ scope: "document", path: "../../etc/passwd" }, { workspacePath: created.root }, deps)).rejects.toMatchObject({
      code: "workspace_violation",
    });
    await expect(listSymbols({ path: "a.ts" }, CTX, {})).rejects.toMatchObject({ code: "dependency_unavailable" });
    await created.cleanup();
  });

  it("honours a pre-aborted signal without calling providers", async () => {
    const calls = { document: 0, workspace: 0 };
    const deps: SymbolToolDeps = { language: sourceWith({}, calls) };
    const controller = new AbortController();
    controller.abort();
    await expect(listSymbols({ path: "a.ts" }, { workspacePath: "/ws", signal: controller.signal }, deps)).rejects.toMatchObject({
      code: "cancelled",
    });
    await expect(
      listSymbols({ scope: "workspace" }, { workspacePath: "/ws", signal: controller.signal }, deps),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(calls.document).toBe(0);
    expect(calls.workspace).toBe(0);
  });
});
