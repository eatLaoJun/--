import { useEffect, useRef, useState } from "react";
import { time } from "../format";
import type { StageGroup, TrajectoryRecord } from "../trajectory/projection";

function tokens(record: TrajectoryRecord): string {
  const usage = record.usage;
  if (!usage) return "";
  const total = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0);
  return total ? `${total.toLocaleString()} tokens` : "";
}

function RecordRow({
  record,
  selectedId,
  collapsedAssistants,
  onToggleAssistant,
  onSelect,
}: {
  record: TrajectoryRecord;
  selectedId?: string;
  collapsedAssistants: Set<string>;
  onToggleAssistant: (id: string) => void;
  onSelect: (record: TrajectoryRecord) => void;
}) {
  if (record.kind === "assistant") {
    const collapsed = collapsedAssistants.has(record.id);
    const selected = record.id === selectedId;
    return (
      <div className={`trajectory-assistant ${selected ? "selected" : ""}`} data-record-id={record.id}>
        <div className="trajectory-row assistant" onClick={() => onSelect(record)}>
          <button
            className="row-chevron"
            aria-label={collapsed ? "展开" : "收起"}
            onClick={(event) => {
              event.stopPropagation();
              onToggleAssistant(record.id);
            }}
          >
            {collapsed ? "▸" : "▾"}
          </button>
          <span className="record-icon ai">AI</span>
          <div className="record-main">
            <div className="record-title">
              <b>Assistant turn</b>
              <span className="record-time">{time(record.at)}</span>
            </div>
            <div className="record-summary">{record.summary ?? "(no text)"}</div>
          </div>
          <div className="record-metrics">
            {tokens(record) ? <span>{tokens(record)}</span> : null}
            {record.durationMs !== undefined ? <span>{(record.durationMs / 1000).toFixed(1)}s</span> : null}
            <span className={`status-dot ${record.status}`} />
          </div>
        </div>
        {!collapsed ? (
          <div className="trajectory-children">
            {(record.children ?? []).length === 0 ? (
              <div className="trajectory-empty-child">该轮没有工具调用。</div>
            ) : (
              (record.children ?? []).map((child) => (
                <RecordRow
                  key={child.id}
                  record={child}
                  selectedId={selectedId}
                  collapsedAssistants={collapsedAssistants}
                  onToggleAssistant={onToggleAssistant}
                  onSelect={onSelect}
                />
              ))
            )}
          </div>
        ) : null}
      </div>
    );
  }

  const kindLabel: Record<string, string> = {
    tool: "TOOL",
    event: "EVENT",
    verification: "VERIFY",
    context: "CONTEXT",
    approval: "APPROVAL",
    delivery: "DELIVERY",
  };
  return (
    <div
      className={`trajectory-row ${record.kind} ${record.id === selectedId ? "selected" : ""}`}
      data-record-id={record.id}
      onClick={() => onSelect(record)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect(record);
      }}
    >
      <span className="row-chevron-spacer" />
      <span className={`record-icon ${record.kind}`}>{kindLabel[record.kind] ?? "EVENT"}</span>
      <div className="record-main">
        <div className="record-title">
          <b>{record.title}</b>
          {record.toolName && record.kind === "tool" ? <span className="record-tool">{record.toolName}</span> : null}
          <span className="record-time">{time(record.at)}</span>
        </div>
        <div className="record-summary">{record.summary ?? "—"}</div>
      </div>
      <div className="record-metrics">
        {record.durationMs !== undefined ? <span>{record.durationMs}ms</span> : null}
        <span className={`status-dot ${record.status}`} />
      </div>
    </div>
  );
}

export function TrajectoryLedger({
  stages,
  selectedId,
  focusRecordId,
  focusStage,
  collapsedStages,
  collapsedAssistants,
  onToggleStage,
  onToggleAssistant,
  onSelect,
}: {
  stages: StageGroup[];
  selectedId?: string;
  focusRecordId?: string;
  focusStage?: string;
  collapsedStages: Set<string>;
  collapsedAssistants: Set<string>;
  onToggleStage: (stage: string) => void;
  onToggleAssistant: (id: string) => void;
  onSelect: (record: TrajectoryRecord) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (!follow) return;
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [stages, follow]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || !focusRecordId) return;
    const target = box.querySelector(`[data-record-id="${CSS.escape(focusRecordId)}"]`);
    target?.scrollIntoView({ block: "center" });
  }, [focusRecordId, stages]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || !focusStage) return;
    const target = box.querySelector(`[data-stage="${CSS.escape(focusStage)}"]`);
    target?.scrollIntoView({ block: "start" });
  }, [focusStage, stages]);

  function onScroll() {
    const box = boxRef.current;
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    setFollow(atBottom);
  }

  return (
    <div className="trajectory-ledger-wrap">
      <div className="trajectory-ledger" ref={boxRef} onScroll={onScroll}>
        {stages.length === 0 ? <div className="empty-small">没有匹配的轨迹记录。</div> : null}
        {stages.map((stage) => {
          const collapsed = collapsedStages.has(stage.stage);
          return (
            <section className={`trajectory-stage ${stage.status}`} key={stage.stage} data-stage={stage.stage}>
              <button className="trajectory-stage-head" onClick={() => onToggleStage(stage.stage)}>
                <span className="row-chevron">{collapsed ? "▸" : "▾"}</span>
                <span className="stage-label">{stage.label}</span>
                <span className="event-raw-type">{stage.stage}</span>
                <span className={`stage-status ${stage.status}`}>{stage.status === "done" ? "DONE" : stage.status === "current" ? "CURRENT" : "PENDING"}</span>
                <span className="stage-time">{stage.startAt ? time(stage.startAt) : ""}</span>
                <span className="stage-count">{stage.records.length} records</span>
              </button>
              {!collapsed ? (
                <div className="trajectory-stage-body">
                  <p className="muted trajectory-stage-desc">{stage.description}</p>
                  {stage.records.map((record) => (
                    <RecordRow
                      key={record.id}
                      record={record}
                      selectedId={selectedId}
                      collapsedAssistants={collapsedAssistants}
                      onToggleAssistant={onToggleAssistant}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      {!follow ? (
        <button
          className="scroll-bottom trajectory-follow"
          onClick={() => {
            setFollow(true);
            const box = boxRef.current;
            if (box) box.scrollTop = box.scrollHeight;
          }}
        >
          ↓ 跟随最新
        </button>
      ) : null}
    </div>
  );
}
