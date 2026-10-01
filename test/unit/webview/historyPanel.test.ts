import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  created: [] as Array<{
    webview: {
      html: string;
      options: unknown;
      onDidReceiveMessage: (listener: (message: unknown) => void) => { dispose: () => void };
      postMessage: ReturnType<typeof vi.fn>;
    };
    title: string;
    reveal: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    onDidDispose: (listener: () => void) => { dispose: () => void };
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
    reveal = vi.fn();
    dispose = vi.fn();
    onDidDispose = vi.fn(() => ({ dispose: vi.fn() }));
    constructor(
      public readonly title: string,
      public readonly viewType: string,
    ) {
      vscodeMock.created.push(this as never);
    }
  }
  return {
    window: {
      createWebviewPanel: (viewType: string, title: string) =>
        new WebviewPanel(title, viewType) as never,
    },
    Uri: {
      joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
        fsPath: [base.fsPath, ...parts].join("/"),
      }),
    },
    ViewColumn: { Active: 1 },
  };
});

// The panel reads its HTML from dist/gui; stub the filesystem so the test does
// not depend on a build having run.
vi.mock("node:fs", () => ({
  readFileSync: () => "<html>{{cspSource}}{{nonce}}{{scriptUri}}{{styleUri}}</html>",
  default: { readFileSync: () => "<html>{{cspSource}}{{nonce}}{{scriptUri}}{{styleUri}}</html>" },
}));

import { HistoryPanel, type HistoryPanelHost } from "../../../src/webview/historyPanel";

/**
 * HistoryPanel keeps a module-level singleton (one tab at a time), so each test
 * must tear its panel down — otherwise the next test reuses a stale instance.
 */
let openPanel: HistoryPanel | undefined;

afterEach(() => {
  openPanel?.dispose();
  openPanel = undefined;
});

function createHost(overrides: Partial<HistoryPanelHost> = {}): HistoryPanelHost {
  return {
    listSessions: () => ({
      sessions: [
        {
          sessionId: "s1",
          status: "COMPLETED",
          workspacePath: "/workspace",
          currentTask: "Fix the bug",
          updatedAt: 1,
        },
      ],
      activeSessionId: "s1",
    }),
    selectSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    getTranscript: vi.fn(async () => [
      { kind: "user" as const, text: "hello", timestamp: 1 },
    ]),
    ...overrides,
  };
}

const extensionUri = { fsPath: "/ext" } as never;

function panelFor(host: HistoryPanelHost) {
  openPanel = HistoryPanel.createOrShow(extensionUri, host);
  const created = vscodeMock.created[vscodeMock.created.length - 1];
  const send = (message: unknown) => created.listeners.forEach((listener) => listener(message));
  return { panel: openPanel, created, send };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("HistoryPanel", () => {
  beforeEach(() => {
    vscodeMock.created.length = 0;
  });

  it("re-broadcasts the conversation list on creation", () => {
    const host = createHost();
    const { created } = panelFor(host);

    expect(created.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SESSION_UPDATED", activeSessionId: "s1" }),
    );
  });

  it("delegates conversation selection to the host and refreshes the list", async () => {
    const host = createHost();
    const { created, send } = panelFor(host);

    send({ type: "SELECT_SESSION", sessionId: "s2" });
    await flush();

    expect(host.selectSession).toHaveBeenCalledWith("s2");
    expect(created.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SESSION_UPDATED" }),
    );
  });

  it("delegates deletion to the host and re-broadcasts the list", async () => {
    const host = createHost();
    const { created, send } = panelFor(host);
    created.webview.postMessage.mockClear();

    send({ type: "DELETE_SESSION", sessionId: "s1" });
    await flush();

    expect(host.deleteSession).toHaveBeenCalledWith("s1");
    expect(created.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SESSION_UPDATED" }),
    );
  });

  it("returns the requested transcript for the preview pane", async () => {
    const host = createHost();
    const { created, send } = panelFor(host);
    created.webview.postMessage.mockClear();

    send({ type: "GET_TRANSCRIPT", sessionId: "s1" });
    await flush();

    expect(host.getTranscript).toHaveBeenCalledWith("s1");
    expect(created.webview.postMessage).toHaveBeenCalledWith({
      type: "TRANSCRIPT",
      sessionId: "s1",
      entries: [{ kind: "user", text: "hello", timestamp: 1 }],
    });
  });

  it("ignores malformed messages instead of touching the host", async () => {
    const host = createHost();
    const { send } = panelFor(host);

    send({ type: "DELETE_SESSION" });
    send({ type: "DELETE_SESSION", sessionId: "" });
    send({ type: "GET_TRANSCRIPT", sessionId: 42 });
    send("not-an-object");
    await flush();

    expect(host.deleteSession).not.toHaveBeenCalled();
    expect(host.getTranscript).not.toHaveBeenCalled();
  });

  it("reveals the existing tab instead of opening a second one", () => {
    const host = createHost();
    const first = panelFor(host);

    const again = HistoryPanel.createOrShow(extensionUri, host);

    expect(vscodeMock.created).toHaveLength(1);
    expect(again).toBe(first.panel);
    expect(first.created.reveal).toHaveBeenCalled();
  });
});