import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface DiscoveredProjectValidation {
  readonly hasTsConfig: boolean;
  readonly typecheckCommand?: string;
  readonly lintCommand?: string;
  readonly testCommand?: string;
  readonly buildCommand?: string;
  readonly packageManager: "pnpm" | "npm" | "yarn";
}

export async function discoverProjectValidation(workspacePath: string): Promise<DiscoveredProjectValidation> {
  let packageManager: "pnpm" | "npm" | "yarn" = "npm";
  try {
    await fs.access(path.join(workspacePath, "pnpm-lock.yaml"));
    packageManager = "pnpm";
  } catch {
    try {
      await fs.access(path.join(workspacePath, "yarn.lock"));
      packageManager = "yarn";
    } catch {
      packageManager = "npm";
    }
  }

  let hasTsConfig = false;
  try {
    await fs.access(path.join(workspacePath, "tsconfig.json"));
    hasTsConfig = true;
  } catch {
    hasTsConfig = false;
  }

  let scripts: Record<string, string> = {};
  try {
    const raw = await fs.readFile(path.join(workspacePath, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    scripts = parsed.scripts ?? {};
  } catch {
    scripts = {};
  }

  const runPrefix = packageManager === "npm" ? "npm run" : packageManager;

  const typecheckCommand = scripts.typecheck
    ? `${runPrefix} typecheck`
    : hasTsConfig
      ? "npx tsc --noEmit"
      : undefined;

  const lintCommand = scripts.lint ? `${runPrefix} lint` : undefined;
  const testCommand = scripts.test ? (packageManager === "npm" ? "npm test" : `${packageManager} test`) : undefined;
  const buildCommand = scripts.build ? `${runPrefix} build` : undefined;

  return {
    hasTsConfig,
    typecheckCommand,
    lintCommand,
    testCommand,
    buildCommand,
    packageManager,
  };
}
