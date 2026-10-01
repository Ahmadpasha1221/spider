"use strict";
/**
 * In-VS Code smoke assertions for the INSTALLED Spider VSIX.
 * Loaded by @vscode/test-electron via scripts/vsixSmokeTest.mjs.
 *
 * These run inside a real VS Code instance whose --extensions-dir contains the
 * extracted production VSIX (not the development checkout), so they exercise
 * exactly what a Marketplace user gets.
 */
const vscode = require("vscode");

const COMMAND_IDS = ["spider.openAgent", "spider.openSettings", "spider.openHistory"];
const CONTAINER_FOCUS_COMMAND = "workbench.view.extension.spider";
const SPIDER_EXTENSION_IDS = ["ahmadpasha1221.spider", "Ahmadpasha1221.Spider"];

async function findSpiderExtension() {
  for (const id of SPIDER_EXTENSION_IDS) {
    const extension = vscode.extensions.getExtension(id);
    if (extension) {
      return extension;
    }
  }
  return undefined;
}

async function run() {
  const spider = await findSpiderExtension();
  if (!spider) {
    throw new Error(
      `Spider VSIX is not installed in the test instance (looked for: ${SPIDER_EXTENSION_IDS.join(", ")})`,
    );
  }

  // Exercise the real user flow first: running the command must trigger
  // activation (onCommand activation event) and its handler must execute.
  // The handler focuses the view container via
  // workbench.view.extension.<containerId> — a wrong id would reject here.
  await vscode.commands.executeCommand("spider.openAgent");
  if (!spider.isActive) {
    throw new Error("Spider did not activate after executing spider.openAgent");
  }
  await vscode.commands.executeCommand("spider.openSettings");
  // Opens the History editor tab: proves dist/gui/history.html + history.js are
  // actually packaged (createOrShow reads them synchronously and would throw).
  await vscode.commands.executeCommand("spider.openHistory");

  // Now that Spider is active, its commands must be registered.
  const commands = await vscode.commands.getCommands(true);
  const missing = COMMAND_IDS.filter((id) => !commands.includes(id));
  if (missing.length > 0) {
    throw new Error(`Spider commands not registered after activation: ${missing.join(", ")}`);
  }
  if (!commands.includes(CONTAINER_FOCUS_COMMAND)) {
    throw new Error(`Container focus command missing: ${CONTAINER_FOCUS_COMMAND}`);
  }

  console.log("[vsix-smoke] Spider activated; openAgent/openSettings/openHistory executed without error");
}

module.exports = { run };
