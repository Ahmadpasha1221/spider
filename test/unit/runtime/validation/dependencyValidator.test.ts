import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateDependencies } from "../../../../src/runtime/validation/dependencyValidator";

describe("DependencyValidator", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function createFixtureWorkspace(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spider-dep-test-"));
    dirs.push(dir);
    return dir;
  }

  it("passes for Node.js built-ins and relative imports", async () => {
    const root = await createFixtureWorkspace();
    const code = `
      import * as fs from "node:fs";
      import * as path from "path";
      import { helper } from "./helper";
    `;
    const result = await validateDependencies(root, "src/index.ts", code);
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("warns when imported package is missing from package.json", async () => {
    const root = await createFixtureWorkspace();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: {} }));

    const code = `import axios from "axios";`;
    const result = await validateDependencies(root, "src/api.ts", code);
    expect(result.valid).toBe(true); // Warnings do not invalidate file
    expect(result.diagnostics[0]?.message).toContain('Package "axios" is imported but not listed in package.json');
  });

  it("detects unexported symbols like cubicBezier from framer-motion", async () => {
    const root = await createFixtureWorkspace();
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "framer-motion": "^11.0.0" } }),
    );

    // Mock installed framer-motion in node_modules
    const motionDir = path.join(root, "node_modules", "framer-motion");
    await fs.mkdir(motionDir, { recursive: true });
    await fs.writeFile(
      path.join(motionDir, "package.json"),
      JSON.stringify({
        name: "framer-motion",
        version: "11.0.0",
        types: "./dist/index.d.ts",
      }),
    );
    await fs.mkdir(path.join(motionDir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(motionDir, "dist", "index.d.ts"),
      `
        export declare const motion: any;
        export declare const AnimatePresence: any;
      `,
    );

    const code = `import { motion, cubicBezier } from "framer-motion";`;
    const result = await validateDependencies(root, "src/Component.tsx", code);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes('does not export member "cubicBezier"'))).toBe(true);
  });
});
