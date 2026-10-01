import * as assert from "assert";
import * as vscode from "vscode";

suite("Extension Test Suite", () => {
  suiteTeardown(() => {
    vscode.window.showInformationMessage("All extension tests done.");
  });

  test("activates and registers commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("spider.openAgent"), "openAgent command should be registered");
    assert.ok(commands.includes("spider.openSettings"), "openSettings command should be registered");

    await vscode.commands.executeCommand("spider.openAgent");
  });
});
