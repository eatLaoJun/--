import path from "node:path";
import { appendFile, readFile } from "node:fs/promises";
import type { PrRecord } from "../domain/types.js";
import { appendJsonl, ensureDir, readJson, readJsonl } from "../utils/paths.js";
import { sha256 } from "../utils/text.js";

export interface CreatePrInput {
  taskId: string;
  repo: string;
  branch: string;
  base: string;
  headCommit: string;
  title: string;
  body: string;
}

export interface PrAdapter {
  findByTask(taskId: string): Promise<PrRecord | undefined>;
  findByBranch(repo: string, branch: string): Promise<PrRecord | undefined>;
  get(id: string): Promise<PrRecord | undefined>;
  create(input: CreatePrInput): Promise<PrRecord>;
  list(): Promise<PrRecord[]>;
}

/**
 * Local PR adapter used by the demo. It mimics the two properties that matter for
 * idempotent delivery: a PR can be queried by task/branch, and creation has a
 * stable marker so recovery can reconcile an unknown response.
 */
export class LocalPrAdapter implements PrAdapter {
  constructor(private readonly root: string) {}

  private file(): string {
    return path.join(this.root, "prs.jsonl");
  }

  private recordFile(id: string): string {
    return path.join(this.root, "prs", `${id}.json`);
  }

  async findByTask(taskId: string): Promise<PrRecord | undefined> {
    const all = await this.list();
    return all.find((pr) => pr.taskId === taskId && pr.status !== "closed");
  }

  async findByBranch(repo: string, branch: string): Promise<PrRecord | undefined> {
    const all = await this.list();
    return all.find((pr) => pr.repo === repo && pr.branch === branch && pr.status !== "closed");
  }

  async get(id: string): Promise<PrRecord | undefined> {
    return readJson<PrRecord>(this.recordFile(id));
  }

  async create(input: CreatePrInput): Promise<PrRecord> {
    const existing = (await this.findByTask(input.taskId)) ?? (await this.findByBranch(input.repo, input.branch));
    if (existing) return existing;
    const id = `PR-${sha256(`${input.taskId}|${input.repo}|${input.branch}|${input.headCommit}`).slice(0, 10)}`;
    const record: PrRecord = {
      id,
      url: `local://pr/${id}`,
      taskId: input.taskId,
      repo: input.repo,
      branch: input.branch,
      base: input.base,
      headCommit: input.headCommit,
      title: input.title,
      body: `${input.body}\n\n[forgepilot:task:${input.taskId}]`,
      status: "open",
      createdAt: Date.now(),
    };
    await ensureDir(path.dirname(this.recordFile(id)));
    await appendJsonl(this.file(), record);
    const { atomicWriteJson } = await import("../utils/paths.js");
    await atomicWriteJson(this.recordFile(id), record);
    return record;
  }

  async list(): Promise<PrRecord[]> {
    try {
      return await readJsonl<PrRecord>(this.file());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Test hook: append a raw record exactly once, as a local external system would. */
  async appendForTest(record: PrRecord): Promise<void> {
    await ensureDir(path.dirname(this.recordFile(record.id)));
    await appendFile(this.file(), JSON.stringify(record) + "\n", "utf8");
    const { atomicWriteJson } = await import("../utils/paths.js");
    await atomicWriteJson(this.recordFile(record.id), record);
  }
}

export async function readPrFile(file: string): Promise<PrRecord[]> {
  return readJsonl<PrRecord>(file);
}

export async function readPrJson(file: string): Promise<PrRecord | undefined> {
  return readJson<PrRecord>(file);
}
