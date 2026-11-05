import { useMemo, useState } from "react";
import type { EventItem, Task, VerificationRecord } from "../types";
import { flattenTrajectoryRecords, projectTrajectory, type StageGroup, type TrajectoryRecord } from "../trajectory/projection";
import { TrajectoryOverview, type OverviewMode } from "./TrajectoryOverview";
import { TrajectoryLedger } from "./TrajectoryLedger";
import { TrajectoryInspector } from "./TrajectoryInspector";

const FILTERS = [
  { value: "all", label: "全部" },
  { value: "flow", label: "流程" },
  { value: "assistant", label: "AI turn" },
  { value: "tool", label: "工具" },
  { value: "verification", label: "验证" },
  { value: "context", label: "上下文" },
  { value: "error", label: "错误" },
];

function recordText(record: TrajectoryRecord): string {
  return [
    record.title,
    record.summary,
    record.toolName,
    record.eventType,
    record.kind,
    record.stage,
    record.output,
    record.input === undefined ? "" : JSON.stringify(record.input),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filterRecord(
  record: TrajectoryRecord,
  query: string,
  filter: string,
): TrajectoryRecord | undefined {
  const children = (record.children ?? [])
    .map((child) => filterRecord(child, query, filter))
    .filter((child): child is TrajectoryRecord => Boolean(child));
  const matchesQuery = !query || recordText(record).includes(query);
  const matchesFilter =
    filter === "all" ||
    (filter === "flow" && ["assistant", "event", "approval", "delivery"].includes(record.kind)) ||
    (filter === "assistant" && record.kind === "assistant") ||
    (filter === "tool" && record.kind === "tool") ||
    (filter === "verification" && record.kind === "verification") ||
    (filter === "context" && record.kind === "context") ||
    (filter === "error" && (record.status === "error" || children.some((child) => child.status === "error")));

  if (record.kind === "assistant") {
    if (children.length > 0 || (matchesQuery && matchesFilter)) {
      return { ...record, children };
    }
    return undefined;
  }
  if (matchesQuery && matchesFilter) {
    return { ...record, children: children.length ? children : record.children };
  }
  return undefined;
}

function filterStages(stages: StageGroup[], query: string, filter: string): StageGroup[] {
  return stages
    .map((stage) => ({
      ...stage,
      records: stage.records
        .map((record) => filterRecord(record, query, filter))
        .filter((record): record is TrajectoryRecord => Boolean(record)),
    }))
    .filter((stage) => stage.records.length > 0);
}

export function TrajectoryView({
  task,
  events,
  verifications,
}: {
  task: Task;
  events: EventItem[];
  verifications: VerificationRecord[];
}) {
  const projection = useMemo(
    () => projectTrajectory({ task, events, verifications }),
    [task, events, verifications],
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [overviewMode, setOverviewMode] = useState<OverviewMode>("balanced");
  const [selectedId, setSelectedId] = useState<string>();
  const [focusedRecordId, setFocusedRecordId] = useState<string>();
  const [focusedStage, setFocusedStage] = useState<string>();
  const [collapsedStages, setCollapsedStages] = useState<Set<string>>(new Set());
  const [collapsedAssistants, setCollapsedAssistants] = useState<Set<string>>(new Set());

  const normalizedQuery = query.trim().toLowerCase();
  const stages = useMemo(
    () => filterStages(projection.stages, normalizedQuery, filter),
    [projection.stages, normalizedQuery, filter],
  );
  const filteredRecords = useMemo(() => stages.flatMap((stage) => stage.records), [stages]);
  const allRecords = useMemo(() => flattenTrajectoryRecords(projection.records), [projection.records]);
  const selected = allRecords.find((record) => record.id === selectedId);

  function toggleStage(stage: string) {
    setCollapsedStages((previous) => {
      const next = new Set(previous);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  }

  function toggleAssistant(id: string) {
    setCollapsedAssistants((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectRecord(record: TrajectoryRecord, focus = false) {
    setSelectedId(record.id);
    if (focus) {
      setFocusedRecordId(record.id);
      setCollapsedStages((previous) => {
        const next = new Set(previous);
        next.delete(record.stage);
        return next;
      });
      const parent = allRecords.find(
        (item) => item.kind === "assistant" && item.children?.some((child) => child.id === record.id),
      );
      if (parent) {
        setCollapsedAssistants((previous) => {
          const next = new Set(previous);
          next.delete(parent.id);
          return next;
        });
      }
    }
  }

  function focusStage(stage: string) {
    setFocusedStage(stage);
    setCollapsedStages((previous) => {
      const next = new Set(previous);
      next.delete(stage);
      return next;
    });
  }

  return (
    <div className="trajectory-page">
      <div className="trajectory-toolbar">
        <div className="trajectory-toolbar-left">
          <input
            type="search"
            className="trajectory-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索工具、事件、阶段…"
          />
          <div className="trajectory-filters">
            {FILTERS.map((item) => (
              <button
                key={item.value}
                className={`chip ${filter === item.value ? "active" : ""}`}
                onClick={() => setFilter(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="trajectory-toolbar-right">
          <button className="link" onClick={() => setCollapsedStages(new Set(stages.map((stage) => stage.stage)))}>收起阶段</button>
          <button className="link" onClick={() => setCollapsedStages(new Set())}>展开阶段</button>
          <button className="link" onClick={() => setCollapsedAssistants(new Set(allRecords.filter((record) => record.kind === "assistant").map((record) => record.id)))}>收起调用</button>
          <button className="link" onClick={() => setCollapsedAssistants(new Set())}>展开调用</button>
        </div>
      </div>

      <TrajectoryOverview
        projection={{ ...projection, stages, records: filteredRecords }}
        mode={overviewMode}
        onModeChange={setOverviewMode}
        selectedId={selectedId}
        onSelectRecord={(record) => selectRecord(record, true)}
        onSelectStage={focusStage}
      />

      <div className="trajectory-layout">
        <TrajectoryLedger
          stages={stages}
          selectedId={selectedId}
          focusRecordId={focusedRecordId}
          focusStage={focusedStage}
          collapsedStages={collapsedStages}
          collapsedAssistants={collapsedAssistants}
          onToggleStage={toggleStage}
          onToggleAssistant={toggleAssistant}
          onSelect={(record) => selectRecord(record)}
        />
        <TrajectoryInspector record={selected} onClose={() => setSelectedId(undefined)} />
      </div>
    </div>
  );
}
