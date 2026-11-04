import path from "node:path";
import { appendJsonl, ensureDir, readJsonl } from "../utils/paths.js";
import { randomUUID } from "node:crypto";

export type ReviewRole = "engineer" | "assistant" | "system";

export interface ReviewMessage {
  id: string;
  taskId: string;
  role: ReviewRole;
  content: string;
  at: number;
  meta?: Record<string, unknown>;
}

export class ReviewChatStore {
  constructor(private readonly root: string) {}

  private file(taskId: string): string {
    return path.join(this.root, "tasks", taskId, "review-chat.jsonl");
  }

  async append(input: Omit<ReviewMessage, "id" | "at"> & { id?: string; at?: number }): Promise<ReviewMessage> {
    await ensureDir(path.dirname(this.file(input.taskId)));
    const message: ReviewMessage = {
      id: input.id ?? `R-${Date.now()}-${randomUUID().slice(0, 6)}`,
      taskId: input.taskId,
      role: input.role,
      content: input.content,
      at: input.at ?? Date.now(),
      meta: input.meta,
    };
    await appendJsonl(this.file(input.taskId), message);
    return message;
  }

  async list(taskId: string): Promise<ReviewMessage[]> {
    return readJsonl<ReviewMessage>(this.file(taskId));
  }
}
