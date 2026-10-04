import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ToolRouter } from "../../../../src/runtime/tools/toolRouter";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import { BackgroundProcessManager, type BackgroundProcessManagerOptions } from "../../../../src/runtime/tools/backgroundProcessManager";
import { UserQuestionBroker } from "../../../../src/runtime/userInteraction/userQuestionBroker";
import { TaskPlanStore } from "../../../../src/runtime/state/taskPlan";
import {
  availableToolNames,
} from "../../../../src/runtime/tools/toolAvailability";
import {
  EXECUTE_TOOL_NAMES,
  EXTERNAL_TOOL_NAMES,
  getRegisteredTool,
  nativeChatTools,
  READ_TOOL_NAMES,
} from "../../../../src/runtime/tools/toolRegistry";
import { MessageRouter } from "../../../../src/webview/messageRouter";
import type { RuntimeToolExecutorContext } from "../../../../src/runtime/runtimeTypes";
import { makeSession } from "./toolTestUtils";
import { ExecutionManager } from "../../../../src/runtime/execution/executionManager";

type SpawnFn = NonNullable<BackgroundProcessManagerOptions["spawnFn"]>;

class FakeChild extends EventEmitter {
  pid: number | undefined = 900;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = (): boolean => true;
}

function makeExecutionManager(_workspacePath: string): ExecutionManager {
  return new ExecutionManager({
    environment: {
      hostPlatform: process.platform,
      terminalShellPath: process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh"),
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => typeof v === "string"),
      ) as Record<string, string>,
    },
  });
}

function makeExecutor(fetchFn?: typeof fetch) {
  const children: FakeChild[] = [];
  const spawnFn = ((_command: string, _args: readonly string[], _options: SpawnOptions) => {
    const child = new FakeChild();
    children.push(child);
    process.nextTick(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  }) as unknown as SpawnFn;
  const manager = new BackgroundProcessManager({ spawnFn, immediateExitGraceMs: 0, killGraceMs: 10 });
  const executor = new WorkspaceToolExecutor({
    backgroundProcesses: manager,
    ...(fetchFn ? { fetch: fetchFn } : {}),
    resolveHost: async () => ["93.184.216.34"],
    executionManager: makeExecutionManager("."),
  });
  return { executor, manager, latest: () => children[children.length - 1] as FakeChild };
}

function makeRouter(executor: WorkspaceToolExecutor, workspacePath = ".") {
  const router = new ToolRouter(executor);
  const session = makeSession(workspacePath);
  const allow = async () => ({ allowed: true });
  const call = (name: string, input: Record<string, unknown> = {}, extra: Partial<RuntimeToolExecutorContext> = {}) =>
    router.route({ id: `c-${name}`, name, input }, { session, ...extra }, allow);
  return { router, session, call };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition");
}

describe("Phase 3 workflows through the real registry, router and executor", () => {
  it("background_command → get_command_output → kill_command", async () => {
    const { executor, manager, latest } = makeExecutor();
    const { call } = makeRouter(executor);

    const started = await call("background_command", { command: "npm", args: ["run", "dev"] });
    const processId = (started.result as { processId: string }).processId;
    expect((started.result as { status: string }).status).toBe("running");

    latest().stdout.emit("data", "server listening on :3000\n");
    const output = await call("get_command_output", { processId });
    expect(output.result).toMatchObject({ processId, status: "running" });
    expect((output.result as { stdout: string }).stdout).toContain("listening");

    const killed = await call("kill_command", { processId });
    expect(killed.result).toMatchObject({ processId, status: "killed" });
    expect(manager.get(processId)?.status).toBe("killed");
  });

  it("ask_user pauses the agent until the webview answers", async () => {
    const { executor } = makeExecutor();
    const { call } = makeRouter(executor);
    const broker = new UserQuestionBroker(() => "q-1");

    const pending = call(
      "ask_user",
      { question: "Which config?", options: [{ label: "dev", value: "development" }, { label: "prod", value: "production" }] },
      { askUser: (request) => broker.ask(request) },
    );

    await waitFor(() => broker.getPending().length === 1);
    const question = broker.getPending()[0]!;
    expect(question.question).toBe("Which config?");
    expect(question.options?.map((option) => option.value)).toEqual(["development", "production"]);

    broker.answer(question.requestId, "development");
    const response = await pending;
    expect(response.result).toMatchObject({ requestId: "q-1", answer: "development" });
  });

  it("ask_user is cancelled safely when the run ends first", async () => {
    const { executor } = makeExecutor();
    const { call } = makeRouter(executor);
    const broker = new UserQuestionBroker(() => "q-2");

    const pending = call("ask_user", { question: "?" }, { askUser: (request) => broker.ask(request) });
    await waitFor(() => broker.getPending().length === 1);
    broker.cancelAll("cancelled");

    const response = await pending;
    expect(response.allowed).toBe(true);
    expect(response.result).toMatchObject({ cancelled: true });
  });

  it("update_todo stores the plan outside the transcript", async () => {
    const { executor } = makeExecutor();
    const { call } = makeRouter(executor);
    const store = new TaskPlanStore();
    const published: string[] = [];

    const response = await call(
      "update_todo",
      {
        items: [
          { id: "inspect", title: "Inspect streaming", status: "completed" },
          { id: "fix", title: "Fix rendering", status: "in_progress" },
          { id: "test", title: "Run tests", status: "pending" },
        ],
      },
      {
        taskPlan: {
          update: (items) => {
            const plan = store.update("s1", items);
            published.push(plan.sessionId);
            return plan;
          },
        },
      },
    );

    expect(response.result).toMatchObject({
      sessionId: "s1",
      inProgressId: "fix",
      counts: { pending: 1, in_progress: 1, completed: 1, cancelled: 0 },
    });
    expect(published).toEqual(["s1"]);
    expect(store.get("s1")?.items).toHaveLength(3);
  });

  it("fetch_url retrieves documentation through the bounded request path", async () => {
    const fetchFn = (async () => new Response("<html><body><h1>Docs</h1><p>Use it</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
    const { executor } = makeExecutor(fetchFn);
    const { call } = makeRouter(executor);

    const response = await call("fetch_url", { url: "https://docs.example.com/api" });
    expect(response.result).toMatchObject({ status: 200, contentType: "text/html" });
    const content = (response.result as { content: string }).content;
    expect(content).toContain("Docs");
    expect(content).toContain("Use it");
    expect(content).not.toContain("<");
  });

  it("fetch_url rejects a private target before any request", async () => {
    const { executor } = makeExecutor((async () => new Response("secret")) as typeof fetch);
    const { call } = makeRouter(executor);

    const response = await call("fetch_url", { url: "https://169.254.169.254/latest/meta-data/" });
    expect(response.allowed).toBe(true);
    expect(response.result).toMatchObject({ success: false, code: "security_rejected" });
  });
});

describe("Phase 3 registry + protocol contract", () => {
  it("registers the five tools with their permissions and categories", () => {
    const expected: Record<string, { permission: string; category: string }> = {
      get_command_output: { permission: "safe", category: "terminal" },
      kill_command: { permission: "execute", category: "terminal" },
      ask_user: { permission: "safe", category: "workflow" },
      update_todo: { permission: "safe", category: "workflow" },
      fetch_url: { permission: "external", category: "network" },
    };
    for (const [name, meta] of Object.entries(expected)) {
      const tool = getRegisteredTool(name);
      expect(tool, `${name} must be registered`).toBeDefined();
      expect(tool?.permission).toBe(meta.permission);
      expect(tool?.category).toBe(meta.category);
      expect(tool?.parameters.type).toBe("object");
      expect(tool?.summarize({}).length).toBeGreaterThan(0);
    }
  });

  it("classifies the new tools through the existing permission sets", () => {
    expect(EXTERNAL_TOOL_NAMES.has("fetch_url")).toBe(true);
    expect(READ_TOOL_NAMES.has("fetch_url")).toBe(false);
    expect(EXECUTE_TOOL_NAMES.has("kill_command")).toBe(true);
    for (const name of ["get_command_output", "ask_user", "update_todo"]) {
      expect(READ_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it("exposes every new tool to the agent but keeps network/process control out of read-only modes", () => {
    const names = nativeChatTools().map((tool) => tool.function.name);
    for (const name of ["get_command_output", "kill_command", "ask_user", "update_todo", "fetch_url"]) {
      expect(names).toContain(name);
      expect(availableToolNames("agent")).toContain(name);
    }
    const ask = availableToolNames("ask");
    expect(ask).toContain("ask_user");
    expect(ask).toContain("update_todo");
    expect(ask).not.toContain("fetch_url");
    expect(ask).not.toContain("kill_command");
    expect(ask).not.toContain("get_command_output");
  });

  it("validates the new tool arguments through the registry contract", () => {
    expect(getRegisteredTool("get_command_output")?.validate({})).toContain("processId");
    expect(getRegisteredTool("get_command_output")?.validate({ processId: "p1" })).toBeUndefined();
    expect(getRegisteredTool("kill_command")?.validate({ processId: "p1" })).toBeUndefined();
    expect(getRegisteredTool("ask_user")?.validate({})).toContain("question");
    expect(getRegisteredTool("ask_user")?.validate({ question: "hi" })).toBeUndefined();
    expect(getRegisteredTool("ask_user")?.validate({ question: "hi", options: "no" })).toContain("array");
    expect(getRegisteredTool("update_todo")?.validate({})).toContain("items");
    expect(getRegisteredTool("update_todo")?.validate({ items: [] })).toBeUndefined();
    expect(getRegisteredTool("fetch_url")?.validate({})).toContain("url");
    // http parses (loopback dev servers); the SSRF policy enforces the
    // destination at execution time, not the registry shape check.
    expect(getRegisteredTool("fetch_url")?.validate({ url: "http://example.com" })).toBeUndefined();
    expect(getRegisteredTool("fetch_url")?.validate({ url: "ftp://example.com" })).toContain("https");
    expect(getRegisteredTool("fetch_url")?.validate({ url: "https://example.com" })).toBeUndefined();
  });

  it("maps the new runtime events onto typed webview messages", () => {
    const router = new MessageRouter({} as never);

    const asked = router.toRuntimeExtensionMessage({
      type: "user_question",
      sessionId: "s1",
      timestamp: 1,
      request: {
        requestId: "q1",
        sessionId: "s1",
        question: "Which?",
        options: [{ label: "a", value: "a" }],
        createdAt: 1,
      },
    });
    expect(asked).toMatchObject({ type: "USER_QUESTION", requestId: "q1", question: "Which?" });

    const closed = router.toRuntimeExtensionMessage({ type: "user_question_resolved", sessionId: "s1", requestId: "q1", timestamp: 2 });
    expect(closed).toEqual({ type: "USER_QUESTION_CLOSED", requestId: "q1" });

    const todo = router.toRuntimeExtensionMessage({
      type: "todo_updated",
      sessionId: "s1",
      timestamp: 3,
      plan: { sessionId: "s1", updatedAt: 3, items: [{ id: "a", title: "A", status: "in_progress" }] },
    });
    expect(todo).toEqual({ type: "TODO_UPDATED", sessionId: "s1", items: [{ id: "a", title: "A", status: "in_progress" }] });
  });

  it("validates ask_user responses and ignores stale request ids without crashing", async () => {
    const router = new MessageRouter({} as never);

    await expect(router.handleMessage({ type: "ANSWER_USER_QUESTION", requestId: "q1", answer: "yes" })).resolves.toEqual({
      type: "USER_QUESTION_CLOSED",
      requestId: "q1",
    });
    await expect(router.handleMessage({ type: "CANCEL_USER_QUESTION", requestId: "q1" })).resolves.toEqual({
      type: "USER_QUESTION_CLOSED",
      requestId: "q1",
    });
    await expect(router.handleMessage({ type: "ANSWER_USER_QUESTION", requestId: 5, answer: "yes" })).rejects.toThrow();
    await expect(router.handleMessage({ type: "CANCEL_USER_QUESTION" })).rejects.toThrow();
  });
});
