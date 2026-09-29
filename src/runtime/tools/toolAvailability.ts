import { listRegisteredTools } from "./toolRegistry";

/**
 * Tool availability: the "current available-tool set" from the architecture.
 *
 * The model only ever sees (and the loop only ever executes) tools in this
 * set. Today every mode exposes all registered tools; the structure is here so
 * future modes (Ask, Plan, custom) can restrict tools without touching the
 * registry, executor, or loop.
 *
 * This is NOT an intent router: it never inspects the user's message and never
 * selects a tool. It only defines which tools the model may choose from.
 */
export type AgentMode = "agent" | "ask" | "plan";

export interface AgentModeDefinition {
  readonly mode: AgentMode;
  readonly description: string;
  /** Tool names available in this mode. */
  readonly tools: readonly string[];
}

/**
 * Read/search tools allowed in read-only modes (Ask, Plan): every tool whose
 * permission is "safe" and which is not a terminal command. Derived from the
 * registry, so a new read-only tool joins the read-only modes automatically.
 */
function readOnlyToolNames(): string[] {
  return listRegisteredTools()
    .filter((tool) => tool.permission === "safe" && tool.category !== "terminal")
    .map((tool) => tool.name);
}

const AGENT_MODES: Readonly<Record<AgentMode, AgentModeDefinition>> = {
  // Agent: all registered tools.
  agent: {
    mode: "agent",
    description: "Full coding agent with every registered tool.",
    tools: listRegisteredTools().map((tool) => tool.name),
  },
  // Ask: read/search tools only.
  ask: {
    mode: "ask",
    description: "Read-only question answering with read and search tools.",
    tools: readOnlyToolNames(),
  },
  // Plan: read/search tools only.
  plan: {
    mode: "plan",
    description: "Planning mode with read and search tools.",
    tools: readOnlyToolNames(),
  },
};

export const DEFAULT_AGENT_MODE: AgentMode = "agent";

export function listAgentModes(): readonly AgentMode[] {
  return Object.keys(AGENT_MODES) as AgentMode[];
}

export function getAgentModeDefinition(mode: AgentMode = DEFAULT_AGENT_MODE): AgentModeDefinition {
  return AGENT_MODES[mode] ?? AGENT_MODES[DEFAULT_AGENT_MODE];
}

/**
 * The current available-tool set. This is the single place the rest of the
 * runtime consults for what the model may see and call. Future modes only
 * need a new entry in AGENT_MODES.
 */
export function availableToolNames(mode: AgentMode = DEFAULT_AGENT_MODE): readonly string[] {
  return getAgentModeDefinition(mode).tools;
}

export function isToolAvailable(name: string, mode: AgentMode = DEFAULT_AGENT_MODE): boolean {
  return availableToolNames(mode).includes(name);
}
