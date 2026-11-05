import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { ReviewModal } from "../components/ReviewModal";
import { FlowTimeline } from "../components/FlowTimeline";
import { Badge } from "../components/Badge";
import { RichText } from "../components/RichText";
import { shortHash, time } from "../format";
import { useTaskDetail } from "../useTaskDetail";

export function TaskDetailPage() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const { detail, error, loading, refresh } = useTaskDetail(taskId);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (loading && !detail) return <div className="empty-small">加载任务…</div>;
  if (error && !detail) return <div className="empty-small error">{error}</div>;
  if (!detail) return <div className="empty-small">任务不存在。</div>;

  const task = detail.task;
  const running = detail.running;
  const canReview = task.lifecycle === "WAITING_APPROVAL";
  const unresolved = (task.feedback ?? []).filter((item) => !item.resolvedAt);
  const latestTest = [...detail.verifications].reverse().find((item) => item.kind === "test");

  async function approve() {
    if (!confirm("确认这个 patch 已通过审核？通过后会推送分支并创建 PR。")) return;
    try {
      setBusy(true);
      await api.approve(task.id);
      await refresh();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!confirm("确认取消这个任务？已创建的分支/PR 会保留。")) return;
    try {
      setBusy(true);
      await api.cancel(task.id);
      await refresh();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="console-page">
      <header className="detail-head">
        <div className="title-area">
          <div className="eyebrow">
            {task.issueUrl ? (
              <a href={task.issueUrl} target="_blank" rel="noreferrer">{task.issueUrl}</a>
            ) : (
              <span>本地工单 · {task.ticketId}</span>
            )}
          </div>
          <h2>{task.title}</h2>
          <div className="meta">
            <Badge value={`${task.stage}`} />
            <Badge value={task.lifecycle} />
            {task.service ? <span>service {task.service}</span> : null}
            <span>base {shortHash(task.baseCommit)}</span>
            <span>patch {shortHash(task.changePackage?.patchHash ?? task.patchHash)}</span>
            {task.pr ? <a href={task.pr.url} target="_blank" rel="noreferrer">{task.pr.id}</a> : null}
          </div>
        </div>
      </header>

      <div className="action-bar">
        <div className="actions">
          <button className="ghost" onClick={() => setReviewOpen(true)}>评审对话</button>
          <button className="primary" disabled={!canReview || running || busy} onClick={() => void approve()}>通过并创建 PR</button>
          <button className="warn" disabled={!canReview || running || busy} onClick={() => setReviewOpen(true)}>要求修改</button>
          <button className="ghost" disabled={["DELIVERED", "CANCELLED", "FAILED"].includes(task.lifecycle) || busy} onClick={() => void cancel()}>取消任务</button>
        </div>
      </div>

      <div className="statusbar">
        <div className="status-left">
          <span className="stage-pill">{task.stage}</span>
          <span className={task.lifecycle === "WAITING_APPROVAL" ? "waiting" : ""}>{task.lifecycle}</span>
          {running ? <><span className="spinner" /><span>Agent 正在执行…</span></> : null}
        </div>
        <div className="status-right">
          <span>{task.budget.tokensUsed.toLocaleString()} tokens</span>
          <span>{task.budget.toolCallsUsed} tools</span>
          <span>{task.budget.repairIterations}/{task.budget.maxRepairIterations} repair</span>
        </div>
      </div>

      <FlowTimeline
        key={task.id}
        task={task}
        events={detail.events}
        verifications={detail.verifications}
      />

      <nav className="page-links">
        <Link to={`/tasks/${task.id}`} className="active">概览</Link>
        <Link to={`/tasks/${task.id}/diff`}>Diff / 证据</Link>
        <Link to={`/tasks/${task.id}/timeline`}>Runtime log / 审计时间线</Link>
      </nav>

      <div className="detail-grid">
        <article className="card">
          <div className="card-head"><h3>工单</h3></div>
          <p className="muted">{task.description}</p>
          <div className="kv"><span>预期</span><b>{task.expected}</b></div>
          <div className="kv"><span>Issue</span><b>{task.issueUrl ? <a href={task.issueUrl} target="_blank" rel="noreferrer">{task.issueUrl}</a> : "本地工单"}</b></div>
          <div className="kv"><span>Base</span><b className="mono">{task.baseCommit}</b></div>
          <div className="kv"><span>分支</span><b className="mono">{task.branch}</b></div>
        </article>

        <article className="card">
          <div className="card-head">
            <h3>变更包</h3>
            {task.changePackage ? <Badge value={task.changePackage.approvedAt ? "APPROVED" : "WAITING_APPROVAL"} /> : null}
          </div>
          {task.changePackage ? (
            <>
              <div className="kv"><span>Patch</span><b className="mono">{task.changePackage.patchHash}</b></div>
              <div className="kv"><span>文件</span><b>{task.changePackage.changedFiles.join(", ")}</b></div>
              <div className="kv"><span>理由</span><b><RichText text={task.changePackage.rationale} /></b></div>
              <div className="kv"><span>验证</span><b className="mono">{task.changePackage.verificationId}</b></div>
              <div className="kv"><span>风险</span><b>{task.changePackage.riskNotes.join("；")}</b></div>
            </>
          ) : <p className="muted">当前没有可审批的变更包。</p>}
        </article>

        <article className="card">
          <div className="card-head"><h3>最新验证</h3>{latestTest ? <Badge value={latestTest.exitCode === 0 ? "PASS" : "FAIL"} /> : null}</div>
          {latestTest ? (
            <>
              <div className="kv"><span>命令</span><b className="mono">{latestTest.command}</b></div>
              <div className="kv"><span>结果</span><b>exit {latestTest.exitCode} · {latestTest.durationMs}ms</b></div>
              <div className="kv"><span>Patch</span><b className="mono">{shortHash(latestTest.patchHash)}</b></div>
              <pre className="evidence-pre">{latestTest.keyOutput || "(no key output)"}</pre>
            </>
          ) : <p className="muted">暂无测试验证。</p>}
          <Link to={`/tasks/${task.id}/diff`} className="link">查看全部 diff 与证据 →</Link>
        </article>

        <article className="card">
          <div className="card-head"><h3>交付</h3></div>
          {task.pr ? (
            <>
              <div className="kv"><span>PR</span><b><a href={task.pr.url} target="_blank" rel="noreferrer">{task.pr.id}</a></b></div>
              <div className="kv"><span>分支</span><b className="mono">{task.pr.branch}</b></div>
              <div className="kv"><span>Head</span><b className="mono">{task.pr.headCommit}</b></div>
              <div className="kv"><span>状态</span><b>{task.pr.status}（人工评审/合并仍需完成）</b></div>
            </>
          ) : <p className="muted">通过审核后会推送分支并创建 PR。</p>}
          <Link to={`/tasks/${task.id}/timeline`} className="link">查看审计时间线 →</Link>
        </article>

        {unresolved.length > 0 ? (
          <article className="card">
            <div className="card-head"><h3>待处理的审核意见</h3><Badge value="ACTION REQUIRED" tone="warn" /></div>
            {unresolved.map((item) => (
              <div className="feedback-row" key={item.id}>
                <b>{time(item.requestedAt)}</b>
                <RichText text={item.message} />
              </div>
            ))}
          </article>
        ) : null}

        {task.summary ? <article className="card"><div className="card-head"><h3>交付摘要</h3></div><RichText text={task.summary} /></article> : null}
        {task.lastError ? <article className="card"><div className="card-head"><h3>最近错误</h3></div><pre className="error-box">{task.lastError}</pre></article> : null}
      </div>

      <ReviewModal
        open={reviewOpen}
        detail={detail}
        onClose={() => setReviewOpen(false)}
        onChanged={() => void refresh()}
        onOpenDiff={() => navigate(`/tasks/${task.id}/diff`)}
      />
    </div>
  );
}
