import path from "node:path";
import { appendJsonl } from "../utils/paths.js";

export interface TraceEvent {
  at: number;
  taskId: string;
  type: string;
  stage?: string;
  detail?: Record<string, unknown>;
}

export class EventLog {
  constructor(private readonly root: string) {}

  private file(taskId: string): string {
    return path.join(this.root, "tasks", taskId, "events.jsonl");
  }

  async append(event: Omit<TraceEvent, "at"> & { at?: number }): Promise<void> {
    await appendJsonl(this.file(event.taskId), { at: event.at ?? Date.now(), ...event });
  }
}
