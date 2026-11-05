import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTasks } from "../TasksContext";
import { Badge } from "../components/Badge";
import { shortHash, time } from "../format";

const STAGES = ["PREPARE", "REPRODUCE", "REPAIR", "VERIFY", "PACKAGE", "PUBLISH", "DONE"];
const LIFECYCLES = [
  "QUEUED",
  "RUNNING",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
  "PAUSED",
  "CANCELLING",
  "CANCELLED",
  "FAILED",
  "DELIVERED",
];

export function TaskConsolePage() {
  const { tasks, loading, refresh } = useTasks();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("");
  const [lifecycle, setLifecycle] = useState("");
  const [failedOnly, setFailedOnly] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (stage && task.stage !== stage) return false;
      if (lifecycle && task.lifecycle !== lifecycle) return false;
      if (failedOnly && !["FAILED", "PAUSED"].includes(task.lifecycle)) return false;
      if (q && ![task.id, task.ticketId, task.title, task.issueUrl ?? ""].join(" ").toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [tasks, query, stage, lifecycle, failedOnly]);

  const stats = useMemo(
    () => ({
      total: tasks.length,
      running: tasks.filter((task) => task.running || task.lifecycle === "RUNNING").length,
      approval: tasks.filter((task) => task.lifecycle === "WAITING_APPROVAL").length,
      failed: tasks.filter((task) => ["FAILED", "PAUSED"].includes(task.lifecycle)).length,
    }),
    [tasks],
  );

  return (
    <div className="console-page">
      <header className="page-head">
        <div>
          <p className="eyebrow">TASK CONSOLE</p>
          <h2>任务台</h2>
          <p className="muted">按阶段、生命周期和失败状态查看修复任务；点击任务进入详情、审计时间线和变更证据。</p>
        </div>
        <button className="ghost" onClick={() => void refresh()}>刷新</button>
      </header>

      <div className="stat-grid">
        <div className="stat-card"><span>总任务</span><b>{stats.total}</b></div>
        <div className="stat-card"><span>执行中</span><b className="ok">{stats.running}</b></div>
        <div className="stat-card"><span>待审批</span><b className="warn">{stats.approval}</b></div>
        <div className="stat-card"><span>失败 / 暂停</span><b className="danger">{stats.failed}</b></div>
      </div>

      <div className="filters">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索任务、ticket、issue…"
        />
        <select value={stage} onChange={(event) => setStage(event.target.value)}>
          <option value="">全部阶段</option>
          {STAGES.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <select value={lifecycle} onChange={(event) => setLifecycle(event.target.value)}>
          <option value="">全部状态</option>
          {LIFECYCLES.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <label className="check">
          <input type="checkbox" checked={failedOnly} onChange={(event) => setFailedOnly(event.target.checked)} />
          只看失败/暂停
        </label>
        {(query || stage || lifecycle || failedOnly) ? (
          <button className="link" onClick={() => { setQuery(""); setStage(""); setLifecycle(""); setFailedOnly(false); }}>
            清空筛选
          </button>
        ) : null}
      </div>

      <div className="table-wrap">
        <table className="task-table">
          <thead>
            <tr>
              <th>任务</th>
              <th>来源</th>
              <th>阶段</th>
              <th>生命周期</th>
              <th>Patch</th>
              <th>文件</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((task) => (
              <tr key={task.id} onClick={() => navigate(`/tasks/${task.id}`)}>
                <td>
                  <div className="table-title">
                    {task.running ? <i className="dot live" /> : null}
                    {task.title}
                  </div>
                  <div className="table-sub">
                    <span className="ticket">{task.ticketId}</span>
                    {task.issueUrl ? <a href={task.issueUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>issue</a> : null}
                  </div>
                </td>
                <td>
                  <div>{task.source === "event-center" ? "事件中心" : task.source === "github" ? "GitHub" : "工单"}</div>
                  <div className="mono small">{task.service ?? "—"}</div>
                  {task.incidentId ? <div className="event-raw-type">{task.incidentId}</div> : null}
                </td>
                <td><span className="stage-pill">{task.stage}</span></td>
                <td><Badge value={task.lifecycle} /></td>
                <td className="mono">{shortHash(task.patchHash)}</td>
                <td>{task.changedFiles.length || "—"}</td>
                <td className="muted">{time(task.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && filtered.length === 0 ? (
          <div className="empty-small">没有匹配的任务。调整筛选条件，或从左侧 Issue 创建一个。</div>
        ) : null}
        {loading ? <div className="empty-small">加载中…</div> : null}
      </div>

      <p className="hint">
        需要完整执行链路？<Link to="/">任务台</Link> · 进入任务后可查看 <b>Diff / 证据</b> 与 <b>Runtime log</b>。
      </p>
    </div>
  );
}
