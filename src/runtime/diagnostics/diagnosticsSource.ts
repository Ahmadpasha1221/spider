import type * as vscode from "vscode";
import { collectDiagnosticsContext } from "../../context/diagnosticsContext";
import type { DiagnosticContext } from "../../context/contextTypes";

/**
 * Where `get_diagnostics` gets its data.
 *
 * The tool depends on this interface, not on VS Code, so it is fully testable
 * outside the extension host and a future host (or a cached snapshot) can be
 * plugged in without touching the tool. Normalization (severity mapping,
 * redaction of secrets in messages, truncation, ordering) is reused from the
 * existing diagnostics context collector — there is exactly one normalizer.
 */
export interface DiagnosticsQuery {
  readonly workspacePath: string;
  /** Absolute path when only one file's diagnostics are wanted. */
  readonly filePath?: string;
  readonly max?: number;
}

export interface DiagnosticsSource {
  list(query: DiagnosticsQuery): Promise<readonly DiagnosticContext[]>;
}

/**
 * VS Code-backed source. `vscode` is imported lazily so importing this module
 * (from tests or from a non-VS Code host) never fails.
 *
 * Diagnostics are *read* only: this never triggers a build or a language
 * server request, it reports whatever the editor currently knows.
 */
export function createVSCodeDiagnosticsSource(): DiagnosticsSource {
  return {
    async list(query) {
      const vscodeApi = await import("vscode");
      const entries: ReadonlyArray<readonly [vscode.Uri, readonly vscode.Diagnostic[]]> = query.filePath
        ? [
            [
              vscodeApi.Uri.file(query.filePath),
              vscodeApi.languages.getDiagnostics(vscodeApi.Uri.file(query.filePath)),
            ] as const,
          ]
        : vscodeApi.languages.getDiagnostics();

      return collectDiagnosticsContext(entries, {
        ...(query.max !== undefined ? { maxDiagnostics: query.max } : {}),
        ...(query.filePath ? { activeFilePath: query.filePath } : {}),
        workspacePath: query.workspacePath,
      });
    },
  };
}
