import type { TaskDetail } from "./types";
import { api } from "./api";
import { useCallback, useEffect, useState } from "react";

export function useTaskDetail(taskId: string | undefined, intervalMs = 2500) {
  const [detail, setDetail] = useState<TaskDetail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!taskId) return;
    try {
      const next = await api.task(taskId);
      setDetail(next);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(), intervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, intervalMs]);

  return { detail, error, loading, refresh };
}
