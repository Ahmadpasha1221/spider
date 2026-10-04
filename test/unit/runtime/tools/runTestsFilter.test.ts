import { describe, expect, it } from "vitest";
import { buildTargetArgs, parseFilter, parseTestPath } from "../../../../src/runtime/tools/runTestsTool";
import { ToolExecutionError } from "../../../../src/runtime/tools/toolError";

describe("run_tests target contract", () => {
  it("maps pytest path and filter to positional + -k", () => {
    expect(buildTargetArgs("pytest", [], "/ws/tests/test_a.py", "streaming")).toEqual([
      "/ws/tests/test_a.py",
      "-k",
      "streaming",
    ]);
    expect(buildTargetArgs("pytest", [], "/ws/tests", undefined)).toEqual(["/ws/tests"]);
    expect(buildTargetArgs("pytest", [], undefined, "foo")).toEqual(["-k", "foo"]);
  });

  it("maps js runners to test -- path -t filter", () => {
    expect(buildTargetArgs("npm", [], "/ws/test/a.test.ts", "renders")).toEqual([
      "test",
      "--",
      "/ws/test/a.test.ts",
      "-t",
      "renders",
    ]);
    expect(buildTargetArgs("pnpm", [], undefined, "renders")).toEqual(["test", "--", "-t", "renders"]);
  });

  it("maps cargo filter positionally and rejects paths", () => {
    expect(buildTargetArgs("cargo", [], undefined, "streaming")).toEqual(["test", "streaming"]);
    expect(() => buildTargetArgs("cargo", [], "/ws/tests", undefined)).toThrowError(ToolExecutionError);
  });

  it("maps go filter to -run with a path default", () => {
    expect(buildTargetArgs("go", [], undefined, "TestStream")).toEqual(["test", "-run", "TestStream", "./..."]);
    expect(buildTargetArgs("go", [], "./pkg/agent", undefined)).toEqual(["test", "./pkg/agent"]);
  });

  it("python accepts a path but not a filter", () => {
    expect(buildTargetArgs("python", [], "/ws/test_a.py", undefined)).toEqual(["/ws/test_a.py"]);
    expect(() => buildTargetArgs("python3", [], undefined, "foo")).toThrowError(ToolExecutionError);
  });

  it("rejects mixing raw args with path/filter", () => {
    expect(() => buildTargetArgs("pytest", ["-x"], "/ws/a.py", undefined)).toThrowError(ToolExecutionError);
    expect(() => buildTargetArgs("go", ["test", "./..."], undefined, "Foo")).toThrowError(ToolExecutionError);
  });

  it("passes raw args through untouched when no target is given", () => {
    expect(buildTargetArgs("pytest", ["-x", "--ff"], undefined, undefined)).toEqual(["-x", "--ff"]);
  });

  it("validates the filter shape", () => {
    expect(parseFilter(undefined)).toBeUndefined();
    expect(parseFilter("")).toBeUndefined();
    expect(parseFilter("  streaming  ")).toBe("streaming");
    expect(() => parseFilter("x".repeat(201))).toThrowError(ToolExecutionError);
    expect(() => parseFilter(42)).toThrowError(ToolExecutionError);
  });

  it("validates the test path against the workspace", async () => {
    const { default: os } = await import("node:os");
    const { default: path } = await import("node:path");
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const root = await mkdtemp(path.join(os.tmpdir(), "codevia-testpath-"));
    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(path.join(root, "tests", "test_a.py"), "x");
    expect(await parseTestPath("tests/test_a.py", root)).toBe(path.join(root, "tests", "test_a.py"));
    expect(await parseTestPath(undefined, root)).toBeUndefined();
    await expect(parseTestPath("tests/missing.py", root)).rejects.toThrowError(ToolExecutionError);
    await expect(parseTestPath("../outside", root)).rejects.toThrowError(ToolExecutionError);
    await expect(parseTestPath("-x", root)).rejects.toThrowError(ToolExecutionError);
  });
});
