import type { EventItem, IncidentFixture, IssueFixture, Task, TaskDetail, TaskSummary } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || `HTTP ${response.status}`);
  return data as T;
}

export const api = {
  tasks: (params?: Record<string, string>) => {
    const query = params ? `?${new URLSearchParams(params).toString()}` : "";
    return request<TaskSummary[]>(`/api/tasks${query}`);
  },
  task: (id: string) => request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`),
  events: (id: string, limit = 600) =>
    request<{ taskId: string; events: EventItem[]; total: number }>(
      `/api/tasks/${encodeURIComponent(id)}/events?limit=${limit}`,
    ),
  issues: () => request<IssueFixture[]>("/api/issues"),
  incidents: () => request<IncidentFixture[]>("/api/incidents"),
  createTask: (input: { incident?: string; issue?: string }) =>
    request<{ task: Task }>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),
  approve: (id: string) =>
    request<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}/approve`, { method: "POST" }),
  requestChanges: (id: string, message: string) =>
    request<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}/request-changes`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  cancel: (id: string) =>
    request<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
};
