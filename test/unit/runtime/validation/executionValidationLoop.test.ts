import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodeviaSession } from "../../../../src/runtime/runtimeTypes";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import { ToolRouter } from "../../../../src/runtime/tools/toolRouter";
import { ValidationGate } from "../../../../src/runtime/validation/validationGate";
import { SourceTracingManager } from "../../../../src/runtime/validation/sourceTracing";

describe("Execution Validation Loop (Phase 17 Verification Cases)", () => {
  const dirs: string[] = [];

  beforeEach(() => {
    SourceTracingManager.resetForTesting();
  });

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function createWorkspace(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-loop-test-"));
    dirs.push(dir);
    return dir;
  }

  function createSession(workspacePath: string): CodeviaSession {
    const now = new Date();
    return {
      sessionId: "test-session",
      provider: "mock",
      workspacePath,
      status: "RUNNING",
      createdAt: now,
      updatedAt: now,
    };
  }

  // CASE 1: Valid generated code -> write -> validate -> verified
  it("CASE 1: Valid generated code writes, validates, and allows finish", async () => {
    const root = await createWorkspace();
    const executor = new WorkspaceToolExecutor();
    const router = new ToolRouter(executor);
    const gate = new ValidationGate();
    const session = createSession(root);
    const context = { session, validationGate: gate };
    const auth = async () => ({ allowed: true });

    const validCode = `export const Header = () => <header><h1>Title</h1></header>;`;
    const writeResponse = await router.route(
      { id: "c1", name: "write_file", input: { path: "src/Header.tsx", content: validCode } },
      context,
      auth,
    );

    expect(writeResponse.allowed).toBe(true);
    expect(writeResponse.result.success).toBe(true);
    expect(writeResponse.result.writeSucceeded).toBe(true);
    expect(writeResponse.result.syntaxValid).toBe(true);

    // File should be verified in gate
    expect(gate.getFileRecord("src/Header.tsx")?.status).toBe("verified");

    // finish tool should succeed
    const finishResponse = await router.route(
      { id: "c2", name: "finish", input: { summary: "Header created" } },
      context,
      auth,
    );
    expect(finishResponse.allowed).toBe(true);
    expect(finishResponse.finished).toBe(true);
  });

  // CASE 2: Invalid generated code -> write -> validation fails -> agent receives diagnostics -> repair -> validation passes -> verified
  it("CASE 2: Invalid generated code fails validation, provides diagnostics, and verifies upon repair", async () => {
    const root = await createWorkspace();
    const executor = new WorkspaceToolExecutor();
    const router = new ToolRouter(executor);
    const gate = new ValidationGate();
    const session = createSession(root);
    const context = { session, validationGate: gate };
    const auth = async () => ({ allowed: true });

    // Step A: Write corrupted code with broken JSX attribute: className={\destination-card \}
    const corruptedCode = `export const Card = () => <div className={\\destination-card \\}>Bad</div>;`;
    const badWriteResponse = await router.route(
      { id: "c1", name: "write_file", input: { path: "src/Card.tsx", content: corruptedCode } },
      context,
      auth,
    );

    expect(badWriteResponse.result.success).toBe(false);
    expect(badWriteResponse.result.syntaxValid).toBe(false);
    expect(badWriteResponse.result.diagnostics.length).toBeGreaterThan(0);
    expect(gate.getFileRecord("src/Card.tsx")?.status).toBe("failed");

    // Step B: Attempting to finish while file failed must be blocked by validation gate
    const prematureFinish = await router.route(
      { id: "c2", name: "finish", input: { summary: "Premature finish" } },
      context,
      auth,
    );
    expect(prematureFinish.result.success).toBe(false);
    expect(prematureFinish.finished).toBeFalsy();
    expect(prematureFinish.result.error).toContain("Validation gate blocked");

    // Step C: Repair using edit_file with valid JSX
    const repairResponse = await router.route(
      {
        id: "c3",
        name: "edit_file",
        input: {
          path: "src/Card.tsx",
          old_string: `className={\\destination-card \\}`,
          new_string: `className="destination-card"`,
        },
      },
      context,
      auth,
    );

    expect(repairResponse.result.success).toBe(true);
    expect(repairResponse.result.syntaxValid).toBe(true);
    expect(gate.getFileRecord("src/Card.tsx")?.status).toBe("verified");

    // Step D: Calling finish now succeeds
    const finishResponse = await router.route(
      { id: "c4", name: "finish", input: { summary: "Card fixed" } },
      context,
      auth,
    );
    expect(finishResponse.allowed).toBe(true);
    expect(finishResponse.finished).toBe(true);
  });

  // CASE 3: Invalid generated code -> repair attempt 1 fails -> repair attempt 2 fails -> repair attempt 3 fails -> blocked
  it("CASE 3: Bounded repairs exceed limit and halt state machine as blocked", async () => {
    const root = await createWorkspace();
    const executor = new WorkspaceToolExecutor();
    const router = new ToolRouter(executor);
    const gate = new ValidationGate();
    const session = createSession(root);
    const context = { session, validationGate: gate };
    const auth = async () => ({ allowed: true });

    // Initial write fails
    await router.route(
      { id: "c1", name: "write_file", input: { path: "src/bad.ts", content: "const a = 'broken\u0000';" } },
      context,
      auth,
    );
    expect(gate.getFileRecord("src/bad.ts")?.repairAttempts).toBe(1);

    // Repair attempt 2 fails
    await router.route(
      { id: "c2", name: "write_file", input: { path: "src/bad.ts", content: "const a = 'broken\u0001';" } },
      context,
      auth,
    );
    expect(gate.getFileRecord("src/bad.ts")?.repairAttempts).toBe(2);

    // Repair attempt 3 fails
    await router.route(
      { id: "c3", name: "write_file", input: { path: "src/bad.ts", content: "const a = 'broken\u0002';" } },
      context,
      auth,
    );
    expect(gate.getFileRecord("src/bad.ts")?.repairAttempts).toBe(3);

    // Repair attempt 4 fails -> exceeds MAX_REPAIR_ATTEMPTS (3)
    const fatalResponse = await router.route(
      { id: "c4", name: "write_file", input: { path: "src/bad.ts", content: "const a = 'broken\u0003';" } },
      context,
      auth,
    );

    expect(fatalResponse.result.isBlocked).toBe(true);
    expect(gate.getStatus()).toBe("blocked");

    // Calling finish is permanently blocked
    const finishResponse = await router.route(
      { id: "c5", name: "finish", input: { summary: "Done" } },
      context,
      auth,
    );
    expect(finishResponse.result.success).toBe(false);
    expect(finishResponse.finished).toBeFalsy();
  });

  // CASE 4: Valid model output becomes corrupted during Spider processing -> instrumentation identifies boundary
  it("CASE 4: SourceTracingManager identifies exact corruption boundary", () => {
    const tracer = SourceTracingManager.getInstance();
    const sessionId = "s4";
    const file = "src/Card.tsx";

    tracer.record({ sessionId, file, boundary: "MODEL_OUTPUT_RAW", contentHash: "hashGood" });
    tracer.record({ sessionId, file, boundary: "TOOL_CALL_PARSED", contentHash: "hashGood" });
    tracer.record({ sessionId, file, boundary: "TOOL_ARGUMENT_NORMALIZED", contentHash: "hashGood" });
    // String replacement bug in tool execution alters hash:
    tracer.record({ sessionId, file, boundary: "FILE_WRITE_REQUEST", contentHash: "hashMangled" });
    tracer.record({ sessionId, file, boundary: "FILE_WRITE_COMPLETED", contentHash: "hashMangled" });

    const analysis = tracer.analyzeCorruptionPipeline(sessionId, file, true);
    expect(analysis.corrupted).toBe(true);
    expect(analysis.corruptionOrigin).toBe("TOOL_EXECUTION");
    expect(analysis.details).toContain("Corruption introduced in tool executor");
  });

  // CASE 5: Tool receives malformed input -> deterministic tool error -> no corrupted file write
  it("CASE 5: Tool receives malformed input and returns deterministic tool error without writing", async () => {
    const root = await createWorkspace();
    const executor = new WorkspaceToolExecutor();
    const router = new ToolRouter(executor);
    const gate = new ValidationGate();
    const session = createSession(root);
    const context = { session, validationGate: gate };
    const auth = async () => ({ allowed: true });

    // Missing path argument
    const missingPath = await router.route(
      { id: "c1", name: "write_file", input: { content: "console.log(1);" } },
      context,
      auth,
    );
    expect(missingPath.result.success).toBe(false);
    expect(missingPath.result.error).toContain("Missing required argument: path");

    // File was not written
    const files = await fs.readdir(root);
    expect(files).toHaveLength(0);
  });

  // CASE 6: Dependency API does not exist -> validation detects it -> agent repairs using actual installed API
  it("CASE 6: Dependency API mismatch is detected and verified after repair", async () => {
    const root = await createWorkspace();
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "framer-motion": "11.0.0" } }),
    );

    // Mock installed framer-motion that exports motion but not cubicBezier
    const pkgDir = path.join(root, "node_modules", "framer-motion");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ name: "framer-motion", version: "11.0.0" }));
    await fs.writeFile(path.join(pkgDir, "index.d.ts"), "export declare const motion: any;\n");

    const executor = new WorkspaceToolExecutor();
    const router = new ToolRouter(executor);
    const gate = new ValidationGate();
    const session = createSession(root);
    const context = { session, validationGate: gate };
    const auth = async () => ({ allowed: true });

    // Attempt to write code importing nonexistent cubicBezier
    const badCode = `import { motion, cubicBezier } from "framer-motion";\nexport const x = motion.div;`;
    const badResponse = await router.route(
      { id: "c1", name: "write_file", input: { path: "src/Anim.tsx", content: badCode } },
      context,
      auth,
    );

    expect(badResponse.result.success).toBe(false);
    expect(badResponse.result.error).toContain('does not export member "cubicBezier"');

    // Repair by importing only valid exported symbol motion
    const fixedCode = `import { motion } from "framer-motion";\nexport const x = motion.div;`;
    const fixedResponse = await router.route(
      { id: "c2", name: "write_file", input: { path: "src/Anim.tsx", content: fixedCode } },
      context,
      auth,
    );

    expect(fixedResponse.result.success).toBe(true);
    expect(fixedResponse.result.syntaxValid).toBe(true);
    expect(gate.getFileRecord("src/Anim.tsx")?.status).toBe("verified");
  });
});
