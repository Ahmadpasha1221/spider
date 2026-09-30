import { ToolExecutionError } from "./toolError";
import type { UserQuestionAnswer, UserQuestionOption, UserQuestionRequestInput } from "../userInteraction/userQuestionBroker";

/**
 * `ask_user`: pause and ask the user a clarifying question.
 *
 * This is human-in-the-loop clarification, **not** a permission mechanism: it
 * cannot approve a tool or a command, and the permission manager stays the only
 * authority for approvals. The tool is a thin adapter over the injected
 * gateway; request correlation, cancellation, and multi-pending handling all
 * live in the broker.
 */
export const ASK_USER_LIMITS = {
  maxQuestionLength: 2000,
  maxOptions: 20,
  maxOptionLabelLength: 100,
  maxOptionDescriptionLength: 300,
  maxContextLength: 2000,
} as const;

export interface AskUserResult {
  readonly requestId: string;
  readonly answer: string;
  readonly cancelled?: true;
  readonly message?: string;
}

export interface AskUserDeps {
  readonly askUser?: (request: UserQuestionRequestInput) => Promise<UserQuestionAnswer>;
}

export async function askUser(
  input: Record<string, unknown>,
  sessionId: string,
  deps: AskUserDeps,
): Promise<AskUserResult> {
  const gateway = deps.askUser;
  if (!gateway) {
    throw new ToolExecutionError(
      "dependency_unavailable",
      "Asking the user is only available while an agent run is active in the extension host.",
    );
  }

  const question = requiredText(input.question, "question", ASK_USER_LIMITS.maxQuestionLength);
  const options = parseOptions(input.options);
  const defaultOption = parseDefaultOption(input.defaultOption, options);
  const context = optionalText(input.context, ASK_USER_LIMITS.maxContextLength);

  const answer = await gateway({
    sessionId,
    question,
    ...(options.length > 0 ? { options } : {}),
    ...(defaultOption ? { defaultOption } : {}),
    ...(context ? { context } : {}),
  });

  if (answer.cancelled) {
    return {
      requestId: answer.requestId,
      answer: "",
      cancelled: true,
      message: "The question was dismissed without an answer.",
    };
  }
  return { requestId: answer.requestId, answer: answer.answer };
}

function parseOptions(value: unknown): UserQuestionOption[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ToolExecutionError("invalid_input", "options must be an array.");
  }
  if (value.length > ASK_USER_LIMITS.maxOptions) {
    throw new ToolExecutionError("invalid_input", `options cannot exceed ${ASK_USER_LIMITS.maxOptions} entries.`);
  }

  const seen = new Set<string>();
  const options: UserQuestionOption[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      throw new ToolExecutionError("invalid_input", "Every option must be an object with a label.");
    }
    const record = entry as Record<string, unknown>;
    const label = requiredText(record.label, "option.label", ASK_USER_LIMITS.maxOptionLabelLength);
    const optionValue = optionalText(record.value, ASK_USER_LIMITS.maxOptionLabelLength) ?? label;
    if (seen.has(optionValue)) {
      throw new ToolExecutionError("invalid_input", `Duplicate option value: ${optionValue}.`);
    }
    seen.add(optionValue);
    const description = optionalText(record.description, ASK_USER_LIMITS.maxOptionDescriptionLength);
    options.push({ label, value: optionValue, ...(description ? { description } : {}) });
  }
  return options;
}

function parseDefaultOption(value: unknown, options: readonly UserQuestionOption[]): string | undefined {
  const fallback = optionalText(value, ASK_USER_LIMITS.maxOptionLabelLength);
  if (!fallback) {
    return undefined;
  }
  if (options.length > 0 && !options.some((option) => option.value === fallback)) {
    throw new ToolExecutionError("invalid_input", "defaultOption must match one of the option values.");
  }
  return fallback;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolExecutionError("invalid_input", `Missing required argument: ${field}.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ToolExecutionError("invalid_input", `${field} cannot exceed ${maxLength} characters.`);
  }
  return trimmed;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ToolExecutionError("invalid_input", "Expected a string argument.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > maxLength) {
    throw new ToolExecutionError("invalid_input", `Text cannot exceed ${maxLength} characters.`);
  }
  return trimmed;
}
