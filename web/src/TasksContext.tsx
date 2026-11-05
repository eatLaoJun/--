import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import type { IncidentFixture, IssueFixture, TaskSummary } from "./types";

interface TasksContextValue {
  tasks: TaskSummary[];
  issues: IssueFixture[];
  incidents: IncidentFixture[];
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
  createTask: (input: { incident?: string; issue?: string }) => Promise<string>;
}

const TasksContext = createContext<TasksContextValue | undefined>(undefined);

export function TasksProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [issues, setIssues] = useState<IssueFixture[]>([]);
  const [incidents, setIncidents] = useState<IncidentFixture[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const [nextTasks, nextIssues, nextIncidents] = await Promise.all([api.tasks(), api.issues(), api.incidents()]);
      setTasks(nextTasks);
      setIssues(nextIssues);
      setIncidents(nextIncidents);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const createTask = useCallback(
    async (input: { incident?: string; issue?: string }) => {
      const created = await api.createTask(input);
      await refresh();
      return created.task.id;
    },
    [refresh],
  );

  const value = useMemo(
    () => ({ tasks, issues, incidents, loading, error, refresh, createTask }),
    [tasks, issues, incidents, loading, error, refresh, createTask],
  );
  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>;
}

export function useTasks(): TasksContextValue {
  const value = useContext(TasksContext);
  if (!value) throw new Error("useTasks must be used inside TasksProvider");
  return value;
}
