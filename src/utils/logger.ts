export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  operation?: string;
  requestId?: string;
  sessionId?: string;
  /** Structured tool-execution context (name, timing, size, outcome). */
  toolName?: string;
  durationMs?: number;
  resultBytes?: number;
  outcome?: string;
}

const LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

function formatEntry(entry: LogEntry): string {
  const base = `${entry.timestamp} [${entry.level}] ${entry.component}: ${entry.message}`;
  const extras: Record<string, string | number | undefined> = {
    operation: entry.operation,
    requestId: entry.requestId,
    sessionId: entry.sessionId,
    toolName: entry.toolName,
    durationMs: entry.durationMs,
    resultBytes: entry.resultBytes,
    outcome: entry.outcome,
  };
  const included = Object.entries(extras).filter(([, value]) => value !== undefined);
  if (included.length === 0) {
    return base;
  }
  return `${base} (${included.map(([key, value]) => `${key}=${value}`).join(", ")})`;
}

export class Logger {
  private readonly component: string;
  private readonly level: LogLevel;

  constructor(component: string, level: LogLevel = "INFO") {
    this.component = component;
    this.level = level;
  }

  debug(message: string, context: Omit<LogEntry, "timestamp" | "level" | "component" | "message"> = {}): void {
    this.log("DEBUG", message, context);
  }

  info(message: string, context: Omit<LogEntry, "timestamp" | "level" | "component" | "message"> = {}): void {
    this.log("INFO", message, context);
  }

  warn(message: string, context: Omit<LogEntry, "timestamp" | "level" | "component" | "message"> = {}): void {
    this.log("WARN", message, context);
  }

  error(message: string, context: Omit<LogEntry, "timestamp" | "level" | "component" | "message"> = {}): void {
    this.log("ERROR", message, context);
  }

  private log(level: LogLevel, message: string, context: Omit<LogEntry, "timestamp" | "level" | "component" | "message">): void {
    if (LEVELS[level] < LEVELS[this.level]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      operation: context.operation,
      requestId: context.requestId,
      sessionId: context.sessionId,
      toolName: context.toolName,
      durationMs: context.durationMs,
      resultBytes: context.resultBytes,
      outcome: context.outcome,
    };

    console.log(formatEntry(entry));
  }
}
