import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CodeviaSession, RuntimeToolExecutorContext } from "../../../../src/runtime/runtimeTypes";

/** Tiny temp-workspace helper shared by the tool test files. */
export interface TestWorkspace {
  readonly root: string;
  write(relativePath: string, content: string): Promise<void>;
  read(relativePath: string): Promise<string>;
  absolute(relativePath: string): string;
  cleanup(): Promise<void>;
}

export async function makeWorkspace(files: Record<string, string> = {}): Promise<TestWorkspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-tool-"));
  const absolute = (relativePath: string): string => path.join(root, relativePath);

  for (const [relativePath, content] of Object.entries(files)) {
    const target = absolute(relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }

  return {
    root,
    absolute,
    async write(relativePath, content) {
      const target = absolute(relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    },
    read: (relativePath) => fs.readFile(absolute(relativePath), "utf8"),
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export function makeSession(workspacePath: string): CodeviaSession {
  const now = new Date();
  return {
    sessionId: "s1",
    provider: "ollama",
    workspacePath,
    status: "RUNNING",
    createdAt: now,
    updatedAt: now,
  };
}

export function makeContext(
  workspacePath: string,
  signal?: AbortSignal,
): RuntimeToolExecutorContext {
  return {
    session: makeSession(workspacePath),
    ...(signal ? { signal } : {}),
  };
}
