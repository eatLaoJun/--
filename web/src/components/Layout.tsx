import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useTasks } from "../TasksContext";
import { time } from "../format";
import { Badge } from "./Badge";

function TaskList() {
  const { tasks } = useTasks();
  return (
    <div className="task-list">
      {tasks.length === 0 ? (
        <div className="task-empty">还没有任务。从上面的 Issue 开始。</div>
      ) : (
        tasks.map((task) => (
          <NavLink
            key={task.id}
            to={`/tasks/${task.id}`}
            className={({ isActive }) => `task-item ${isActive ? "selected" : ""}`}
          >
            <div className="task-item-top">
              <span className="ticket">{task.ticketId}</span>
              <Badge value={task.lifecycle} />
            </div>
            <div className="task-item-title">{task.title}</div>
            <div className="task-item-bottom">
              <span>{task.stage}</span>
              <span>{task.running ? <><i className="dot live" /> 执行中</> : time(task.updatedAt)}</span>
            </div>
          </NavLink>
        ))
      )}
    </div>
  );
}

export function Layout() {
  const { issues, incidents, createTask, error } = useTasks();
  const [source, setSource] = useState("");
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  async function onCreate() {
    if (!source) return;
    try {
      setCreating(true);
      const taskId = source.startsWith("incident:")
        ? await createTask({ incident: source.slice("incident:".length) })
        : await createTask({ issue: source.slice("issue:".length) });
      navigate(`/tasks/${taskId}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">FP</div>
          <div>
            <h1>ForgePilot</h1>
            <p>Bug 修复 · 审计工作台</p>
          </div>
        </div>

        <div className="create-box">
          <label htmlFor="issue-select">从事件中心 / GitHub Issue 创建修复任务</label>
          <select id="issue-select" value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="">选择来源…</option>
            <optgroup label="事件中心 Bug">
              {incidents.map((item) => (
                <option key={item.id} value={`incident:${item.id}`}>
                  [{item.severity ?? "P"}] {item.title} · {item.service}
                </option>
              ))}
            </optgroup>
            <optgroup label="GitHub Issue">
              {issues.map((item) => (
                <option key={item.file} value={`issue:${item.file}`}>
                  #{item.number ?? ""} {item.title}
                </option>
              ))}
            </optgroup>
          </select>
          <button className="primary" disabled={!source || creating} onClick={onCreate}>
            {creating ? "创建中…" : "开始修复"}
          </button>
          <p className="hint">本地演示使用 fixtures/github；配置 GITHUB_TOKEN 后可填真实 URL。</p>
        </div>

        <div className="list-head">
          <span>任务</span>
          <NavLink to="/" className="link">任务台</NavLink>
        </div>
        {error ? <div className="task-empty error">{error}</div> : null}
        <TaskList />
      </aside>

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
