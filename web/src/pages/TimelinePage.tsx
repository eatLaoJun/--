import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { TrajectoryView } from "../components/TrajectoryView";
import type { EventItem } from "../types";
import { useTaskDetail } from "../useTaskDetail";

export function TimelinePage() {
  const { taskId } = useParams();
  const { detail, loading, error } = useTaskDetail(taskId);
  const [events, setEvents] = useState<EventItem[]>([]);

  useEffect(() => {
    if (!taskId) return;
    const id = taskId;
    let cancelled = false;
    async function load() {
      try {
        const result = await api.events(id, 800);
        if (!cancelled) setEvents(result.events);
      } catch {
        // Keep the last successful snapshot.
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [taskId]);

  if (loading && !detail) return <div className="empty-small">加载轨迹…</div>;
  if (error && !detail) return <div className="empty-small error">{error}</div>;
  if (!detail) return <div className="empty-small">任务不存在。</div>;

  return (
    <div className="console-page trajectory-page">
      <header className="page-head">
        <div>
          <p className="eyebrow">TRAJECTORY / AUDIT</p>
          <h2>Runtime log / 审计时间线</h2>
          <p className="muted">{detail.task.ticketId} · {detail.task.title}</p>
          <p className="hint">同一份轨迹的两种视图：上方是时间概览，下方是阶段/轮次/工具 ledger；点击记录打开右侧 inspector。</p>
        </div>
        <div className="head-actions">
          <Link className="ghost" to={`/tasks/${detail.task.id}`}>返回概览</Link>
          <Link className="ghost" to={`/tasks/${detail.task.id}/diff`}>Diff / 证据</Link>
        </div>
      </header>

      <nav className="page-links">
        <Link to={`/tasks/${detail.task.id}`}>概览</Link>
        <Link to={`/tasks/${detail.task.id}/diff`}>Diff / 证据</Link>
        <Link to={`/tasks/${detail.task.id}/timeline`} className="active">Runtime log / 审计时间线</Link>
      </nav>

      <TrajectoryView
        key={detail.task.id}
        task={detail.task}
        events={events.length ? events : detail.events}
        verifications={detail.verifications}
      />
    </div>
  );
}
