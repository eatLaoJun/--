import { Link } from "react-router-dom";
import type { EventItem, Task, VerificationRecord } from "../types";
import { Badge } from "./Badge";
import { shortHash, time } from "../format";

const NEW_STAGES = ["INGEST", "RESOLVE", "PLAN", "REPAIR", "VERIFY", "PACKAGE", "PUBLISH", "DONE"];
const LEGACY_STAGES = ["PREPARE", "REPRODUCE", "REPAIR", "VERIFY", "PACKAGE", "PUBLISH", "DONE"];

const LABELS: Record<string, string> = {
  INGEST: "事件接入",
  RESOLVE: "仓库定位",
  PLAN: "方案",
  PREPARE: "准备",
  REPRODUCE: "复现",
  REPAIR: "修改",
  VERIFY: "验证",
  PACKAGE: "变更包",
  PUBLISH: "提交 PR",
  DONE: "交付",
};

const DESCRIPTIONS: Record<string, string> = {
  INGEST: "从事件中心读取 Bug，校验来源、去重和权限。",
  RESOLVE: "把 service 映射到授权仓库、base branch、环境和可信命令。",
  PLAN: "读代码并产出结构化方案：根因、改法、替代方案、测试计划、风险。",
  PREPARE: "准备固定 base_commit 的隔离工作区。",
  REPRODUCE: "在未修复版本上复现缺陷，记录证据。",
  REPAIR: "按方案做最小 patch，不修改测试和验证配置。",
  VERIFY: "运行复现/测试/构建，证据绑定 patch 指纹。",
  PACKAGE: "生成可审核变更包，等待人工审批。",
  PUBLISH: "推送分支、创建 PR/MR、回填事件中心。",
  DONE: "记录交付结果，等待评审/合并。",
};

function stageTimes(task: Task, events: EventItem[]): Map<string, number> {
  const times = new Map<string, number>();
  if (task.source === "event-center") times.set("INGEST", task.createdAt);
  else times.set("PREPARE", task.createdAt);
  for (const event of events) {
    if (event.type === "stage_advanced" && typeof event.detail?.to === "string") {
      times.set(event.detail.to, event.at);
    }
    if (event.type === "plan_recorded") times.set("PLAN", event.at);
    if (event.type === "package_created") times.set("PACKAGE", event.at);
    if (event.type === "pr_created") times.set("PUBLISH", event.at);
    if (event.type === "delivered") times.set("DONE", event.at);
  }
  return times;
}

export function FlowTimeline({
  task,
  events,
  verifications,
  onAsk,
}: {
  task: Task;
  events: EventItem[];
  verifications: VerificationRecord[];
  onAsk: (stage: string) => void;
}) {
  const stages = task.source === "event-center" || task.incidentId ? NEW_STAGES : LEGACY_STAGES;
  const currentIndex = stages.indexOf(task.stage);
  const done = task.lifecycle === "DELIVERED" || task.stage === "DONE";
  const times = stageTimes(task, events);
  const latestTest = [...verifications].reverse().find((item) => item.kind === "test");
  const latestBuild = [...verifications].reverse().find((item) => item.kind === "build");

  return (
    <div className="flow-timeline">
      <div className="flow-head">
        <div>
          <p className="eyebrow">END-TO-END FLOW</p>
          <h3>整体时间线</h3>
        </div>
        <span className="hint">{task.source === "event-center" ? "事件中心 → 仓库 → 方案 → 改码 → 验证 → PR" : "工单 → 准备 → 复现 → 改码 → 验证 → PR"}</span>
      </div>
      {stages.map((stage, index) => {
        const status = done || (currentIndex >= 0 && index < currentIndex) ? "done" : index === currentIndex ? "current" : "pending";
        return (
          <section className={`flow-stage ${status}`} key={stage}>
            <div className="flow-rail">
              <span className="flow-dot">{status === "done" ? "✓" : index + 1}</span>
            </div>
            <div className="flow-card">
              <div className="flow-card-head">
                <div>
                  <div className="flow-title">
                    <b>{LABELS[stage] ?? stage}</b>
                    <span className="event-raw-type">{stage}</span>
                    <Badge value={status === "done" ? "DONE" : status === "current" ? task.lifecycle : "PENDING"} tone={status === "done" ? "success" : status === "current" ? "warn" : "muted"} />
                  </div>
                  <p className="muted flow-desc">{DESCRIPTIONS[stage] ?? ""}</p>
                </div>
                <div className="flow-actions">
                  {times.get(stage) ? <span className="flow-time">{time(times.get(stage))}</span> : null}
                  <button className="link" onClick={() => onAsk(stage)}>问 AI</button>
                  {["REPAIR", "VERIFY", "PACKAGE"].includes(stage) ? (
                    <Link className="link" to={`/tasks/${task.id}/diff`}>看变更</Link>
                  ) : null}
                  {stage === "DONE" && task.pr ? (
                    <a className="link" href={task.pr.url} target="_blank" rel="noreferrer">看 PR</a>
                  ) : null}
                </div>
              </div>

              {stage === "INGEST" ? (
                <div className="flow-detail">
                  <span>{task.service ?? task.projectId}</span>
                  {task.incidentId ? <span className="mono">{task.incidentId}</span> : null}
                  {task.issueUrl ? <a href={task.issueUrl} target="_blank" rel="noreferrer">事件链接</a> : null}
                </div>
              ) : null}

              {stage === "RESOLVE" && task.repoName && task.baseCommit ? (
                <div className="flow-detail">
                  <span>{task.repoName}</span>
                  <span className="mono">base {shortHash(task.baseCommit)}</span>
                  <span className="mono">{task.branch}</span>
                </div>
              ) : null}

              {stage === "PLAN" && task.plan ? (
                <div className="plan-box">
                  <div><span>方案</span><b>{task.plan.approach}</b></div>
                  <div><span>根因假设</span><b>{task.plan.rootCauseHypotheses.join("；")}</b></div>
                  <div><span>涉及文件</span><b className="mono">{task.plan.filesToChange.join(", ")}</b></div>
                  <div><span>测试计划</span><b>{task.plan.testPlan.join("；")}</b></div>
                  <div><span>风险</span><b>{task.plan.risks.join("；")}</b></div>
                </div>
              ) : null}

              {stage === "REPAIR" && task.changePackage ? (
                <div className="flow-detail">
                  <span className="mono">patch {shortHash(task.changePackage.patchHash)}</span>
                  <span>{task.changePackage.changedFiles.join(", ")}</span>
                </div>
              ) : null}

              {stage === "VERIFY" && latestTest ? (
                <div className="flow-detail">
                  <span className="mono">{latestTest.command}</span>
                  <span className={latestTest.exitCode === 0 ? "ok" : "danger"}>exit {latestTest.exitCode}</span>
                  {latestBuild ? <span className={latestBuild.exitCode === 0 ? "ok" : "danger"}>build exit {latestBuild.exitCode}</span> : null}
                </div>
              ) : null}

              {stage === "PACKAGE" && task.changePackage ? (
                <div className="flow-detail">
                  <span className="mono">{task.changePackage.verificationId}</span>
                  <span>{task.changePackage.changedFiles.length} file(s)</span>
                  <Badge value={task.changePackage.approvedAt ? "APPROVED" : "WAITING_APPROVAL"} />
                </div>
              ) : null}

              {stage === "PUBLISH" && task.pr ? (
                <div className="flow-detail">
                  <a href={task.pr.url} target="_blank" rel="noreferrer">{task.pr.id}</a>
                  <span className="mono">{task.pr.branch}</span>
                  <Badge value={task.pr.status} />
                </div>
              ) : null}

              {stage === "DONE" && task.summary ? <div className="flow-detail">{task.summary}</div> : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}
