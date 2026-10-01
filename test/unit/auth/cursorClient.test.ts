import { afterEach, describe, expect, it, vi } from "vitest";
import { configureCursorSdk } from "@cursor/sdk";
import { CursorClient } from "../../../src/auth/cursorClient";
import { CursorAuthError } from "../../../src/auth/cursorAuthError";
import { Agent, Run } from "@cursor/sdk";

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    resume: vi.fn(),
  },
  Run: vi.fn(),
  configureCursorSdk: vi.fn(),
}));

describe("CursorClient", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("createAgent returns an SDK agent", async () => {
    const agent = { agentId: "agent-1", close: vi.fn() };
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const client = new CursorClient(undefined);
    const result = await client.createAgent("Test Agent", "/workspace");

    expect(result).toBe(agent);
    expect(Agent.create).toHaveBeenCalledWith({
      name: "Test Agent",
      local: { cwd: "/workspace" },
      apiKey: undefined,
    });
  });

  it("createAgent throws CursorAuthError on auth failure", async () => {
    vi.mocked(Agent.create).mockRejectedValue(new CursorAuthError("Auth failed", 401));

    const client = new CursorClient(undefined);
    await expect(client.createAgent("Test Agent", "/workspace")).rejects.toBeInstanceOf(CursorAuthError);
  });

  it("listAgents returns items", async () => {
    vi.mocked(Agent.list).mockResolvedValue({ items: [{ agentId: "agent-1", name: "Agent" }] });

    const client = new CursorClient(undefined);
    const agents = await client.listAgents();

    expect(agents).toHaveLength(1);
    expect(agents[0].agentId).toBe("agent-1");
  });

  it("sendMessage resumes agent and sends prompt", async () => {
    const run = { id: "run-1", agentId: "agent-1", cancel: vi.fn(), wait: vi.fn().mockResolvedValue({ status: "finished" }), stream: vi.fn() };
    const agent = { agentId: "agent-1", send: vi.fn().mockResolvedValue(run) };
    vi.mocked(Agent.resume).mockResolvedValue(agent as unknown as ReturnType<typeof Agent.resume>);

    const client = new CursorClient(undefined);
    const result = await client.sendMessage("agent-1", "Hello");

    expect(result).toBe(run);
    expect(agent.send).toHaveBeenCalledWith("Hello");
  });

  it("cancelRun cancels the run", async () => {
    const run = { cancel: vi.fn() } as unknown as Run;
    vi.mocked(Agent.resume).mockResolvedValue({ agentId: "agent-1" } as unknown as ReturnType<typeof Agent.resume>);

    const client = new CursorClient(undefined);
    await client.cancelRun(run);

    expect(run.cancel).toHaveBeenCalled();
  });

  it("waitRun returns run status", async () => {
    const run = {
      id: "run-1",
      agentId: "agent-1",
      cancel: vi.fn(),
      wait: vi.fn().mockResolvedValue({ status: "finished" }),
      stream: vi.fn(),
    } as unknown as Run;

    const client = new CursorClient(undefined);
    const result = await client.waitRun(run);

    expect(result).toEqual({ runId: "run-1", agentId: "agent-1", status: "finished" });
  });

  it("setApiKey is used for subsequent Agent.create calls", async () => {
    const agent = { agentId: "agent-1", close: vi.fn() };
    vi.mocked(Agent.create).mockResolvedValue(agent);

    const client = new CursorClient(undefined);
    client.setApiKey("cursor_test_key");
    await client.createAgent("Test Agent", "/workspace");

    expect(Agent.create).toHaveBeenCalledWith({
      name: "Test Agent",
      local: { cwd: "/workspace" },
      apiKey: "cursor_test_key",
    });
  });

  it("validateConnection creates an agent and returns assistant text", async () => {
    const run = {
      id: "run-1",
      agentId: "agent-1",
      cancel: vi.fn(),
      wait: vi.fn().mockResolvedValue({ status: "finished" }),
      stream: vi.fn(async function* () {
        yield { type: "assistant", text: "pong" };
      }),
    };
    const agent = { agentId: "agent-1", send: vi.fn().mockResolvedValue(run), close: vi.fn() };
    vi.mocked(Agent.create).mockResolvedValue(agent);
    vi.mocked(Agent.resume).mockResolvedValue(agent as unknown as Awaited<ReturnType<typeof Agent.resume>>);

    const client = new CursorClient("cursor_test_key");
    const message = await client.validateConnection("/workspace");

    expect(message).toBe("pong");
    expect(agent.close).toHaveBeenCalled();
  });

  it("validateConnection maps invalid key errors to CursorAuthError", async () => {
    vi.mocked(Agent.create).mockRejectedValue(new Error("Invalid API key 401"));

    const client = new CursorClient("bad");
    await expect(client.validateConnection("/workspace")).rejects.toBeInstanceOf(CursorAuthError);
  });

  it("does not configure the SDK at construction (activation must not depend on Cursor)", () => {
    new CursorClient(undefined);

    expect(configureCursorSdk).not.toHaveBeenCalled();
  });

  it("configures the SDK exactly once on first use", async () => {
    vi.mocked(Agent.list).mockResolvedValue({ items: [] });

    const client = new CursorClient(undefined);
    await client.listAgents();
    await client.listAgents();

    expect(configureCursorSdk).toHaveBeenCalledTimes(1);
    expect(configureCursorSdk).toHaveBeenCalledWith({});
  });
});
