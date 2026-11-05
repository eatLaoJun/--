import path from "node:path";
import { readJson } from "../utils/paths.js";

export interface Incident {
  id: string;
  source: "event-center" | "github" | "jira" | "sentry" | string;
  externalId: string;
  title: string;
  description: string;
  expected: string;
  service: string;
  severity?: string;
  reporter?: string;
  url?: string;
  dedupeKey: string;
  createdAt: number;
}

export interface EventCenterAdapter {
  readonly name: string;
  listOpen(): Promise<Incident[]>;
  get(id: string): Promise<Incident | undefined>;
  postComment(id: string, body: string): Promise<void>;
  close(id: string, resolution: string): Promise<void>;
}

export class LocalEventCenter implements EventCenterAdapter {
  readonly name = "local-event-center";

  constructor(private readonly projectRoot: string) {}

  private async all(): Promise<Incident[]> {
    const file = path.join(this.projectRoot, "fixtures", "event-center", "incidents.json");
    const incidents = await readJson<Incident[]>(file);
    if (!incidents) throw new Error(`Event center fixture not found: ${file}`);
    return incidents;
  }

  async listOpen(): Promise<Incident[]> {
    return (await this.all()).filter((incident) => incident.dedupeKey);
  }

  async get(id: string): Promise<Incident | undefined> {
    const incidents = await this.all();
    return incidents.find((incident) => incident.id === id || incident.externalId === id);
  }

  async postComment(id: string, body: string): Promise<void> {
    // Local adapter records the comment through the task event log instead of
    // mutating a remote system. The production adapter would call the event API.
    void id;
    void body;
  }

  async close(id: string, resolution: string): Promise<void> {
    void id;
    void resolution;
  }
}

export async function listIncidents(projectRoot: string): Promise<Incident[]> {
  return new LocalEventCenter(projectRoot).listOpen();
}

export async function getIncident(projectRoot: string, id: string): Promise<Incident> {
  const incident = await new LocalEventCenter(projectRoot).get(id);
  if (!incident) throw new Error(`Incident not found: ${id}`);
  return incident;
}
