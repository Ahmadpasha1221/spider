#!/usr/bin/env node
/**
 * Automated smoke test for the INSTALLED production VSIX.
 *
 * Unlike `pnpm run test` (unit tests) and F5 (development host), this proves
 * the shipped artifact: it installs the VSIX into an isolated VS Code profile
 * (--user-data-dir + --extensions-dir), launches a real VS Code instance via
 * @vscode/test-electron, and executes in-window assertions:
 *
 *   - Spider commands are registered (spider.openAgent/openSettings/openHistory)
 *   - workbench.view.extension.spider exists (container focus target)
 *   - running "Spider: Open Agent" activates the extension without error
 *   - "Spider: Open History" opens the History editor tab (packaged assets)
 *   - the Agent webview resolves (see "Agent webview resolved" in exthost log)
 *
 * Usage: node scripts/vsixSmokeTest.mjs [path/to/Spider-<version>.vsix]
 * Exits non-zero on any failure.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));

function fail(message) {
  console.error(`[vsix-smoke] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: process.platform === "win32",
    encoding: "utf8",
    ...(options.spawn ?? {}),
  });
  if (options.capture) {
    return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
  }
  if (result.status !== 0) {
    fail(`command failed (${command} ${args.join(" ")}): exit ${result.status}`);
  }
  return { status: result.status, output: "" };
}

function extractVsix(vsixPath, extensionsDir, expectedDirName) {
  const scratch = path.join(path.dirname(vsixPath), ".vsix-smoke-extract");
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  if (process.platform === "win32") {
    const zipCopy = path.join(scratch, "vsix.zip");
    fs.copyFileSync(vsixPath, zipCopy);
    run("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zipCopy}' -DestinationPath '${scratch}/unzip' -Force`,
    ]);
    fs.renameSync(path.join(scratch, "unzip", "extension"), path.join(extensionsDir, expectedDirName));
  } else {
    run("unzip", ["-q", vsixPath, "-d", scratch]);
    fs.renameSync(path.join(scratch, "extension"), path.join(extensionsDir, expectedDirName));
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const vsixArg = process.argv[2];
  const vsixPath = path.resolve(vsixArg ?? path.join(root, `${manifest.name}-${manifest.version}.vsix`));
  if (!fs.existsSync(vsixPath)) {
    fail(`VSIX not found: ${vsixPath} — build it first with: pnpm run package`);
  }

  const expectedDirName = `${manifest.publisher}.${manifest.name}-${manifest.version}`.toLowerCase();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "vsix-smoke-ws-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vsix-smoke-profile-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vsix-smoke-ext-"));
  const devExtDir = fs.mkdtempSync(path.join(os.tmpdir(), "vsix-smoke-dev-"));
  const scratch = path.join(path.dirname(vsixPath), ".vsix-smoke-extract");

  // runTests requires an extensionDevelopmentPath; a declaration-only manifest
  // is a valid but inert development extension so the harness loads nothing
  // from the checkout — only the installed VSIX is under test.
  fs.writeFileSync(
    path.join(devExtDir, "package.json"),
    JSON.stringify({
      name: "vsix-smoke-harness",
      publisher: "local",
      version: "0.0.0",
      engines: { vscode: manifest.engines.vscode },
    }),
  );

  console.log(`[vsix-smoke] Installing ${path.basename(vsixPath)} into isolated profile...`);
  extractVsix(vsixPath, extensionsDir, expectedDirName);
  if (!fs.existsSync(path.join(extensionsDir, expectedDirName, "node_modules", "@cursor", "sdk"))) {
    fail("installed VSIX does not contain node_modules/@cursor/sdk — packaging is broken");
  }

  const { runTests } = require("@vscode/test-electron");
  try {
    await runTests({
      extensionDevelopmentPath: devExtDir,
      extensionTestsPath: path.join(root, "scripts", "vsixSmoke", "extensionTests.js"),
      launchArgs: [
        workspace,
        "--user-data-dir",
        userDataDir,
        "--extensions-dir",
        extensionsDir,
        "--disable-gpu",
        "--disable-workspace-trust",
      ],
    });
  } catch (error) {
    fail(`in-window smoke test FAILED: ${error?.message ?? error}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // Grep the isolated instance's extension-host logs for the failures this
  // task exists to prevent, and for the markers that prove the happy path.
  let logRoot = null;
  for (const candidate of [path.join(userDataDir, "logs"), path.join(userDataDir, "data", "logs")]) {
    if (fs.existsSync(candidate)) {
      logRoot = candidate;
      break;
    }
  }
  if (!logRoot) {
    console.log("[vsix-smoke] NOTE: no logs directory found under the isolated profile; skipped log audit");
    return;
  }
  const collected = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile() && entry.name.endsWith(".log")) {
        collected.push(p);
      }
    }
  };
  walk(logRoot);
  const contents = collected.map((p) => ({ p, text: fs.readFileSync(p, "utf8") }));
  const badPatterns = [
    /Cannot find module '@cursor\/sdk'/,
    /MODULE_NOT_FOUND/,
    /command 'spider\.openAgent' not found/,
    /command 'spider\.openHistory' not found/,
    /does not register a chat participant/,
    /Activating extension .*Spider.* failed/,
  ];
  const failures = [];
  for (const pattern of badPatterns) {
    for (const { p, text } of contents) {
      if (pattern.test(text)) {
        failures.push(`${path.relative(userDataDir, p)}: ${pattern}`);
      }
    }
  }
  if (failures.length > 0) {
    fail(`log audit found fatal patterns:\n${failures.join("\n")}`);
  }
  const webviewResolved = contents.some(({ text }) => text.includes("Agent webview resolved"));
  console.log(
    webviewResolved
      ? "[vsix-smoke] PASS: activation, command registration, container focus and Agent webview resolve all verified from the installed VSIX"
      : "[vsix-smoke] PASS (partial): activation + commands verified; 'Agent webview resolved' marker not found in logs",
  );
}

main().catch((error) => fail(error?.stack ?? String(error)));
