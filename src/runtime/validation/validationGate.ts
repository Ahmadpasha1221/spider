import type { SourceValidationDiagnostic } from "./sourceIntegrityValidator";

export type RunStatus =
  | "planning"
  | "editing"
  | "validating"
  | "repairing"
  | "verified"
  | "blocked";

export interface FileVerificationRecord {
  readonly path: string;
  status: "verified" | "failed" | "unverified";
  repairAttempts: number;
  lastDiagnostics: readonly SourceValidationDiagnostic[];
  lastContentHash?: string;
  updatedAt: number;
}

export interface GateFinishEvaluation {
  readonly allowed: boolean;
  readonly status: RunStatus;
  readonly reason?: string;
  readonly unverifiedFiles: readonly string[];
  readonly failedFiles: readonly string[];
}

export class ValidationGate {
  private status: RunStatus = "planning";
  private readonly fileRecords = new Map<string, FileVerificationRecord>();
  public static readonly MAX_REPAIR_ATTEMPTS = 3;

  getStatus(): RunStatus {
    return this.status;
  }

  setStatus(nextStatus: RunStatus): void {
    this.status = nextStatus;
  }

  /**
   * Called when a tool begins editing or writing a file. Transitions state to "editing".
   */
  recordFileEdit(filePath: string): void {
    const existing = this.fileRecords.get(filePath);
    if (existing) {
      existing.status = "unverified";
      existing.updatedAt = Date.now();
    } else {
      this.fileRecords.set(filePath, {
        path: filePath,
        status: "unverified",
        repairAttempts: 0,
        lastDiagnostics: [],
        updatedAt: Date.now(),
      });
    }
    if (this.status !== "repairing") {
      this.status = "editing";
    }
  }

  /**
   * Called when deterministic validation passes for a file.
   */
  recordValidationPass(filePath: string, contentHash: string): void {
    const record = this.fileRecords.get(filePath) ?? {
      path: filePath,
      status: "verified" as const,
      repairAttempts: 0,
      lastDiagnostics: [],
      updatedAt: Date.now(),
    };
    record.status = "verified";
    record.lastDiagnostics = [];
    record.lastContentHash = contentHash;
    record.updatedAt = Date.now();
    this.fileRecords.set(filePath, record);

    // If all edited files are now verified, transition towards verified
    const allPassed = Array.from(this.fileRecords.values()).every((f) => f.status === "verified");
    if (allPassed && this.fileRecords.size > 0) {
      this.status = "validating";
    }
  }

  /**
   * Called when deterministic validation fails for a file.
   */
  recordValidationFailure(
    filePath: string,
    diagnostics: readonly SourceValidationDiagnostic[],
    contentHash: string,
  ): { canRepair: boolean; attempt: number; isBlocked: boolean } {
    let record = this.fileRecords.get(filePath);
    if (!record) {
      record = {
        path: filePath,
        status: "failed",
        repairAttempts: 1,
        lastDiagnostics: diagnostics,
        lastContentHash: contentHash,
        updatedAt: Date.now(),
      };
      this.fileRecords.set(filePath, record);
    } else {
      record.status = "failed";
      record.repairAttempts += 1;
      record.lastDiagnostics = diagnostics;
      record.lastContentHash = contentHash;
      record.updatedAt = Date.now();
    }

    const attempt = record.repairAttempts;
    const canRepair = attempt <= ValidationGate.MAX_REPAIR_ATTEMPTS;

    if (!canRepair) {
      this.status = "blocked";
      return { canRepair: false, attempt, isBlocked: true };
    }

    this.status = "repairing";
    return { canRepair: true, attempt, isBlocked: false };
  }

  /**
   * Evaluates whether the task is eligible to complete (call finish).
   * A task MAY ONLY finish if every written/modified file has status "verified".
   */
  evaluateCanFinish(): GateFinishEvaluation {
    const records = Array.from(this.fileRecords.values());
    const unverifiedFiles = records.filter((r) => r.status === "unverified").map((r) => r.path);
    const failedFiles = records.filter((r) => r.status === "failed").map((r) => r.path);

    if (failedFiles.length > 0) {
      return {
        allowed: false,
        status: this.status,
        reason: `Validation gate blocked: ${failedFiles.length} file(s) failed deterministic validation: ${failedFiles.join(", ")}. These must be repaired before finishing.`,
        unverifiedFiles,
        failedFiles,
      };
    }

    if (unverifiedFiles.length > 0) {
      return {
        allowed: false,
        status: this.status,
        reason: `Validation gate blocked: ${unverifiedFiles.length} file(s) have unverified edits: ${unverifiedFiles.join(", ")}. Every file must pass validation.`,
        unverifiedFiles,
        failedFiles,
      };
    }

    return {
      allowed: true,
      status: "verified",
      unverifiedFiles: [],
      failedFiles: [],
    };
  }

  getFileRecord(filePath: string): FileVerificationRecord | undefined {
    return this.fileRecords.get(filePath);
  }

  getAllRecords(): readonly FileVerificationRecord[] {
    return Array.from(this.fileRecords.values());
  }

  reset(): void {
    this.status = "planning";
    this.fileRecords.clear();
  }
}
