import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OpenRouterRuntime } from "../../../../src/runtime/openrouter/openRouterRuntime";
import { ToolRouter } from "../../../../src/runtime/tools/toolRouter";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import type { RuntimeEvent, RuntimeToolCall } from "../../../../src/runtime/runtimeTypes";

/**
 * Full-path verification through the REAL tool executor (no stubs):
 *
 *   model → agent loop → ToolRouter/executor → workspace → result → model
 *
 * The user never selects a tool or a mode; the model chooses from the
 * registered schemas it is sent.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const CATALOG = {
  data: [
    {
      id: "anthropic/claude-sonnet-4",
      name: "Claude Sonnet 4",
      context_length: 200000,
      architecture: { input_modalities: ["text"] },
      supported_parameters: ["tools", "tool_choice", "stream"],
      pricing: { prompt: "0.000003", completion: "0.000015" },
    },
  ],
};

/** Builds an SSE response that streams one native tool call. */
function toolCallStream(id: string, name: string, args: object): Response {
  const encoder = new TextEncoder();
  const text = JSON.stringify(args);
  // Split the arguments across fragments the way real providers do.
  const half = Math.ceil(text.length / 2);
  const payloads = [
    { choices: [{ delta: { role: "assistant", content: "" } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }],
          },
        },
      ],
    },
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: text.slice(0, half) } }] } },
      ],
    },
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: text.slice(half) } }] } },
      ],
      finish_reason: "tool_calls",
    },
  ];
  const lines = payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`);
  lines.push("data: [DONE]\n\n");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function runFlow(
  workspace: string,
  responses: readonly (() => Response)[],
  prompt: string,
): Promise<{ events: RuntimeEvent[]; calls: RuntimeToolCall[] }> {
  let turn = 0;
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const target = String(url);
    if (target.endsWith("/models")) {
      return jsonResponse(CATALOG);
    }
    if (target.endsWith("/chat/completions")) {
      const factory = responses[Math.min(turn, responses.length - 1)];
      turn += 1;
      if (!factory) {
        throw new Error("Unexpected extra chat call");
      }
      return factory();
    }
    throw new TypeError(`Unexpected URL ${target}`);
  }) as unknown as typeof fetch;

  const runtime = new OpenRouterRuntime(fetcher);
  await runtime.configure({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4", apiKey: "k" });
  await runtime.createSession({ sessionId: "s1", workspacePath: workspace, modelId: "anthropic/claude-sonnet-4" });

  const router = new ToolRouter(new WorkspaceToolExecutor());
  const calls: RuntimeToolCall[] = [];
  const events: RuntimeEvent[] = [];
  const session = { sessionId: "s1", workspacePath: workspace, provider: "mock", status: "IDLE" } as never;

  await runtime.sendMessage(
    {
      sessionId: "s1",
      workspacePath: workspace,
      modelId: "anthropic/claude-sonnet-4",
      prompt,
      onStreamDelta: () => undefined,
      // Real routing path: registry validation → executor → structured result.
      onToolCall: async (call, signal) => {
        calls.push(call);
        return router.route(call, { session, signal }, async () => ({ allowed: true }), { mode: "agent" });
      },
    },
    async (event) => {
      events.push(event);
    },
  );

  return { events, calls };
}

describe("agent flow: model autonomously creates a file", () => {
  it("creates the requested python file without any user tool/mode choice", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-flow-"));
    const content = "def advanced_functions():\n    return 'closure, decorator, generator'\n";

    const { events, calls } = await runFlow(
      workspace,
      [
        () => toolCallStream("call_w", "write_file", { path: "advanced_functions.py", content }),
        () => toolCallStream("call_f", "finish", { summary: "Created advanced_functions.py with advanced Python examples." }),
      ],
      "can you create me a python file teaching about advanced python functions",
    );

    // 1. The model selected write_file itself.
    expect(calls.map((call) => call.name)).toEqual(["write_file", "finish"]);
    expect(calls[0]?.id).toBe("call_w");

    // 2. The file was really created in the workspace.
    const written = await fs.readFile(path.join(workspace, "advanced_functions.py"), "utf8");
    expect(written).toBe(content);

    // 3. The tool result reached the model, which then finalized.
    const thinking = events.filter((event) => event.type === "thinking").map((event) => event.message);
    expect(thinking.some((message) => /Unknown tool/.test(message))).toBe(false);
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
    const final = events.filter((event) => event.type === "assistant_message").at(-1);
    expect(final && final.type === "assistant_message" ? final.message : "").toContain("advanced_functions.py");

    await fs.rm(workspace, { recursive: true, force: true });
  });
});

describe("agent flow: multi-step read_file → edit_file → finish", () => {
  it("reads, edits, and finishes across multiple model turns", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-flow-"));
    const target = path.join(workspace, "notes.py");
    await fs.writeFile(target, "def old():\n    pass\n", "utf8");

    const { events, calls } = await runFlow(
      workspace,
      [
        () => toolCallStream("call_r", "read_file", { path: "notes.py" }),
        () =>
          toolCallStream("call_e", "edit_file", {
            path: "notes.py",
            old_string: "def old():",
            new_string: "def renamed():",
          }),
        () => toolCallStream("call_fin", "finish", { summary: "Renamed the function in notes.py." }),
      ],
      "rename the function in notes.py",
    );

    expect(calls.map((call) => call.name)).toEqual(["read_file", "edit_file", "finish"]);

    const edited = await fs.readFile(target, "utf8");
    expect(edited).toContain("def renamed():");
    expect(edited).not.toContain("def old():");

    const thinking = events.filter((event) => event.type === "thinking").map((event) => event.message);
    expect(thinking.some((message) => /Unknown tool/.test(message))).toBe(false);
    expect(events.filter((event) => event.type === "tool_result")).toHaveLength(3);
    const final = events.filter((event) => event.type === "assistant_message").at(-1);
    expect(final && final.type === "assistant_message" ? final.message : "").toContain("notes.py");

    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("keeps the conversation valid across turns (assistant tool_calls match tool_call_id)", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-flow-"));
    await fs.writeFile(path.join(workspace, "notes.py"), "value = 1\n", "utf8");

    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    let turn = 0;
    const responses = [
      () => toolCallStream("call_r", "read_file", { path: "notes.py" }),
      () => toolCallStream("call_fin", "finish", { summary: "Read notes.py." }),
    ];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/models")) {
        return jsonResponse(CATALOG);
      }
      if (target.endsWith("/chat/completions")) {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as { messages: Array<Record<string, unknown>> });
        const factory = responses[Math.min(turn, responses.length - 1)];
        turn += 1;
        return factory!();
      }
      throw new TypeError(`Unexpected URL ${target}`);
    }) as unknown as typeof fetch;

    const runtime = new OpenRouterRuntime(fetcher);
    await runtime.configure({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4", apiKey: "k" });
    await runtime.createSession({ sessionId: "s1", workspacePath: workspace, modelId: "anthropic/claude-sonnet-4" });

    const router = new ToolRouter(new WorkspaceToolExecutor());
    const session = { sessionId: "s1", workspacePath: workspace, provider: "mock", status: "IDLE" } as never;

    await runtime.sendMessage(
      {
        sessionId: "s1",
        workspacePath: workspace,
        modelId: "anthropic/claude-sonnet-4",
        prompt: "read notes.py",
        onStreamDelta: () => undefined,
        onToolCall: async (call, signal) =>
          router.route(call, { session, signal }, async () => ({ allowed: true }), { mode: "agent" }),
      },
      async () => undefined,
    );

    // Second request must carry the assistant tool_calls turn AND the matching tool result.
    const second = bodies[1]?.messages ?? [];
    const assistantToolTurn = second.find((message) => Array.isArray(message.tool_calls)) as
      | { tool_calls: Array<{ id: string }> }
      | undefined;
    const toolTurn = second.find((message) => message.role === "tool") as
      | { tool_call_id: string }
      | undefined;
    expect(assistantToolTurn?.tool_calls[0]?.id).toBe("call_r");
    expect(toolTurn?.tool_call_id).toBe("call_r");

    await fs.rm(workspace, { recursive: true, force: true });
  });
});
