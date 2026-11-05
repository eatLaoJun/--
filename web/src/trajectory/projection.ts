import type { EventItem, Task, VerificationRecord } from "../types";
import { summarizeEvent } from "../event-summary";

export const NEW_STAGES = ["INGEST", "RESOLVE", "PLAN", "REPAIR", "VERIFY", "PACKAGE", "PUBLISH", "DONE"];
export const LEGACY_STAGES = ["PREPARE", "REPRODUCE", "REPAIR", "VERIFY", "PACKAGE", "PUBLISH", "DONE"];

export const STAGE_LABELS: Record<string, string> = {
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

export const STAGE_DESCRIPTIONS: Record<string, string> = {
  INGEST: "读取事件、校验来源和去重",
  RESOLVE: "service → 仓库、base、可信命令",
  PLAN: "根因、方案、测试计划、风险",
  PREPARE: "准备固定 base_commit 的工作区",
  REPRODUCE: "未修复版本复现缺陷",
  REPAIR: "按方案做最小 patch",
  VERIFY: "测试/构建证据绑定补丁指纹",
  PACKAGE: "生成可审核变更包",
  PUBLISH: "推送分支并创建 PR",
  DONE: "交付记录",
};

export type TrajectoryKind = "assistant" | "tool" | "event" | "verification" | "context" | "approval" | "delivery";
export type TrajectoryStatus = "ok" | "error" | "pending" | "info";

export interface TrajectoryUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  totalTokens?: number;
}

export interface TrajectoryRecord {
  id: string;
  kind: TrajectoryKind;
  stage: string;
  at: number;
  endAt?: number;
  durationMs?: number;
  title: string;
  summary?: string;
  status: TrajectoryStatus;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: string;
  usage?: TrajectoryUsage;
  artifactId?: string;
  fingerprint?: string;
  eventType?: string;
  detail?: Record<string, unknown>;
  children?: TrajectoryRecord[];
}

export interface StageGroup {
  stage: string;
  label: string;
  description: string;
  status: "done" | "current" | "pending";
  startAt?: number;
  endAt?: number;
  records: TrajectoryRecord[];
}

export interface TrajectoryProjection {
  stages: StageGroup[];
  records: TrajectoryRecord[];
  startAt?: number;
  endAt?: number;
  totalRecords: number;
}

const ARTIFACT_RE = /[a-f0-9]{64}/i;

function statusForEvent(type: string, detail: Record<string, unknown>): TrajectoryStatus {
  if (["task_failed", "background_run_failed", "cancelled"].includes(type)) return "error";
  if (type === "verification") return Number(detail.exitCode) === 0 ? "ok" : "error";
  if (["tool_result"].includes(type)) return detail.isError ? "error" : "ok";
  return "info";
}

function eventRecord(event: EventItem, task: Task, verifications: VerificationRecord[], index: number): TrajectoryRecord {
  const detail = event.detail ?? {};
  const base = {
    id: `event-${event.type}-${event.at}-${index}`,
    stage: event.stage ?? "INGEST",
    at: event.at,
    eventType: event.type,
    detail,
    status: statusForEvent(event.type, detail),
  };

  if (event.type === "verification") {
    const artifactId = typeof detail.artifactId === "string" ? detail.artifactId : undefined;
    const verification = verifications.find((item) => item.artifactId === artifactId || item.id === detail.id);
    const exitCode = Number(detail.exitCode ?? verification?.exitCode ?? 0);
    return {
      ...base,
      kind: "verification",
      title: `验证 · ${String(detail.kind ?? verification?.kind ?? "test")}`,
      summary: `${verification?.command ?? ""} · exit ${exitCode}`,
      status: exitCode === 0 ? "ok" : "error",
      artifactId,
      fingerprint: typeof detail.fingerprint === "string" ? detail.fingerprint : verification?.fingerprint,
      output: verification?.keyOutput,
      durationMs: verification?.durationMs,
    };
  }

  if (event.type === "plan_recorded") {
    return {
      ...base,
      kind: "event",
      title: "结构化方案",
      summary: task.plan?.approach ?? "Plan recorded",
      artifactId: typeof detail.artifactId === "string" ? detail.artifactId : task.plan?.artifactId,
      output: task.plan ? JSON.stringify(task.plan, null, 2) : undefined,
    };
  }

  const kind: TrajectoryKind =
    ["approved", "changes_requested", "waiting_approval"].includes(event.type)
      ? "approval"
      : ["branch_published", "pr_created", "delivered"].includes(event.type)
        ? "delivery"
        : event.type === "context_metrics"
          ? "context"
          : "event";

  const titleMap: Record<string, string> = {
    task_created: "任务创建",
    incident_ingested: "事件接入",
    repository_resolved: "仓库定位",
    stage_advanced: "阶段推进",
    package_created: "变更包生成",
    waiting_approval: "等待审批",
    changes_requested: "要求修改",
    approved: "审批通过",
    branch_published: "分支推送",
    pr_created: "PR 创建",
    delivered: "已交付",
    recovery: "恢复",
    task_failed: "任务失败",
    cancelled: "任务取消",
    model_fallback: "模型回退",
    agent_settled: "Agent 结束",
    context_metrics: "上下文组装",
  };

  return {
    ...base,
    kind,
    title: titleMap[event.type] ?? event.type,
    summary: summarizeEvent(event),
    artifactId:
      typeof detail.artifactId === "string"
        ? detail.artifactId
        : typeof detail.patchArtifactId === "string"
          ? detail.patchArtifactId
          : ARTIFACT_RE.test(JSON.stringify(detail))
            ? JSON.stringify(detail).match(ARTIFACT_RE)?.[0]
            : undefined,
  };
}

function toolRecordsForStage(
  events: EventItem[],
  task: Task,
): TrajectoryRecord[] {
  void task;
  const calls = new Map<string, EventItem>();
  const results = new Map<string, EventItem>();
  const orphanCalls: EventItem[] = [];
  for (const event of events) {
    const id = event.detail?.toolCallId;
    if (event.type === "tool_call") {
      if (typeof id === "string") calls.set(id, event);
      else orphanCalls.push(event);
    }
    if (event.type === "tool_result" && typeof id === "string") results.set(id, event);
  }

  const records: TrajectoryRecord[] = [];
  const usedCallIds = new Set<string>();

  const push = (id: string, call: EventItem | undefined, result: EventItem | undefined) => {
    const callDetail = call?.detail ?? {};
    const resultDetail = result?.detail ?? {};
    const toolName = String(callDetail.name ?? resultDetail.toolName ?? "tool");
    const status: TrajectoryStatus = !result ? "pending" : resultDetail.isError ? "error" : "ok";
    const summary =
      typeof resultDetail.summary === "string" && resultDetail.summary.trim()
        ? resultDetail.summary
        : typeof callDetail.input === "object"
          ? JSON.stringify(callDetail.input).slice(0, 240)
          : "";
    records.push({
      id: `tool-${id}`,
      kind: "tool",
      stage: call?.stage ?? result?.stage ?? "REPAIR",
      at: call?.at ?? result?.at ?? Date.now(),
      endAt: result?.at,
      durationMs: typeof resultDetail.durationMs === "number" ? resultDetail.durationMs : undefined,
      title: toolName,
      summary,
      status,
      toolName,
      toolCallId: id,
      input: callDetail.input,
      output: typeof resultDetail.summary === "string" ? resultDetail.summary : undefined,
      artifactId:
        typeof resultDetail.summary === "string" ? resultDetail.summary.match(ARTIFACT_RE)?.[0] : undefined,
      detail: { call: callDetail, result: resultDetail },
    });
  };

  for (const [id, result] of results) {
    let call = calls.get(id);
    if (call) {
      usedCallIds.add(id);
    } else {
      // Older event logs did not persist toolCallId on tool_call. Pair the
      // nearest preceding call with the same tool name so inputs remain visible.
      const name = String(result.detail?.toolName ?? "");
      const index = orphanCalls.findIndex(
        (candidate) =>
          String(candidate.detail?.name ?? "") === name && candidate.at <= result.at,
      );
      if (index >= 0) call = orphanCalls.splice(index, 1)[0];
    }
    push(id, call, result);
  }

  for (const [id, call] of calls) {
    if (!usedCallIds.has(id)) push(id, call, undefined);
  }
  for (const call of orphanCalls) {
    push(`orphan-${call.at}-${String(call.detail?.name ?? "tool")}`, call, undefined);
  }

  return records.sort((a, b) => a.at - b.at);
}

function processStage(
  stage: string,
  events: EventItem[],
  task: Task,
  verifications: VerificationRecord[],
  index: number,
): StageGroup {
  const tools = toolRecordsForStage(events, task);
  const toolByCall = new Map(tools.filter((record) => record.toolCallId).map((record) => [record.toolCallId!, record]));
  const records: TrajectoryRecord[] = [];
  const pending: TrajectoryRecord[] = [];
  let assistantIndex = 0;

  const flushPending = () => {
    records.push(...pending.splice(0));
  };

  for (const event of events) {
    const detail = event.detail ?? {};
    if (event.type === "tool_call" || event.type === "tool_result") {
      const id = detail.toolCallId;
      const record = typeof id === "string" ? toolByCall.get(id) : undefined;
      if (record && !pending.includes(record) && !records.includes(record)) {
        pending.push(record);
      }
      continue;
    }

    if (event.type === "agent_turn") {
      const children = pending.splice(0);
      const firstAt = children.length ? Math.min(...children.map((child) => child.at)) : event.at;
      const usage = (detail.usage ?? {}) as TrajectoryUsage;
      records.push({
        id: `assistant-${stage}-${assistantIndex++}-${event.at}`,
        kind: "assistant",
        stage,
        at: firstAt,
        endAt: event.at,
        durationMs: typeof detail.wallClockMs === "number" ? detail.wallClockMs : event.at - firstAt,
        title: "Assistant turn",
        summary: typeof detail.summary === "string" ? detail.summary : undefined,
        status: detail.aborted ? "error" : "ok",
        usage,
        detail,
        children,
      });
      continue;
    }

    pending.push(eventRecord(event, task, verifications, index));
  }
  // Old logs may have a tool call without a matching result event. Keep those
  // records visible instead of dropping them. Tool records already nested under
  // an assistant turn count as present too.
  const known = new Set<TrajectoryRecord>();
  const remember = (record: TrajectoryRecord) => {
    known.add(record);
    for (const child of record.children ?? []) remember(child);
  };
  records.forEach(remember);
  pending.forEach(remember);
  for (const tool of tools) {
    if (!known.has(tool)) pending.push(tool);
  }
  flushPending();

  records.sort((a, b) => a.at - b.at || a.title.localeCompare(b.title));
  const starts = records.map((record) => record.at);
  const ends = records.map((record) => record.endAt ?? record.at);
  return {
    stage,
    label: STAGE_LABELS[stage] ?? stage,
    description: STAGE_DESCRIPTIONS[stage] ?? "",
    status: "pending",
    startAt: starts.length ? Math.min(...starts) : undefined,
    endAt: ends.length ? Math.max(...ends) : undefined,
    records,
  };
}

export function flattenTrajectoryRecords(records: TrajectoryRecord[]): TrajectoryRecord[] {
  const out: TrajectoryRecord[] = [];
  const visit = (record: TrajectoryRecord) => {
    out.push(record);
    for (const child of record.children ?? []) visit(child);
  };
  for (const record of records) visit(record);
  return out;
}

export function projectTrajectory(input: {
  task: Task;
  events: EventItem[];
  verifications: VerificationRecord[];
}): TrajectoryProjection {
  const { task, events, verifications } = input;
  const order = task.source === "event-center" || task.incidentId ? NEW_STAGES : LEGACY_STAGES;
  const eventStages = [...new Set(events.map((event) => event.stage).filter((stage): stage is string => Boolean(stage)))];
  const stages = [...order, ...eventStages.filter((stage) => !order.includes(stage))];
  const currentIndex = stages.indexOf(task.stage);
  const done = task.lifecycle === "DELIVERED" || task.stage === "DONE";
  const sortedEvents = [...events].sort((a, b) => a.at - b.at);

  const groups = stages.map((stage, index) => {
    const group = processStage(
      stage,
      sortedEvents.filter((event) => (event.stage ?? order[0]) === stage),
      task,
      verifications,
      index,
    );
    group.status = done || (currentIndex >= 0 && index < currentIndex)
      ? "done"
      : index === currentIndex
        ? "current"
        : "pending";
    return group;
  });

  const records = groups.flatMap((group) => group.records);
  const starts = records.map((record) => record.at);
  const ends = records.map((record) => record.endAt ?? record.at);
  return {
    stages: groups,
    records,
    startAt: starts.length ? Math.min(...starts) : task.createdAt,
    endAt: ends.length ? Math.max(...ends) : task.updatedAt,
    totalRecords: records.length,
  };
}
