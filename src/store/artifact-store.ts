import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { atomicWriteJson, ensureDir, readJson } from "../utils/paths.js";
import { sha256 } from "../utils/text.js";

export interface ArtifactMeta {
  id: string;
  taskId: string;
  kind: string;
  name?: string;
  bytes: number;
  createdAt: number;
  preview: string;
}

export class ArtifactStore {
  constructor(private readonly root: string) {}

  private dir(): string {
    return path.join(this.root, "artifacts");
  }

  async put(content: string, meta: Omit<ArtifactMeta, "id" | "bytes" | "createdAt" | "preview">): Promise<ArtifactMeta> {
    await ensureDir(this.dir());
    const id = sha256(content);
    const file = path.join(this.dir(), id);
    await writeFile(file, content, "utf8");
    const record: ArtifactMeta = {
      id,
      taskId: meta.taskId,
      kind: meta.kind,
      name: meta.name,
      bytes: Buffer.byteLength(content),
      createdAt: Date.now(),
      preview: content.slice(0, 240).replace(/\s+/g, " "),
    };
    await atomicWriteJson(path.join(this.dir(), `${id}.json`), record);
    return record;
  }

  async get(id: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`Invalid artifact id: ${id}`);
    return readFile(path.join(this.dir(), id), "utf8");
  }

  async getSlice(id: string, offset = 0, limit = 8000): Promise<{ content: string; totalChars: number }> {
    const content = await this.get(id);
    const start = Math.max(0, offset);
    return {
      content: content.slice(start, start + Math.max(1, limit)),
      totalChars: content.length,
    };
  }

  async info(id: string): Promise<ArtifactMeta | undefined> {
    if (!/^[a-f0-9]{64}$/.test(id)) return undefined;
    return readJson<ArtifactMeta>(path.join(this.dir(), `${id}.json`));
  }
}
