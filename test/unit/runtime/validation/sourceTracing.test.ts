import { beforeEach, describe, expect, it } from "vitest";
import { SourceTracingManager } from "../../../../src/runtime/validation/sourceTracing";

describe("SourceTracingManager", () => {
  beforeEach(() => {
    SourceTracingManager.resetForTesting();
  });

  it("records boundary events across the pipeline", () => {
    const tracer = SourceTracingManager.getInstance();
    tracer.record({
      sessionId: "s1",
      boundary: "MODEL_OUTPUT_RAW",
      contentLength: 100,
      contentHash: "hashA",
    });

    tracer.record({
      sessionId: "s1",
      boundary: "TOOL_CALL_PARSED",
      tool: "write_file",
      contentLength: 100,
      contentHash: "hashA",
    });

    const records = tracer.getRecords("s1");
    expect(records).toHaveLength(2);
    expect(records[0]?.boundary).toBe("MODEL_OUTPUT_RAW");
    expect(records[1]?.boundary).toBe("TOOL_CALL_PARSED");
  });

  it("determines corruption originated in MODEL_OUTPUT when all hashes match", () => {
    const tracer = SourceTracingManager.getInstance();
    const badHash = "hashBad";

    tracer.record({ sessionId: "s1", file: "src/App.tsx", boundary: "MODEL_OUTPUT_RAW", contentHash: badHash });
    tracer.record({ sessionId: "s1", file: "src/App.tsx", boundary: "TOOL_CALL_PARSED", contentHash: badHash });
    tracer.record({ sessionId: "s1", file: "src/App.tsx", boundary: "TOOL_ARGUMENT_NORMALIZED", contentHash: badHash });
    tracer.record({ sessionId: "s1", file: "src/App.tsx", boundary: "FILE_WRITE_REQUEST", contentHash: badHash });
    tracer.record({ sessionId: "s1", file: "src/App.tsx", boundary: "FILE_WRITE_COMPLETED", contentHash: badHash });

    const analysis = tracer.analyzeCorruptionPipeline("s1", "src/App.tsx", true);
    expect(analysis.corrupted).toBe(true);
    expect(analysis.corruptionOrigin).toBe("MODEL_OUTPUT");
    expect(analysis.details).toContain("already present in the raw model output");
  });

  it("detects corruption introduced during tool execution (e.g. replace bug)", () => {
    const tracer = SourceTracingManager.getInstance();
    tracer.record({ sessionId: "s1", file: "src/App.tsx", boundary: "TOOL_ARGUMENT_NORMALIZED", contentHash: "goodHash" });
    tracer.record({ sessionId: "s1", file: "src/App.tsx", boundary: "FILE_WRITE_REQUEST", contentHash: "mangledHash" });

    const analysis = tracer.analyzeCorruptionPipeline("s1", "src/App.tsx", true);
    expect(analysis.corrupted).toBe(true);
    expect(analysis.corruptionOrigin).toBe("TOOL_EXECUTION");
    expect(analysis.details).toContain("Corruption introduced in tool executor");
  });

  it("detects corruption introduced by filesystem read-back mismatch", () => {
    const tracer = SourceTracingManager.getInstance();
    tracer.record({ sessionId: "s1", file: "src/App.tsx", boundary: "FILE_WRITE_REQUEST", contentHash: "hashReq" });
    tracer.record({ sessionId: "s1", file: "src/App.tsx", boundary: "FILE_WRITE_COMPLETED", contentHash: "hashMismatched" });

    const analysis = tracer.analyzeCorruptionPipeline("s1", "src/App.tsx", true);
    expect(analysis.corrupted).toBe(true);
    expect(analysis.corruptionOrigin).toBe("FILESYSTEM");
    expect(analysis.details).toContain("Filesystem read-back hash");
  });
});
