import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../domain/types.js";
import { atomicWriteJson, ensureDir, readJson } from "../utils/paths.js";
import { readdir as fsReaddir } from "node:fs/promises";

export class VersionConflictError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`Task ${taskId} version conflict: expected ${expected}, actual ${actual}`);
    this.name = "VersionConflictError";
  }
}

export class TaskStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  private dir(): string {
    return path.join(this.root, "tasks");
  }

  private file(taskId: string): string {
    return path.join(this.dir(), `${taskId}.json`);
  }

  async create(task: Task): Promise<Task> {
    await ensureDir(this.dir());
    await atomicWriteJson(this.file(task.id), task);
    return task;
  }

  async get(taskId: string): Promise<Task | undefined> {
    return readJson<Task>(this.file(taskId));
  }

  async list(): Promise<Task[]> {
    try {
      const names = await fsReaddir(this.dir());
      const tasks: Task[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const task = await readJson<Task>(path.join(this.dir(), name));
        if (task) tasks.push(task);
      }
      return tasks.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Compare-and-swap save. */
  async save(task: Task, expectedVersion: number): Promise<Task> {
    return this.withLock(task.id, async () => {
      const current = await this.get(task.id);
      if (!current) throw new Error(`Task not found: ${task.id}`);
      if (current.version !== expectedVersion) {
        throw new VersionConflictError(task.id, expectedVersion, current.version);
      }
      const next: Task = {
        ...task,
        version: expectedVersion + 1,
        updatedAt: Date.now(),
      };
      await atomicWriteJson(this.file(task.id), next);
      return next;
    });
  }

  /** Load, mutate and save under an in-process lock. */
  async update(taskId: string, mutator: (task: Task) => Task | void | Promise<Task | void>): Promise<Task> {
    return this.withLock(taskId, async () => {
      const current = await this.get(taskId);
      if (!current) throw new Error(`Task not found: ${taskId}`);
      const draft = structuredClone(current);
      const result = await mutator(draft);
      const next = (result ?? draft) as Task;
      next.version = current.version + 1;
      next.updatedAt = Date.now();
      await atomicWriteJson(this.file(taskId), next);
      return next;
    });
  }

  /**
   * Update only if the task version still matches. Used by executors that hold a
   * lease: a stale executor cannot overwrite a newer cancel/pause state.
   */
  async updateIfVersion(
    taskId: string,
    expectedVersion: number,
    mutator: (task: Task) => Task | void,
  ): Promise<Task> {
    return this.withLock(taskId, async () => {
      const current = await this.get(taskId);
      if (!current) throw new Error(`Task not found: ${taskId}`);
      if (current.version !== expectedVersion) {
        throw new VersionConflictError(taskId, expectedVersion, current.version);
      }
      const draft = structuredClone(current);
      const result = mutator(draft);
      const next = (result ?? draft) as Task;
      next.version = current.version + 1;
      next.updatedAt = Date.now();
      await atomicWriteJson(this.file(taskId), next);
      return next;
    });
  }

  private async withLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => gate);
    this.locks.set(taskId, chain);
    try {
      await previous;
      return await fn();
    } finally {
      release();
      if (this.locks.get(taskId) === chain) this.locks.delete(taskId);
    }
  }
}

/** Best-effort directory listing helper used by stores and reports. */
export async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await fsReaddir(dir)).map((name) => path.join(dir, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export function newTaskId(): string {
  return `T-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
}
