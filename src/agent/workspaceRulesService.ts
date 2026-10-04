import * as vscode from "vscode";
import { RULES_FILE_NAME, loadRulesContext } from "../runtime/rules/workspaceRules";

/**
 * VS Code side of workspace rules: the `spider.rules.enabled`
 * toggle, a discovery cache, and live reload when a
 * `.spiderrules` file changes. Exposed as the `rulesLoader`
 * injected into RuntimeManager, so the runtime itself stays
 * VS Code-free and unit-testable.
 *
 * Cache strategy: a global revision counter bumps on any
 * rules-file event (or the setting changing); entries are
 * keyed by workspace + revision, so a changed file simply
 * recomputes on the next run. Discovery is bounded
 * (`.spiderrules` files are tiny), so recomputation is cheap.
 */
export class WorkspaceRulesService implements vscode.Disposable {
  private readonly cache = new Map<string, string | undefined>();
  private revision = 0;
  private readonly watcher: vscode.FileSystemWatcher | undefined;
  private readonly configListener: vscode.Disposable | undefined;

  constructor() {
    try {
      this.watcher = vscode.workspace.createFileSystemWatcher(`**/${RULES_FILE_NAME}`);
      this.watcher.onDidChange(() => this.invalidate());
      this.watcher.onDidCreate(() => this.invalidate());
      this.watcher.onDidDelete(() => this.invalidate());
    } catch {
      // Watchers are an optimization: without one, rules are
      // discovered per run (still correct, just uncached).
      this.watcher = undefined;
    }
    try {
      this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("spider.rules.enabled")) {
          this.invalidate();
        }
      });
    } catch {
      this.configListener = undefined;
    }
  }

  /**
   * The formatted rules context for a workspace, or undefined
   * when rules are disabled or none exist. Never throws:
   * rules must not be able to break a run.
   */
  async getRulesContext(workspacePath: string): Promise<string | undefined> {
    try {
      const enabled = vscode.workspace
        .getConfiguration("spider")
        .get<boolean>("rules.enabled", true);
      if (!enabled) {
        return undefined;
      }
      const cacheKey = `${workspacePath}@${this.revision}`;
      if (this.cache.has(cacheKey)) {
        return this.cache.get(cacheKey);
      }
      const context = await loadRulesContext(workspacePath);
      this.cache.set(cacheKey, context);
      return context;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    this.watcher?.dispose();
    this.configListener?.dispose();
    this.cache.clear();
  }

  private invalidate(): void {
    this.revision += 1;
    this.cache.clear();
  }
}
