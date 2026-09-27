const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const isWatch = process.argv.includes("--watch");

const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/extension.js",
  external: ["vscode", "@cursor/sdk", "bun:sqlite"],
  sourcemap: true,
  logLevel: "info",
};

const guiOptions = {
  entryPoints: ["gui/src/main.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "iife",
  outfile: "dist/gui/main.js",
  sourcemap: true,
  logLevel: "info",
};

function copyGuiAssets() {
  const outDir = path.join("dist", "gui");
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(path.join("gui", "index.html"), path.join(outDir, "index.html"));
  fs.copyFileSync(path.join("gui", "styles", "main.css"), path.join(outDir, "main.css"));
  // Spider mark for the empty-chat watermark (single asset, no duplication).
  fs.copyFileSync(path.join("assets", "spider-icon.png"), path.join(outDir, "spider-icon.png"));
}

async function run() {
  copyGuiAssets();

  if (isWatch) {
    const extensionCtx = await esbuild.context(extensionOptions);
    const guiCtx = await esbuild.context(guiOptions);
    await Promise.all([extensionCtx.watch(), guiCtx.watch()]);
    console.log("Watching extension and GUI...");
    return;
  }

  const result = await esbuild.build({
    ...extensionOptions,
    metafile: true,
  });
  await esbuild.build(guiOptions);

  if (result.metafile) {
    console.log(JSON.stringify(result.metafile, null, 2));
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
