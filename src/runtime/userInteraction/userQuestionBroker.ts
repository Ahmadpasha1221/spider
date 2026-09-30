/**
 * `ask_user` request broker.
 *
 * This is the human-in-the-loop counterpart to the permission pipeline, and it
 * is deliberately **not** a permission mechanism: it cannot approve a tool, it
 * only lets the model ask a clarifying question and wait for an answer.
 *
 * Requests are correlated by a unique `requestId`, so multiple pending
 * questions are safe and a stale/unknown response is a no-op rather than a
 * crash. The broker stores no UI state and imports no `vscode` API, so it is
 * fully testable outside the extension host (mirrors the permission manager).
 */
export interface UserQuestionOption {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
}

export interface UserQuestion {
  readonly requestId: string;
  readonly sessionId: string;
  readonly question: string;
  readonly options?: readonly UserQuestionOption[];
  readonly defaultOption?: string;
  readonly context?: string;
  readonly createdAt: number;
}

export interface UserQuestionAnswer {
  readonly requestId: string;
  /** Chosen/typed answer; empty when the user cancelled. */
  readonly answer: string;
  readonly cancelled?: true;
}

export type UserQuestionCancelReason = "cancelled" | "session_ended" | "disposed";

export type UserQuestionEvent =
  | { type: "asked"; request: UserQuestion }
  | { type: "answered"; requestId: string; sessionId: string }
  | { type: "cancelled"; requestId: string; sessionId: string; reason: UserQuestionCancelReason };

export interface UserQuestionRequestInput {
  readonly sessionId: string;
  readonly question: string;
  readonly options?: readonly UserQuestionOption[];
  readonly defaultOption?: string;
  readonly context?: string;
}

export interface PendingUserQuestion {
  readonly request: UserQuestion;
  readonly resolve: (answer: UserQuestionAnswer) => void;
}

export class UserQuestionBroker {
  private readonly pending = new Map<string, PendingUserQuestion>();
  private readonly listeners = new Set<(event: UserQuestionEvent) => void>();
  private disposed = false;

  constructor(private readonly idFactory: () => string = () => crypto.randomUUID()) {}

  onEvent(listener: (event: UserQuestionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Registers a question and returns a promise that settles when the user
   * answers, cancels, the session ends, or the broker is disposed. Never
   * rejects: a cancelled question resolves with `{ cancelled: true }` so the
   * tool can map it onto a structured `cancelled` result.
   */
  ask(input: UserQuestionRequestInput): Promise<UserQuestionAnswer> {
    if (this.disposed) {
      return Promise.resolve({ requestId: "", answer: "", cancelled: true });
    }
    const request: UserQuestion = {
      requestId: this.uniqueId(),
      sessionId: input.sessionId,
      question: input.question,
      ...(input.options ? { options: input.options } : {}),
      ...(input.defaultOption ? { defaultOption: input.defaultOption } : {}),
      ...(input.context ? { context: input.context } : {}),
      createdAt: Date.now(),
    };

    return new Promise<UserQuestionAnswer>((resolve) => {
      this.pending.set(request.requestId, { request, resolve });
      this.emit({ type: "asked", request });
    });
  }

  /** Resolves a pending question. Returns false for an unknown/stale id. */
  answer(requestId: string, answer: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return false;
    }
    this.pending.delete(requestId);
    this.emit({ type: "answered", requestId, sessionId: pending.request.sessionId });
    pending.resolve({ requestId, answer });
    return true;
  }

  /** Cancels a pending question. Returns false for an unknown/stale id. */
  cancel(requestId: string, reason: UserQuestionCancelReason = "cancelled"): boolean {
    return this.settleCancelled(requestId, reason);
  }

  cancelSession(sessionId: string, reason: UserQuestionCancelReason = "session_ended"): void {
    for (const [requestId, pending] of Array.from(this.pending.entries())) {
      if (pending.request.sessionId === sessionId) {
        this.settleCancelled(requestId, reason);
      }
    }
  }

  cancelAll(reason: UserQuestionCancelReason = "cancelled"): void {
    for (const requestId of Array.from(this.pending.keys())) {
      this.settleCancelled(requestId, reason);
    }
  }

  getPending(sessionId?: string): readonly UserQuestion[] {
    const result: UserQuestion[] = [];
    for (const pending of this.pending.values()) {
      if (sessionId === undefined || pending.request.sessionId === sessionId) {
        result.push({ ...pending.request });
      }
    }
    return result;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAll("disposed");
    this.listeners.clear();
  }

  private settleCancelled(requestId: string, reason: UserQuestionCancelReason): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return false;
    }
    this.pending.delete(requestId);
    this.emit({ type: "cancelled", requestId, sessionId: pending.request.sessionId, reason });
    pending.resolve({ requestId, answer: "", cancelled: true });
    return true;
  }

  /** Ids are unique per broker, so a deterministic factory cannot collide. */
  private uniqueId(): string {
    const base = this.idFactory();
    if (!this.pending.has(base)) {
      return base;
    }
    let counter = 2;
    while (this.pending.has(`${base}-${counter}`)) {
      counter += 1;
    }
    return `${base}-${counter}`;
  }

  private emit(event: UserQuestionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
