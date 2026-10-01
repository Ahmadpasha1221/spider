import { describe, expect, it, vi } from "vitest";

const registerMock = vi.hoisted(() => ({
  createChatParticipant: vi.fn(),
}));

vi.mock("vscode", () => ({
  chat: {
    createChatParticipant: (id: string, handler: unknown) => {
      registerMock.createChatParticipant(id, handler);
      return { id, dispose: vi.fn(), iconPath: undefined };
    },
  },
  Uri: { joinPath: (...parts: unknown[]) => parts.join("/") },
}));

import { registerSpiderChatParticipant } from "../../../src/chat/chatParticipant";

interface FakeRuntime {
  provider?: string;
  getSession: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  onDidPublishEvent: (listener: (event: unknown) => void) => { dispose: () => void };
  startTask: ReturnType<typeof vi.fn>;
  cancelTask: ReturnType<typeof vi.fn>;
  resolveUserQuestion: ReturnType<typeof vi.fn>;
  cancelUserQuestion: ReturnType<typeof vi.fn>;
}

function createRuntime(
  onTask: (sessionId: string, emit: (event: Record<string, unknown>) => void) => void,
  provider = "ollama",
): { runtime: FakeRuntime; emitSubscribers: Array<(event: unknown) => void> } {
  const subscribers: Array<(event: unknown) => void> = [];
  const runtime: FakeRuntime = {
    provider,
    getSession: vi.fn(() => undefined),
    createSession: vi.fn(() => ({ sessionId: "chat-1" })),
    onDidPublishEvent: (listener) => {
      subscribers.push(listener);
      return { dispose: () => undefined };
    },
    startTask: vi.fn(async (sessionId: string) => {
      onTask(sessionId, (event) => {
        for (const listener of subscribers) {
          listener(event);
        }
      });
    }),
    cancelTask: vi.fn(async () => undefined),
    resolveUserQuestion: vi.fn(() => true),
    cancelUserQuestion: vi.fn(() => true),
  };
  return { runtime, emitSubscribers: subscribers };
}

function createStream() {
  return { markdown: vi.fn(), progress: vi.fn(), button: vi.fn() };
}

function createToken() {
  return { onCancellationRequested: () => ({ dispose: vi.fn() }) };
}

function request(prompt: string, command?: string) {
  return { prompt, command } as never;
}

function register(runtime: FakeRuntime, resolveDecision = vi.fn()) {
  registerMock.createChatParticipant.mockClear();
  registerSpiderChatParticipant({
    extensionUri: "file:///ext" as never,
    runtimeManager: runtime as never,
    permissionManager: { resolveDecision } as never,
    defaultWorkspacePath: "/workspace",
  });
  const [, handler] = registerMock.createChatParticipant.mock.calls[0] as [
    string,
    (request: unknown, context: unknown, stream: unknown, token: unknown) => Promise<void>,
  ];
  return { handler, resolveDecision };
}

describe("spider chat participant", () => {
  it("registers under the contributed participant id", () => {
    const { runtime } = createRuntime(() => undefined);
    register(runtime);
    expect(registerMock.createChatParticipant).toHaveBeenCalledWith(
      "spider.spider",
      expect.any(Function),
    );
  });

  it("explains how to configure a provider when none is set", async () => {
    // Empty provider stands in for "never configured" (falsy).
    const { runtime } = createRuntime(() => undefined, "");
    const { handler } = register(runtime);
    const stream = createStream();

    await handler(request("hello"), {}, stream, createToken());

    expect(stream.markdown).toHaveBeenCalledWith(expect.stringContaining("no AI provider configured"));
    expect(runtime.startTask).not.toHaveBeenCalled();
  });

  it("streams text deltas and does not duplicate the final assistant message", async () => {
    const { runtime } = createRuntime((sessionId, emit) => {
      emit({ type: "text_delta", sessionId, text: "Hello ", timestamp: 0 });
      emit({ type: "text_delta", sessionId, text: "world", timestamp: 0 });
      emit({ type: "assistant_message", sessionId, message: "Hello world", timestamp: 0 });
    });
    const { handler } = register(runtime);
    const stream = createStream();

    await handler(request("hi"), {}, stream, createToken());

    expect(stream.markdown).toHaveBeenNthCalledWith(1, "Hello ");
    expect(stream.markdown).toHaveBeenNthCalledWith(2, "world");
    expect(stream.markdown).not.toHaveBeenCalledWith("Hello world");
  });

  it("falls back to the final message when the provider did not stream", async () => {
    const { runtime } = createRuntime((sessionId, emit) => {
      emit({ type: "assistant_message", sessionId, message: "Full reply", timestamp: 0 });
    });
    const { handler } = register(runtime);
    const stream = createStream();

    await handler(request("hi"), {}, stream, createToken());

    expect(stream.markdown).toHaveBeenCalledWith("Full reply");
  });

  it("passes slash-command intent through as a prompt preamble", async () => {
    const { runtime } = createRuntime(() => undefined);
    const { handler } = register(runtime);

    await handler(request("this function", "explain"), {}, createStream(), createToken());

    expect(runtime.startTask).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Explain the selected code"),
      expect.anything(),
    );
  });

  it("auto-approves non-destructive permission requests", async () => {
    const { runtime } = createRuntime((sessionId, emit) => {
      emit({
        type: "permission_request",
        sessionId,
        request: { requestId: "p1", sessionId, category: "EXECUTE", description: "run", destructive: false },
        timestamp: 0,
      });
    });
    const { handler, resolveDecision } = register(runtime);
    const stream = createStream();

    await handler(request("do it"), {}, stream, createToken());

    expect(resolveDecision).toHaveBeenCalledWith({ requestId: "p1", decision: "ALLOW", confirmation: true });
    expect(stream.button).not.toHaveBeenCalled();
  });

  it("asks the user before a destructive tool instead of denying it", async () => {
    const { runtime } = createRuntime((sessionId, emit) => {
      emit({
        type: "permission_request",
        sessionId,
        request: { requestId: "p2", sessionId, category: "DESTRUCTIVE", description: "rm -rf build", destructive: true },
        timestamp: 0,
      });
    });
    const { handler, resolveDecision } = register(runtime);
    const stream = createStream();

    await handler(request("clean up"), {}, stream, createToken());

    expect(stream.markdown).toHaveBeenCalledWith(expect.stringContaining("Permission required"));
    expect(stream.button).toHaveBeenCalledWith({
      command: "spider.chatPermission.allow",
      title: "Allow once",
      arguments: ["p2", "rm -rf build"],
    });
    expect(stream.button).toHaveBeenCalledWith({
      command: "spider.chatPermission.deny",
      title: "Deny",
      arguments: ["p2", "rm -rf build"],
    });
    // The decision belongs to the user's button click, not to the participant.
    expect(resolveDecision).not.toHaveBeenCalled();
  });
});
