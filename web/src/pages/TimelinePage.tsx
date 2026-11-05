import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { Badge } from "../components/Badge";
import { eventLabel, eventTone, time } from "../format";
import type { EventItem } from "../types";
import { useTaskDetail } from "../useTaskDetail";
import { summarizeEvent } from "../event-summary";

const FILTERS = [
  { value: "all", label: "全部" },
  { value: "tool_call", label: "工具" },
  { value: "flow", label: "流程" },
  { value: "agent_turn", label: "AI turn" },
  { value: "verification", label: "验证" },
  { value: "context_metrics", label: "上下文" },
  { value: "approval", label: "审批/交付" },
  { value: "error", label: "失败/恢复" },
];

function matchesFilter(event: EventItem, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "tool_call") return event.type === "tool_call" || event.type === "tool_result";
  if (filter === "verification") return event.type === "verification";
  if (filter === "flow") return ["task_created", "incident_ingested", "repository_resolved", "plan_recorded", "stage_advanced", "package_created", "waiting_approval", "approved", "branch_published", "pr_created", "delivered"].includes(event.type);
  if (filter === "agent_turn") return event.type === "agent_turn";
  if (filter === "context_metrics") return event.type === "context_metrics";
  if (filter === "approval") return ["changes_requested", "approved", "waiting_approval", "package_created", "branch_published", "pr_created", "delivered"].includes(event.type);
  if (filter === "error") return ["task_failed", "background_run_failed", "cancelled", "recovery"].includes(event.type);
  return true;
}

export function TimelinePage() {
  const { taskId } = useParams();
  const { detail, loading, error } = useTaskDetail(taskId);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [filter, setFilter] = useState("all");
  const [newestFirst, setNewestFirst] = useState(true);

  useEffect(() => {
    if (!taskId) return;
    const id = taskId;
    let cancelled = false;
    async function load() {
      try {
        const result = await api.events(id, 800);
        if (!cancelled) setEvents(result.events);
      } catch {
        // keep the last successful snapshot
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [taskId]);

  const filtered = useMemo(() => {
    const list = events.filter((event) => matchesFilter(event, filter));
    return newestFirst ? [...list].reverse() : list;
  }, [events, filter, newestFirst]);

  if (loading && !detail) return <div className="empty-small">加载时间线…</div>;
  if (error && !detail) return <div className="empty-small error">{error}</div>;
  if (!detail) return <div className="empty-small">任务不存在。</div>;

  return (
    <div className="console-page">
      <header className="page-head">
        <div>
          <p className="eyebrow">RUNTIME LOG / AUDIT</p>
          <h2>Runtime log / 审计时间线</h2>
          <p className="muted">{detail.task.ticketId} · {detail.task.title}</p>
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

      <div className="timeline-toolbar">
        <div className="filter-chips">
          {FILTERS.map((item) => (
            <button key={item.value} className={filter === item.value ? "chip active" : "chip"} onClick={() => setFilter(item.value)}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="timeline-actions">
          <span className="hint">{filtered.length} / {events.length} events</span>
          <button className="link" onClick={() => setNewestFirst((value) => !value)}>
            {newestFirst ? "最新在上 ↓" : "最早在上 ↑"}
          </button>
        </div>
      </div>

      <div className="timeline-list">
        {filtered.length === 0 ? <div className="empty-small">这个筛选条件下没有事件。</div> : null}
        {filtered.map((event, index) => (
          <article className="timeline-event" key={`${event.at}-${event.type}-${index}`}>
            <div className={`timeline-dot ${eventTone(event.type)}`} />
            <div className="timeline-body">
              <div className="event-head">
                <div>
                  <span className={`event-type ${eventTone(event.type)}`}>{eventLabel(event.type)}</span>
                  <span className="event-raw-type">{event.type}</span>
                  {event.stage ? <span className="stage-pill">{event.stage}</span> : null}
                </div>
                <time>{time(event.at)}</time>
              </div>
              <div className="event-summary">{summarizeEvent(event)}</div>
              <details>
                <summary>查看原始事件</summary>
                <pre>{JSON.stringify(event.detail ?? {}, null, 2)}</pre>
              </details>
            </div>
          </article>
        ))}
      </div>

      <p className="hint">
        完整日志和 patch 通过 artifact 保存；验证页可直接打开测试日志。事件文件：
        <code>.forgepilot/tasks/{detail.task.id}/events.jsonl</code>
      </p>
    </div>
  );
}
