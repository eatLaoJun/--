import path from "node:path";
import { atomicWriteJson, ensureDir, readJson } from "../utils/paths.js";
import { sha256 } from "../utils/text.js";
import { readdir } from "node:fs/promises";

export type OperationStatus = "pending" | "done" | "unknown" | "failed";

export interface OperationRecord {
  opKey: string;
  fileName: string;
  taskId: string;
  toolName: string;
  inputHash: string;
  status: OperationStatus;
  attempts: number;
  result?: unknown;
  artifactId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export class OperationInFlightError extends Error {
  constructor(public readonly record: OperationRecord) {
    super(
      `Operation ${record.toolName} is ${record.status}; reconcile the external state before retrying ` +
        `(opKey=${record.opKey.slice(0, 16)}...)`,
    );
    this.name = "OperationInFlightError";
  }
}

export class OperationStore {
  constructor(private readonly root: string) {}

  private dir(taskId: string): string {
    return path.join(this.root, "tasks", taskId, "operations");
  }

  private fileName(opKey: string): string {
    return `${sha256(opKey).slice(0, 20)}.json`;
  }

  private file(taskId: string, opKey: string): string {
    return path.join(this.dir(taskId), this.fileName(opKey));
  }

  async get(taskId: string, opKey: string): Promise<OperationRecord | undefined> {
    return readJson<OperationRecord>(this.file(taskId, opKey));
  }

  async list(taskId: string): Promise<OperationRecord[]> {
    try {
      const names = await readdir(this.dir(taskId));
      const records: OperationRecord[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const record = await readJson<OperationRecord>(path.join(this.dir(taskId), name));
        if (record) records.push(record);
      }
      return records.sort((a, b) => a.createdAt - b.createdAt);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async begin(input: {
    taskId: string;
    opKey: string;
    toolName: string;
    inputHash: string;
    maxAttempts?: number;
  }): Promise<{ record: OperationRecord; replay: boolean }> {
    await ensureDir(this.dir(input.taskId));
    const existing = await this.get(input.taskId, input.opKey);
    if (existing) {
      if (existing.inputHash !== input.inputHash) {
        throw new Error(
          `Semantic operation key reused with different input: ${existing.toolName}. ` +
            `This indicates a versioning bug; derive a new key when inputs change.`,
        );
      }
      if (existing.status === "done") return { record: existing, replay: true };
      if (existing.status === "pending" || existing.status === "unknown") {
        throw new OperationInFlightError(existing);
      }
      if (existing.status === "failed") {
        const max = input.maxAttempts ?? 3;
        if (existing.attempts >= max) {
          throw new Error(`Operation ${existing.toolName} exhausted attempts (${existing.attempts}/${max})`);
        }
        const next: OperationRecord = {
          ...existing,
          status: "pending",
          attempts: existing.attempts + 1,
          updatedAt: Date.now(),
        };
        await atomicWriteJson(this.file(input.taskId, input.opKey), next);
        return { record: next, replay: false };
      }
    }
    const record: OperationRecord = {
      opKey: input.opKey,
      fileName: this.fileName(input.opKey),
      taskId: input.taskId,
      toolName: input.toolName,
      inputHash: input.inputHash,
      status: "pending",
      attempts: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await atomicWriteJson(this.file(input.taskId, input.opKey), record);
    return { record, replay: false };
  }

  async complete(record: OperationRecord, result: unknown, artifactId?: string): Promise<OperationRecord> {
    const next: OperationRecord = {
      ...record,
      status: "done",
      result,
      artifactId,
      error: undefined,
      updatedAt: Date.now(),
    };
    await atomicWriteJson(this.file(record.taskId, record.opKey), next);
    return next;
  }

  async fail(record: OperationRecord, error: string): Promise<OperationRecord> {
    const next: OperationRecord = {
      ...record,
      status: "failed",
      error,
      updatedAt: Date.now(),
    };
    await atomicWriteJson(this.file(record.taskId, record.opKey), next);
    return next;
  }

  async markUnknown(record: OperationRecord, note: string): Promise<OperationRecord> {
    const next: OperationRecord = {
      ...record,
      status: "unknown",
      error: note,
      updatedAt: Date.now(),
    };
    await atomicWriteJson(this.file(record.taskId, record.opKey), next);
    return next;
  }
}

export function semanticOperationKey(input: {
  taskId: string;
  opType: string;
  target: string;
  inputHash: string;
  version?: string;
}): string {
  return [
    `task:${input.taskId}`,
    `op:${input.opType}`,
    `target:${input.target}`,
    `input:${input.inputHash}`,
    `version:${input.version ?? "1"}`,
  ].join("|");
}
