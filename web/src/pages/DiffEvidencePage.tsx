import { Link, useParams } from "react-router-dom";
import { Badge } from "../components/Badge";
import { shortHash, time } from "../format";
import { useTaskDetail } from "../useTaskDetail";

function DiffViewer({ diff }: { diff: string }) {
  if (!diff) return <div className="empty-small">当前没有 diff。</div>;
  return (
    <pre className="diff">
      {diff.split(/\r?\n/).map((line, index) => {
        const cls =
          line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")
            ? "meta"
            : line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+")
                ? "add"
                : line.startsWith("-")
                  ? "del"
                  : "";
        return <span className={`diff-line ${cls}`} key={index}>{line || " "}</span>;
      })}
    </pre>
  );
}

export function DiffEvidencePage() {
  const { taskId } = useParams();
  const { detail, error, loading } = useTaskDetail(taskId);
  if (loading && !detail) return <div className="empty-small">加载变更…</div>;
  if (error && !detail) return <div className="empty-small error">{error}</div>;
  if (!detail) return <div className="empty-small">任务不存在。</div>;

  const task = detail.task;
  const pkg = task.changePackage;
  const latestTest = [...detail.verifications].reverse().find((item) => item.kind === "test");

  return (
    <div className="console-page">
      <header className="page-head">
        <div>
          <p className="eyebrow">CHANGE EVIDENCE</p>
          <h2>Diff / 变更证据</h2>
          <p className="muted">{task.ticketId} · {task.title}</p>
        </div>
        <div className="head-actions">
          <Link className="ghost" to={`/tasks/${task.id}`}>返回概览</Link>
          <Link className="ghost" to={`/tasks/${task.id}/timeline`}>审计时间线</Link>
        </div>
      </header>

      <nav className="page-links">
        <Link to={`/tasks/${task.id}`}>概览</Link>
        <Link to={`/tasks/${task.id}/diff`} className="active">Diff / 证据</Link>
        <Link to={`/tasks/${task.id}/timeline`}>Runtime log / 审计时间线</Link>
      </nav>

      <div className="stat-grid">
        <div className="stat-card"><span>Patch</span><b className="mono small">{shortHash(pkg?.patchHash ?? task.patchHash)}</b></div>
        <div className="stat-card"><span>变更文件</span><b>{pkg?.changedFiles.length ?? 0}</b></div>
        <div className="stat-card"><span>测试</span><b className={latestTest?.exitCode === 0 ? "ok" : "danger"}>{latestTest ? `exit ${latestTest.exitCode}` : "—"}</b></div>
        <div className="stat-card"><span>审批</span><b className="warn">{pkg?.approvedAt ? "已审批" : "待审批"}</b></div>
      </div>

      <div className="evidence-layout">
        <section className="card diff-card">
          <div className="card-head">
            <h3>Proposed diff</h3>
            {pkg ? <span className="mono">{pkg.diffStat}</span> : null}
          </div>
          {pkg ? (
            <div className="kv"><span>理由</span><b>{pkg.rationale}</b></div>
          ) : null}
          <DiffViewer diff={detail.diff} />
        </section>

        <aside className="evidence-side">
          <article className="card">
            <div className="card-head"><h3>验证记录</h3><Badge value={`${detail.verifications.length}`} /></div>
            {detail.verifications.length === 0 ? <p className="muted">暂无验证记录。</p> : null}
            {[...detail.verifications].reverse().map((item) => (
              <div className={`verify-row ${item.exitCode === 0 ? "ok" : "fail"}`} key={item.id}>
                <div className="verify-head">
                  <b>{item.kind}</b>
                  <Badge value={item.envError ? "ENV_ERROR" : item.exitCode === 0 ? "PASS" : "FAIL"} />
                </div>
                <div className="mono small">{item.command}</div>
                <div className="verify-meta">exit {item.exitCode} · {item.durationMs}ms · patch {shortHash(item.patchHash)}</div>
                <pre>{item.keyOutput || "(no key output)"}</pre>
                <a href={`/api/artifacts/${item.artifactId}`} target="_blank" rel="noreferrer" className="link">打开完整日志 artifact →</a>
              </div>
            ))}
          </article>

          <article className="card">
            <div className="card-head"><h3>交付信息</h3></div>
            <div className="kv"><span>Base</span><b className="mono">{task.baseCommit}</b></div>
            <div className="kv"><span>分支</span><b className="mono">{task.branch}</b></div>
            <div className="kv"><span>PR</span><b>{task.pr ? <a href={task.pr.url} target="_blank" rel="noreferrer">{task.pr.id}</a> : "未创建"}</b></div>
            <div className="kv"><span>更新时间</span><b>{time(task.changePackage?.createdAt)}</b></div>
          </article>
        </aside>
      </div>
    </div>
  );
}
