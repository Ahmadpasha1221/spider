import * as vscode from "vscode";
import { CHAT_PARTICIPANT_ID, CHAT_PERMISSION_COMMANDS } from "../shared/constants";
import type { PermissionManager } from "../permissions/permissionManager";
import type { RuntimeManager } from "../runtime/runtimeManager";
import type { RuntimeEvent } from "../runtime/runtimeTypes";

export interface SpiderChatParticipantOptions {
  readonly extensionUri: vscode.Uri;
  readonly runtimeManager: RuntimeManager;
  readonly permissionManager: PermissionManager;
  readonly defaultWorkspacePath: string;
}

/**
 * `/explain`, `/fix`, `/test` (the commands contributed in package.json) map to
 * prompt preambles — VS Code replaces `request.prompt` with the text after the
 * command, so the intent has to be re-attached here.
 */
const COMMAND_PREAMBLES: Readonly<Record<string, string>> = {
  explain: "Explain the selected code or the referenced context. Be concise.",
  fix: "Find and fix the problem in the selected code or the reported issue.",
  test: "Write focused tests for the selected code.",
};

/**
 * VS Code Chat participant for `@spider`.
 *
 * It is a thin bridge over the same RuntimeManager the sidebar uses: a dedicated
 * session keeps chat turns separate from the Agent view's conversation, text
 * deltas stream straight into the chat response, and tool activity surfaces as
 * progress. Non-destructive permission requests are auto-approved; destructive
 * ones surface Allow/Deny buttons so the user decides in chat instead of the
 * request being silently denied.
 */
export function registerSpiderChatParticipant(
  options: SpiderChatParticipantOptions,
): vscode.Disposable {
  const { runtimeManager, permissionManager } = options;
  let chatSessionId: string | undefined;

  const ensureSession = () => {
    if (chatSessionId) {
      const existing = runtimeManager.getSession(chatSessionId);
      if (existing) {
        return existing;
      }
    }
    const created = runtimeManager.createSession(options.defaultWorkspacePath);
    chatSessionId = created.sessionId;
    return created;
  };

  const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
    const prompt = buildPrompt(request);
    if (prompt.length === 0) {
      stream.markdown("Ask Spider something about your workspace.");
      return;
    }

    if (!runtimeManager.provider) {
      stream.markdown(
        "**Spider has no AI provider configured.** Open the Spider sidebar and choose "
        + "Local AI (Ollama), OpenRouter, or Cursor in Settings, then try again.",
      );
      return;
    }

    const session = ensureSession();
    let streamed = false;
    let errorReported = false;

    const subscription = runtimeManager.onDidPublishEvent((event: RuntimeEvent) => {
      if (event.sessionId !== session.sessionId) {
        return;
      }
      switch (event.type) {
        case "text_delta":
          if (event.text.length > 0) {
            streamed = true;
            stream.markdown(event.text);
          }
          break;
        case "assistant_message":
          // Deltas already painted this reply; only fall back to the final
          // message when the provider did not stream.
          if (!streamed && event.message.length > 0) {
            stream.markdown(event.message);
          }
          break;
        case "thinking":
          stream.progress(event.message);
          break;
        case "tool_call":
        case "tool_running":
          stream.progress(`Running ${event.toolCall.name}…`);
          break;
        case "permission_request":
          if (event.request.destructive) {
            // Destructive tools must not be auto-approved: surface the request
            // as Allow/Deny buttons and let the user decide. The run stays
            // suspended until a decision (or the policy's timeout) resolves it.
            stream.markdown(
              `\n\n**Permission required** — ${event.request.description}\n\n`,
            );
            stream.button({
              command: CHAT_PERMISSION_COMMANDS.allow,
              title: "Allow once",
              arguments: [event.request.requestId, event.request.description],
            });
            stream.button({
              command: CHAT_PERMISSION_COMMANDS.deny,
              title: "Deny",
              arguments: [event.request.requestId, event.request.description],
            });
          } else {
            // Non-destructive work stays frictionless (same policy the sidebar
            // applies for reads/executes).
            permissionManager.resolveDecision({
              requestId: event.request.requestId,
              decision: "ALLOW",
              confirmation: true,
            });
          }
          break;
        case "user_question": {
          const answer =
            event.request.defaultOption
            ?? event.request.options?.[0]?.value
            ?? "";
          stream.progress(event.request.question);
          if (answer.length > 0) {
            runtimeManager.resolveUserQuestion(event.request.requestId, answer);
          } else {
            runtimeManager.cancelUserQuestion(event.request.requestId);
          }
          break;
        }
        case "error":
          errorReported = true;
          stream.markdown(`\n\n**Spider error:** ${event.error.message}`);
          break;
        default:
          break;
      }
    });

    const cancellation = token.onCancellationRequested(() => {
      void runtimeManager.cancelTask(session.sessionId);
    });

    try {
      await runtimeManager.startTask(session.sessionId, prompt, token);
    } catch (error) {
      if (!errorReported) {
        stream.markdown(`\n\n**Spider could not complete the request:** ${errorMessage(error)}`);
      }
    } finally {
      cancellation.dispose();
      subscription.dispose();
    }
  };

  const participant = vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(options.extensionUri, "assets", "icon.png");
  return participant;
}

function buildPrompt(request: vscode.ChatRequest): string {
  const prompt = request.prompt.trim();
  const preamble = request.command ? COMMAND_PREAMBLES[request.command] : undefined;
  return preamble ? `${preamble}\n\n${prompt}` : prompt;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
