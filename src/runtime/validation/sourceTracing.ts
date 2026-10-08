import * as crypto from "node:crypto";

export type TraceBoundary =
  | "MODEL_OUTPUT_RAW"
  | "TOOL_CALL_PARSED"
  | "TOOL_ARGUMENT_NORMALIZED"
  | "FILE_WRITE_REQUEST"
  | "FILE_WRITE_COMPLETED"
  | "VALIDATION_RESULT";

export type ValidationStatus = "verified" | "failed" | "pending" | "skipped";

export interface TraceRecord {
  readonly traceId: string;
  readonly runId?: string;
  readonly sessionId: string;
  readonly iteration?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly tool?: string;
  readonly toolCallId?: string;
  readonly boundary: TraceBoundary;
  readonly file?: string;
  readonly contentHash?: string;
  readonly contentLength?: number;
  readonly validationType?: string;
  readonly validationStatus?: ValidationStatus;
  readonly durationMs?: number;
  readonly errorCategory?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly timestamp: number;
}

export interface CorruptionAnalysis {
  readonly corrupted: boolean;
  readonly corruptionOrigin?: "MODEL_OUTPUT" | "PARSER_SERIALIZER" | "TOOL_EXECUTION" | "FILESYSTEM";
  readonly details: string;
  readonly traces: readonly TraceRecord[];
}

export class SourceTracingManager {
  private static instance?: SourceTracingManager;
  private readonly records: TraceRecord[] = [];
  private readonly maxRecords: number = 2000;

  static getInstance(): SourceTracingManager {
    if (!SourceTracingManager.instance) {
      SourceTracingManager.instance = new SourceTracingManager();
    }
    return SourceTracingManager.instance;
  }

  static resetForTesting(): void {
    SourceTracingManager.instance = new SourceTracingManager();
  }

  record(entry: Omit<TraceRecord, "traceId" | "timestamp">): TraceRecord {
    const record: TraceRecord = {
      traceId: crypto.randomUUID(),
      timestamp: Date.now(),
      ...entry,
    };
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }
    return record;
  }

  getRecords(sessionId?: string, file?: string): readonly TraceRecord[] {
    return this.records.filter((r) => {
      if (sessionId && r.sessionId !== sessionId) {
        return false;
      }
      if (file && r.file !== file) {
        return false;
      }
      return true;
    });
  }

  computeHash(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
  }

  /**
   * Deterministically determines WHERE corruption was introduced across the pipeline:
   * Compares raw model output, parsed tool args, write request payload, and disk content.
   */
  analyzeCorruptionPipeline(sessionId: string, file: string, isSyntaxCorrupt: boolean): CorruptionAnalysis {
    const traces = this.getRecords(sessionId, file);
    if (!isSyntaxCorrupt) {
      return {
        corrupted: false,
        details: "No corruption detected in the pipeline.",
        traces,
      };
    }

    const rawOutput = traces.find((t) => t.boundary === "MODEL_OUTPUT_RAW");
    const parsedCall = traces.find((t) => t.boundary === "TOOL_CALL_PARSED");
    const normArg = traces.find((t) => t.boundary === "TOOL_ARGUMENT_NORMALIZED");
    const writeReq = traces.find((t) => t.boundary === "FILE_WRITE_REQUEST");
    const writeDone = traces.find((t) => t.boundary === "FILE_WRITE_COMPLETED");

    // 1. Check if write completed differs from write request
    if (writeReq && writeDone && writeReq.contentHash && writeDone.contentHash) {
      if (writeReq.contentHash !== writeDone.contentHash) {
        return {
          corrupted: true,
          corruptionOrigin: "FILESYSTEM",
          details: `Filesystem read-back hash (${writeDone.contentHash}) does not match write request hash (${writeReq.contentHash}). Corruption introduced during write or by filesystem.`,
          traces,
        };
      }
    }

    // 2. Check if write request payload differs from normalized tool argument
    if (normArg && writeReq && normArg.contentHash && writeReq.contentHash) {
      if (normArg.contentHash !== writeReq.contentHash) {
        return {
          corrupted: true,
          corruptionOrigin: "TOOL_EXECUTION",
          details: `Write request payload hash (${writeReq.contentHash}) differs from normalized tool argument hash (${normArg.contentHash}). Corruption introduced in tool executor (e.g. edit_file string replacement).`,
          traces,
        };
      }
    }

    // 3. Check if tool call arguments differ from parsed call
    if (parsedCall && normArg && parsedCall.contentHash && normArg.contentHash) {
      if (parsedCall.contentHash !== normArg.contentHash) {
        return {
          corrupted: true,
          corruptionOrigin: "PARSER_SERIALIZER",
          details: `Tool argument normalization altered content (hash changed from ${parsedCall.contentHash} to ${normArg.contentHash}). Corruption introduced during tool parsing/serialization.`,
          traces,
        };
      }
    }

    // 4. If all hashes match or raw output matches parsed tool argument, the corruption originated in the model output
    const rawHashInfo = rawOutput ? ` (raw model output hash: ${rawOutput.contentHash ?? "none"})` : "";
    return {
      corrupted: true,
      corruptionOrigin: "MODEL_OUTPUT",
      details: `Corruption was already present in the raw model output before Spider processed or wrote the file${rawHashInfo}.`,
      traces,
    };
  }

  clear(): void {
    this.records.length = 0;
  }
}
