import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import type { SourceValidationDiagnostic } from "./sourceIntegrityValidator";

export interface DependencyValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly SourceValidationDiagnostic[];
}

interface ImportSpec {
  readonly moduleName: string;
  readonly namedImports: readonly string[];
  readonly line: number;
  readonly character: number;
}

const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "dns", "domain", "events", "fs", "fs/promises",
  "http", "http2", "https", "inspector", "module", "net", "os", "path",
  "path/posix", "path/win32", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "stream/promises", "stream/consumers",
  "string_decoder", "timers", "timers/promises", "tls", "trace_events", "tty",
  "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

export async function validateDependencies(
  workspacePath: string,
  filePath: string,
  content: string,
): Promise<DependencyValidationResult> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".ts" && ext !== ".tsx" && ext !== ".js" && ext !== ".jsx") {
    return { valid: true, diagnostics: [] };
  }

  const imports = extractImports(filePath, content);
  if (imports.length === 0) {
    return { valid: true, diagnostics: [] };
  }

  const diagnostics: SourceValidationDiagnostic[] = [];
  const packageJsonPath = path.join(workspacePath, "package.json");
  let packageJsonData: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined;

  try {
    const rawPkg = await fs.readFile(packageJsonPath, "utf8");
    packageJsonData = JSON.parse(rawPkg) as typeof packageJsonData;
  } catch {
    // If no package.json in workspace, skip package-level dependency validation
    return { valid: true, diagnostics: [] };
  }

  const allDeclaredDeps = new Set([
    ...Object.keys(packageJsonData?.dependencies ?? {}),
    ...Object.keys(packageJsonData?.devDependencies ?? {}),
  ]);

  for (const imp of imports) {
    if (imp.moduleName.startsWith(".") || imp.moduleName.startsWith("/")) {
      continue; // Local relative imports
    }

    const cleanPkgName = getRootPackageName(imp.moduleName);
    if (NODE_BUILTINS.has(cleanPkgName) || imp.moduleName.startsWith("node:")) {
      continue;
    }

    // Check if package is declared in package.json
    const isDeclared = allDeclaredDeps.has(cleanPkgName) || cleanPkgName.startsWith("@types/");
    if (!isDeclared) {
      diagnostics.push({
        line: imp.line,
        character: imp.character,
        message: `Package "${cleanPkgName}" is imported but not listed in package.json dependencies.`,
        severity: "warning",
      });
      continue;
    }

    // If there are named imports, verify against installed package declarations in node_modules
    if (imp.namedImports.length > 0) {
      const missingExports = await findMissingNamedExports(workspacePath, cleanPkgName, imp.namedImports);
      for (const missing of missingExports) {
        diagnostics.push({
          line: imp.line,
          character: imp.character,
          message: `Module "${imp.moduleName}" does not export member "${missing.symbol}". Installed version: ${missing.installedVersion ?? "unknown"}.`,
          severity: "error",
        });
      }
    }
  }

  return {
    valid: diagnostics.filter((d) => d.severity === "error").length === 0,
    diagnostics,
  };
}

function getRootPackageName(moduleSpecifier: string): string {
  if (moduleSpecifier.startsWith("@")) {
    const parts = moduleSpecifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  return moduleSpecifier.split("/")[0] ?? moduleSpecifier;
}

function extractImports(filePath: string, content: string): ImportSpec[] {
  const isJsx = filePath.endsWith(".tsx") || filePath.endsWith(".jsx");
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const specs: ImportSpec[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const moduleSpec = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpec)) {
        const moduleName = moduleSpec.text;
        const namedImports: string[] = [];
        const clause = node.importClause;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            namedImports.push(element.propertyName?.text ?? element.name.text);
          }
        }
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        specs.push({
          moduleName,
          namedImports,
          line: line + 1,
          character: character + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specs;
}

interface MissingExport {
  readonly symbol: string;
  readonly installedVersion?: string;
}

async function findMissingNamedExports(
  workspacePath: string,
  pkgName: string,
  requestedSymbols: readonly string[],
): Promise<MissingExport[]> {
  const pkgDir = path.join(workspacePath, "node_modules", ...pkgName.split("/"));
  const installedPkgJsonPath = path.join(pkgDir, "package.json");

  let installedVersion: string | undefined;
  let typeEntry: string | undefined;

  try {
    const raw = await fs.readFile(installedPkgJsonPath, "utf8");
    const json = JSON.parse(raw) as { version?: string; types?: string; typings?: string; main?: string };
    installedVersion = json.version;
    typeEntry = json.types ?? json.typings;
  } catch {
    // If package is not installed in node_modules, we cannot verify export symbols
    return [];
  }

  // Look for TypeScript type declaration file
  const candidateDtsPaths: string[] = [];
  if (typeEntry) {
    candidateDtsPaths.push(path.resolve(pkgDir, typeEntry));
  }
  candidateDtsPaths.push(path.join(pkgDir, "index.d.ts"));
  candidateDtsPaths.push(path.join(pkgDir, "dist", "index.d.ts"));
  candidateDtsPaths.push(path.join(pkgDir, "dist", "es", "index.d.ts"));
  candidateDtsPaths.push(path.join(pkgDir, "dist", "cjs", "index.d.ts"));

  let dtsContent: string | undefined;
  for (const candidate of candidateDtsPaths) {
    try {
      dtsContent = await fs.readFile(candidate, "utf8");
      break;
    } catch {
      continue;
    }
  }

  if (!dtsContent) {
    return [];
  }

  const missing: MissingExport[] = [];
  for (const sym of requestedSymbols) {
    // Match export forms in .d.ts files:
    // export declare const sym
    // export declare function sym
    // export { ... sym ... }
    // export type sym
    // export interface sym
    const isExported =
      new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:const|var|let|function|class|type|interface|enum)\\s+${sym}\\b`).test(dtsContent) ||
      new RegExp(`\\bexport\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}`).test(dtsContent) ||
      new RegExp(`\\bexport\\s*\\*\\s*from\\b`).test(dtsContent); // If re-exporting star, assume ok

    if (!isExported) {
      missing.push({ symbol: sym, installedVersion });
    }
  }

  return missing;
}
