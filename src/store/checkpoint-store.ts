import path from "node:path";
import { atomicWriteJson, ensureDir, readJson, readJsonl } from "../utils/paths.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import type { VerificationRecord } from "../domain/types.js";

export class CheckpointStore {
  constructor(private readonly root: string) {}

  private dir(taskId: string): string {
    return path.join(this.root, "tasks", taskId, "checkpoints");
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    await ensureDir(this.dir(checkpoint.taskId));
    await atomicWriteJson(path.join(this.dir(checkpoint.taskId), `${checkpoint.id}.json`), checkpoint);
    await atomicWriteJson(path.join(this.dir(checkpoint.taskId), "latest.json"), checkpoint);
  }

  async latest(taskId: string): Promise<Checkpoint | undefined> {
    return readJson<Checkpoint>(path.join(this.dir(taskId), "latest.json"));
  }
}

export class VerificationStore {
  constructor(private readonly root: string) {}

  private file(taskId: string): string {
    return path.join(this.root, "tasks", taskId, "verifications.jsonl");
  }

  async append(record: VerificationRecord): Promise<void> {
    await ensureDir(path.dirname(this.file(record.taskId)));
    const { appendJsonl } = await import("../utils/paths.js");
    await appendJsonl(this.file(record.taskId), record);
  }

  async list(taskId: string): Promise<VerificationRecord[]> {
    return readJsonl<VerificationRecord>(this.file(taskId));
  }

  async latest(taskId: string, kind?: VerificationRecord["kind"]): Promise<VerificationRecord | undefined> {
    const records = await this.list(taskId);
    for (let i = records.length - 1; i >= 0; i -= 1) {
      if (!kind || records[i].kind === kind) return records[i];
    }
    return undefined;
  }
}
