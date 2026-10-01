#!/usr/bin/env node
/**
 * Stage a production VSIX payload for Spider and package it with vsce.
 *
 * Why staging exists (root cause of the old "Cannot find module '@cursor/sdk'"):
 * - vsce's root file glob always ignores `node_modules/**` (hardcoded in
 *   collectAllFiles), so `vsce package --no-dependencies` never ships runtime
 *   dependencies at all.
 * - vsce's dependency detection (`--dependencies` mode) shells out to
 *   `npm list --production`, which fails in this pnpm checkout because
 *   `@cursor/sdk` carries monorepo-internal devDependencies (@anysphere/*)
 *   that no registry install can satisfy.
 * - `@cursor/sdk` must stay external (it cannot be bundled: it resolves
 *   platform-native packages, vendors native binaries, and depends on layout).
 *
 * The fix: assemble a clean package directory with a REAL (non-symlink)
 * node_modules containing the SDK, its production dependency closure, and ALL
 * of its `@cursor/sdk-<platform>` native packages (npm only installs the
 * os/cpu-matching one, so the rest are fetched from the registry here). vsce's
 * npm detection then succeeds inside the stage and the VSIX ships with a
 * self-contained runtime that resolves on Windows/macOS/Linux.
 *
 * Output: <repo root>/Spider-<version>.vsix
 */
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const stage = path.join(root, ".vsix-stage");

const NEEDS_SHELL = process.platform === "win32"; // npm/tar are .cmd/exe shims on Windows

function fail(message) {
  console.error(`[stage-vsix] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const { capture = false, cwd = root } = options;
  const result = spawnSync(command, args, {
    cwd,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: options.shell ?? NEEDS_SHELL,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const tail = capture ? `\n${(result.stderr || result.stdout || "").trim()}` : "";
    fail(`command failed (${command} ${args.join(" ")}): exit code ${result.status}${tail}`);
  }
  return result;
}

function copyIfExists(name, destinationDir = stage) {
  const from = path.join(root, name);
  if (fs.existsSync(from)) {
    fs.cpSync(from, path.join(destinationDir, name), { recursive: true });
    return true;
  }
  return false;
}

function stagePackagePayload(manifest) {
  for (const entry of ["dist", "assets"]) {
    if (!copyIfExists(entry)) fail(`missing required "${entry}/" — run the compile step first`);
  }
  for (const doc of ["README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md", "SUPPORT.md"]) {
    copyIfExists(doc);
  }
  // Scripts and devDependencies are build-time concerns; the stage has no
  // toolchain, and stripping scripts stops vsce from re-running
  // vscode:prepublish inside the stage.
  delete manifest.scripts;
  delete manifest.devDependencies;
  fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function installProductionClosure() {
  console.log("[stage-vsix] Installing production dependency closure with npm...");
  run("npm", [
    "install",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ], { cwd: stage });
}

function npmPackTarball(name, version, destination) {
  const result = run("npm", ["pack", `${name}@${version}`, "--pack-destination", destination, "--loglevel=error"], {
    capture: true,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const tarballName = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".tgz"))
    .pop();
  if (!tarballName) fail(`could not determine tarball filename for ${name}@${version}. npm said:\n${output}`);
  return path.join(destination, path.basename(tarballName));
}

function extractTarball(tarball, intoDir) {
  fs.mkdirSync(intoDir, { recursive: true });
  // Relative paths only: GNU tar treats "C:\..." as a remote host ("C:").
  run("tar", ["-xzf", path.basename(tarball), "-C", "."], { cwd: intoDir });
}

/**
 * npm installs only the optionalDependency matching the host os/cpu; a
 * Marketplace VSIX must carry every platform so the SDK finds its natives
 * (rg, sandbox helper, tree-sitter) at runtime on Windows/macOS/Linux.
 */
function stagePlatformPackages(manifest) {
  const sdkPackageJson = path.join(stage, "node_modules", "@cursor", "sdk", "package.json");
  if (!fs.existsSync(sdkPackageJson)) fail("npm install did not produce node_modules/@cursor/sdk");
  const sdkManifest = JSON.parse(fs.readFileSync(sdkPackageJson, "utf8"));
  const declaredSdkVersion = manifest.dependencies && manifest.dependencies["@cursor/sdk"];
  if (sdkManifest.version !== declaredSdkVersion) {
    fail(`staged @cursor/sdk@${sdkManifest.version} does not match manifest dependency ${declaredSdkVersion}`);
  }

  const platformPackages = Object.entries(sdkManifest.optionalDependencies ?? {}).filter(([name]) =>
    name.startsWith("@cursor/sdk-"),
  );
  if (platformPackages.length === 0) {
    console.log("[stage-vsix] SDK declares no platform packages; skipping native staging.");
    return;
  }

  const scratch = path.join(stage, ".tmp-platform-extract");
  fs.mkdirSync(scratch, { recursive: true });
  try {
    for (const [name, version] of platformPackages) {
      const destination = path.join(stage, "node_modules", ...name.split("/"));
      if (fs.existsSync(destination)) {
        console.log(`[stage-vsix] ${name}@${version} already installed by npm.`);
        continue;
      }
      console.log(`[stage-vsix] Fetching ${name}@${version} (not installable on this host)...`);
      const tarball = npmPackTarball(name, version, scratch);
      extractTarball(tarball, scratch);
      // npm tarballs extract to a single "package/" directory.
      fs.renameSync(path.join(scratch, "package"), destination);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function writeStageVscodeIgnore() {
  // Everything staged is intentional; trim only what is provably unused at
  // runtime (verified against each package's "require" export condition):
  // - declaration files are never required at runtime;
  // - zod resolves "require" to its root index.cjs (src/ is @zod/source only);
  // - @bufbuild/protobuf and @connectrpc/* resolve "require" to dist/cjs;
  // - @cursor/sdk resolves "require" to dist/cjs (esm/bundled are bun/import);
  // - @statsig/* resolve "require" to ./src/index.js and are KEPT intact.
  const ignore = [
    "# Generated by scripts/stage-vsix.js — payload staged for VSIX packaging.",
    "**/*.map",
    "**/*.d.ts",
    "**/*.d.mts",
    "**/*.d.cts",
    "package-lock.json",
    "node_modules/.package-lock.json",
    "node_modules/**/.package-lock.json",
    "node_modules/.bin/**",
    "node_modules/zod/src/**",
    "node_modules/@bufbuild/protobuf/dist/esm/**",
    "node_modules/@connectrpc/connect/dist/esm/**",
    "node_modules/@connectrpc/connect-web/dist/esm/**",
    "node_modules/@cursor/sdk/dist/esm/**",
    "node_modules/@cursor/sdk/dist/bundled/**",
    "",
  ];
  fs.writeFileSync(path.join(stage, ".vscodeignore"), ignore.join("\n"));
}

function runVsce() {
  const vsceBin = path.join(root, "node_modules", "@vscode", "vsce", "vsce");
  if (!fs.existsSync(vsceBin)) fail("@vscode/vsce is not installed — run: pnpm install");
  const vsceRealPath = fs.realpathSync(vsceBin);
  console.log("[stage-vsix] Packaging VSIX with vsce (from inside the stage)...");
  run(process.execPath, [vsceRealPath, "package", "--out", root], { cwd: stage, shell: false });
}

function report() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const vsixPath = path.join(root, `${manifest.name}-${manifest.version}.vsix`);
  if (!fs.existsSync(vsixPath)) fail(`expected VSIX not found: ${vsixPath}`);
  const sizeMb = (fs.statSync(vsixPath).size / (1024 * 1024)).toFixed(1);
  // Guard against a stale/broken artifact: a root-level `vsce package` run
  // writes the same filename but can never include node_modules (vsce's root
  // glob ignores it), which is exactly the production failure this script
  // exists to prevent. Fail loudly instead of shipping a dead VSIX.
  const vsixBytes = fs.readFileSync(vsixPath).toString("latin1");
  for (const entry of [
    "extension/node_modules/@cursor/sdk/package.json",
    "extension/node_modules/@cursor/sdk/dist/cjs/index.js",
    "extension/dist/extension.js",
  ]) {
    if (!vsixBytes.includes(entry)) fail(`packaged VSIX is missing ${entry} — do not package with bare vsce; use: pnpm run package`);
  }
  const packages = fs
    .readdirSync(path.join(stage, "node_modules"), { withFileTypes: true })
    .flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      if (entry.name.startsWith("@")) {
        return fs
          .readdirSync(path.join(stage, "node_modules", entry.name), { withFileTypes: true })
          .map((child) => `${entry.name}/${child.name}`);
      }
      return [entry.name];
    });
  console.log(`[stage-vsix] Created ${path.relative(root, vsixPath)} (${sizeMb} MB)`);
  console.log(`[stage-vsix] Staged runtime packages (${packages.length}): ${packages.sort().join(", ")}`);
}

function main() {
  if (!fs.existsSync(path.join(root, "dist", "extension.js"))) {
    fail("dist/extension.js not found — run the compile step first (pnpm run compile).");
  }
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  stagePackagePayload(manifest);
  installProductionClosure();
  stagePlatformPackages(manifest);
  writeStageVscodeIgnore();
  runVsce();
  report();
}

main();
