import { describe, expect, it } from "vitest";
import { ValidationGate } from "../../../../src/runtime/validation/validationGate";

describe("ValidationGate", () => {
  it("initial state is planning and allows finish if no files were touched", () => {
    const gate = new ValidationGate();
    expect(gate.getStatus()).toBe("planning");
    const evaluation = gate.evaluateCanFinish();
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.status).toBe("verified");
  });

  it("blocks finish when a file is edited and unverified", () => {
    const gate = new ValidationGate();
    gate.recordFileEdit("src/App.tsx");
    expect(gate.getStatus()).toBe("editing");

    const evaluation = gate.evaluateCanFinish();
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reason).toContain("unverified edits");
    expect(evaluation.unverifiedFiles).toContain("src/App.tsx");
  });

  it("allows finish when all edited files are verified", () => {
    const gate = new ValidationGate();
    gate.recordFileEdit("src/App.tsx");
    gate.recordValidationPass("src/App.tsx", "hash123");

    const evaluation = gate.evaluateCanFinish();
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.status).toBe("verified");
  });

  it("transitions to repairing on failure, and blocks finish while failed", () => {
    const gate = new ValidationGate();
    gate.recordFileEdit("src/App.tsx");
    const failResult = gate.recordValidationFailure(
      "src/App.tsx",
      [{ message: "Syntax error", severity: "error" }],
      "badhash",
    );

    expect(failResult.canRepair).toBe(true);
    expect(failResult.attempt).toBe(1);
    expect(gate.getStatus()).toBe("repairing");

    const evaluation = gate.evaluateCanFinish();
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reason).toContain("failed deterministic validation");
    expect(evaluation.failedFiles).toContain("src/App.tsx");
  });

  it("enforces maximum 3 repair attempts and halts as blocked", () => {
    const gate = new ValidationGate();
    gate.recordFileEdit("src/App.tsx");

    // Attempt 1
    const res1 = gate.recordValidationFailure("src/App.tsx", [{ message: "Err 1", severity: "error" }], "h1");
    expect(res1.canRepair).toBe(true);
    expect(gate.getStatus()).toBe("repairing");

    // Attempt 2
    const res2 = gate.recordValidationFailure("src/App.tsx", [{ message: "Err 2", severity: "error" }], "h2");
    expect(res2.canRepair).toBe(true);

    // Attempt 3
    const res3 = gate.recordValidationFailure("src/App.tsx", [{ message: "Err 3", severity: "error" }], "h3");
    expect(res3.canRepair).toBe(true);
    expect(res3.isBlocked).toBe(false);

    // Attempt 4 -> exceeds MAX_REPAIR_ATTEMPTS
    const res4 = gate.recordValidationFailure("src/App.tsx", [{ message: "Err 4", severity: "error" }], "h4");
    expect(res4.canRepair).toBe(false);
    expect(res4.isBlocked).toBe(true);
    expect(gate.getStatus()).toBe("blocked");

    const evaluation = gate.evaluateCanFinish();
    expect(evaluation.allowed).toBe(false);
  });
});
