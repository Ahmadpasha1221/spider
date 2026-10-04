import type { RuntimeToolCall } from "../runtimeTypes";import { DESTRUCTIVE_TOOL_NAMES, EXECUTE_TOOL_NAMES, EXTERNAL_TOOL_NAMES, LOCAL_TOOL_NAMES, MODIFY_TOOL_NAMES, READ_TOOL_NAMES } from "./toolRegistry";
export { DESTRUCTIVE_TOOL_NAMES, EXECUTE_TOOL_NAMES, EXTERNAL_TOOL_NAMES, LOCAL_TOOL_NAMES, MODIFY_TOOL_NAMES, READ_TOOL_NAMES };

export const LOCAL_AGENT_SYSTEM_PROMPT = `You are Spider, a coding agent operating as an autonomous agent inside the user's workspace.

When the user's request requires creating, modifying, deleting, moving, reading, searching, or executing something in the workspace, use the appropriate registered tool. Do not merely provide code in chat when the user has requested a workspace change. If the user asks you to create a file, actually call write_file. If the user asks you to modify a file, actually call edit_file. Only provide code as normal assistant text when the user is asking for code or explanation rather than requesting a workspace change.

You choose tools from the registered tool list based on the current task. The application validates arguments, checks permissions, executes the tool, and returns the result. Do not invent tool results.

Use a tool when the task needs the workspace or a command. Read or inspect existing files before changing them when you need their current contents. Verify important writes and edits. When the task is done, call finish with a short summary, or reply in plain text if no further tool is required.

Conversation, greetings, and questions that do not need the workspace should be answered in plain text without a tool call.
If the user asks which model is running, answer with the selected model named below and do not call a workspace tool.

"Create a file" of any kind (.txt, .py, .js, .ts, .json, .md, .html, .css and similar) means write_file. There are no per-file-type creation tools.

Paths in tool arguments are relative to the workspace root, such as simple.py or src/main.py. If the user gives an absolute path inside the workspace, convert it to a workspace-relative path before calling a tool. Never use paths that leave the workspace.
Never tell the user a file was created, changed, or a command succeeded unless the tool result says success.
Call finish only after the required operations have succeeded.`;

export function buildAgentSystemPrompt(
  modelId?: string,
  executionContextSummary?: string,
  rulesContext?: string,
): string {
  const modelLine = modelId ? `\nSelected model: ${modelId}.` : "";
  const executionLine = executionContextSummary
    ? `\n\nExecution environment (resolved by Spider for the current workspace):\n${executionContextSummary}\nrun_command executes in this environment automatically. Do not prefix commands with wsl.exe, cmd.exe, powershell.exe, or bash.exe, and do not probe the environment with pwd, which, or find: Spider already runs commands in the correct workspace shell and working directory.`
    : "";
  const rulesLine = rulesContext ? `\n\n${rulesContext}` : "";
  return `${LOCAL_AGENT_SYSTEM_PROMPT}${modelLine}${executionLine}${rulesLine}`;
}

/**
 * Removes every trace of the tool protocol from model text before it can be
 * shown to the user: <tool_call> blocks, markdown-fenced tool JSON, complete
 * tool objects (any name, registered or not — e.g. finish), and unterminated
 * fragments of a tool object that may have arrived mid-stream.
 */
export function stripToolCallMarkup(text: string): string {
  const withoutTags = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
  const withoutFence = withoutTags.replace(/```(?:json)?\s*\{[\s\S]*?"name"\s*:\s*"[^"]+"[\s\S]*?```/gi, "");
  const withoutObjects = withoutFence.replace(/\{\s*"name"\s*:\s*"[^"]+"[\s\S]*\}/g, "");
  // Unterminated protocol fragment (e.g. streamed as {"name":"fin…) — never show it.
  const withoutPartial = withoutObjects.replace(/\{\s*"name"\s*:\s*"[^"]*$/, "");
  return withoutPartial.trim();
}

export function formatToolResultForModel(call: RuntimeToolCall, result: unknown, error?: string): string {
  const payload = error ? { ok: false, error } : { ok: true, result };
  return `TOOL_RESULT ${call.name} (${call.id}):\n${safeJson(payload)}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
