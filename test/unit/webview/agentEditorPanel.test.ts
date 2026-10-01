import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  created: [] as Array<{
    webview: {
      html: string;
      options: unknown;
      postMessage: ReturnType<typeof vi.fn>;
      asWebviewUri: (uri: unknown) => unknown;
      onDidReceiveMessage: (listener: (message: unknown) => void) => { dispose: () => void };
    };
    viewType: string;
    title: string;
    iconPath: unknown;
    reveal: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    onDidDispose: (listener: () => void) => { dispose: () => void };
    disposeListeners: Array<() => void>;
  }>,
}));

vi.mock("vscode", () => {
  class WebviewPanel {
    webview = {
      html: "",
      options: {},
      postMessage: vi.fn().mockResolvedValue(true),
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        this.listeners.push(listener);
        return { dispose: vi.fn() };
      },
    };
    listeners: Array<(message: unknown) => void> = [];
    disposeListeners: Array<() => void> = [];
    iconPath: unknown;
    reveal = vi.fn();
    dispose = vi.fn(() => {
      this.disposeListeners.forEach((listener) => listener());
    });
    onDidDispose = (listener: () => void) => {
      this.disposeListeners.push(listener);
      return { dispose: vi.fn() };
    };
    constructor(
      public readonly viewType: string,
      public readonly title: string,
    ) {
      vscodeMock.created.push(this as never);
    }
  }
  return {
    window: {
      createWebviewPanel: (viewType: string, title: string) =>
        new WebviewPanel(viewType, title) as never,
    },
    Uri: {
      joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
        fsPath: [base.fsPath, ...parts].join("/"),
      }),
    },
    ViewColumn: { One: 1, Active: 2 },
  };
});

// The panel's HTML is read from dist/gui; stub the filesystem so the
// test does not depend on a build having run.
vi.mock("node:fs", () => ({
  readFileSync: () => "<html>{{cspSource}}{{nonce}}{{scriptUri}}{{styleUri}}{{logoUri}}{{showSettings}}</html>",
  default: { readFileSync: () => "<html></html>" },
}));

import { AgentEditorPanel } from "../../../src/webview/agentEditorPanel";
import type { AgentWebviewHost } from "../../../src/webview/agentWebviewHost";

/** AgentEditorPanel keeps a module-level singleton (one tab at a time). */
let openPanel: AgentEditorPanel | undefined;

afterEach(() => {
  openPanel?.dispose();
  openPanel = undefined;
});

function createHost(): AgentWebviewHost {
  return {
    attach: vi.fn(),
    detach: vi.fn(),
  } as unknown as AgentWebviewHost;
}

const extensionUri = { fsPath: "/ext" } as never;

function panelFor(host: AgentWebviewHost) {
  openPanel = AgentEditorPanel.createOrShow(extensionUri, host);
  const created = vscodeMock.created[vscodeMock.created.length - 1];
  return { panel: openPanel, created, host };
}

describe("AgentEditorPanel", () => {
  beforeEach(() => {
    vscodeMock.created.length = 0;
  });

  it("creates an editor-area tab with the spider logo and attaches it to the host", () => {
    const host = createHost();
    const { created } = panelFor(host);

    expect(vscodeMock.created).toHaveLength(1);
    expect(created.viewType).toBe("spider.agentEditor");
    expect(created.title).toBe("Spider Agent");
    // Spider mark in the tab header.
    expect(created.iconPath).toEqual({ fsPath: "/ext/assets/spider-icon.png" });
    expect(host.attach).toHaveBeenCalledWith(created.webview);
  });

  it("reuses the open tab instead of opening a second one", () => {
    const host = createHost();
    const first = panelFor(host);

    const again = AgentEditorPanel.createOrShow(extensionUri, host);

    expect(vscodeMock.created).toHaveLength(1);
    expect(again).toBe(first.panel);
    expect(first.created.reveal).toHaveBeenCalled();
  });

  it("detaches the webview from the host when the tab is closed", () => {
    const host = createHost();
    const { created } = panelFor(host);

    created.dispose();

    expect(host.detach).toHaveBeenCalledWith(created.webview);
  });

  it("reveals the open tab and reports that one exists", () => {
    const host = createHost();
    const { created } = panelFor(host);

    expect(AgentEditorPanel.reveal()).toBe(true);
    expect(created.reveal).toHaveBeenCalled();
  });

  it("reports no tab when none is open", () => {
    expect(AgentEditorPanel.reveal()).toBe(false);
  });
});
