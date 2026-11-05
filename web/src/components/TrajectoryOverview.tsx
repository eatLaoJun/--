import { time } from "../format";
import {
  flattenTrajectoryRecords,
  type StageGroup,
  type TrajectoryProjection,
  type TrajectoryRecord,
} from "../trajectory/projection";

export type OverviewMode = "balanced" | "actual";

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function stageDuration(stage: StageGroup): number | undefined {
  if (stage.startAt === undefined || stage.endAt === undefined) return undefined;
  return Math.max(0, stage.endAt - stage.startAt);
}

function balancedPosition(record: TrajectoryRecord, index: number, records: TrajectoryRecord[], stage: StageGroup): number {
  if (stage.startAt !== undefined && stage.endAt !== undefined && stage.endAt > stage.startAt) {
    const fraction = (record.at - stage.startAt) / (stage.endAt - stage.startAt);
    return 6 + Math.min(1, Math.max(0, fraction)) * 88;
  }
  return records.length <= 1 ? 50 : ((index + 0.5) / records.length) * 100;
}

function RecordTick({
  record,
  left,
  selected,
  onSelect,
}: {
  record: TrajectoryRecord;
  left: number;
  selected: boolean;
  onSelect: (record: TrajectoryRecord) => void;
}) {
  return (
    <button
      className={`overview-tick ${record.status} ${selected ? "selected" : ""}`}
      style={{ left: `${left}%` }}
      title={`${record.kind} · ${record.title}\n${time(record.at)}${record.durationMs !== undefined ? ` · ${record.durationMs}ms` : ""}\n${record.summary ?? ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(record);
      }}
    />
  );
}

export function TrajectoryOverview({
  projection,
  mode,
  onModeChange,
  selectedId,
  onSelectRecord,
  onSelectStage,
}: {
  projection: TrajectoryProjection;
  mode: OverviewMode;
  onModeChange: (mode: OverviewMode) => void;
  selectedId?: string;
  onSelectRecord: (record: TrajectoryRecord) => void;
  onSelectStage: (stage: string) => void;
}) {
  const start = projection.startAt ?? 0;
  const end = projection.endAt ?? start + 1;
  const span = Math.max(1, end - start);
  const allRecords = flattenTrajectoryRecords(projection.records);

  return (
    <div className="trajectory-overview">
      <div className="overview-head">
        <div>
          <p className="eyebrow">TIMING OVERVIEW</p>
          <h3>时间概览</h3>
        </div>
        <div className="overview-head-right">
          <div className="overview-mode" role="group" aria-label="时间概览布局">
            <button className={mode === "balanced" ? "chip active" : "chip"} onClick={() => onModeChange("balanced")}>均衡阶段</button>
            <button className={mode === "actual" ? "chip active" : "chip"} onClick={() => onModeChange("actual")}>真实时间</button>
          </div>
          <span className="hint">{mode === "balanced" ? "阶段等宽，阶段内事件展开" : "宽度按真实耗时"}</span>
        </div>
      </div>

      {mode === "balanced" ? (
        <div className="overview-balanced">
          {projection.stages.map((stage) => {
            const records = flattenTrajectoryRecords(stage.records);
            const duration = stageDuration(stage);
            return (
              <div
                className={`overview-stage-cell ${stage.status}`}
                key={stage.stage}
                title={`${stage.label} · ${time(stage.startAt)} → ${time(stage.endAt)} · ${records.length} records`}
                onClick={() => onSelectStage(stage.stage)}
              >
                <div className="overview-stage-label">
                  <span>{stage.label}</span>
                  <span className="overview-stage-meta">{records.length} · {formatDuration(duration)}</span>
                </div>
                <div className="overview-stage-track">
                  {records.length === 0 ? <span className="overview-empty-mark" /> : null}
                  {records.map((record, index) => (
                    <RecordTick
                      key={record.id}
                      record={record}
                      left={balancedPosition(record, index, records, stage)}
                      selected={record.id === selectedId}
                      onSelect={onSelectRecord}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div className="overview-track">
            {projection.stages.map((stage) => {
              if (stage.startAt === undefined || stage.endAt === undefined) return null;
              const left = ((stage.startAt - start) / span) * 100;
              const width = Math.max(3, ((stage.endAt - stage.startAt) / span) * 100);
              return (
                <button
                  className={`overview-stage ${stage.status}`}
                  key={stage.stage}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${stage.label} · ${time(stage.startAt)} → ${time(stage.endAt)} · ${stage.records.length} records`}
                  onClick={() => onSelectStage(stage.stage)}
                >
                  <span>{stage.label}</span>
                </button>
              );
            })}
            {allRecords.map((record) => (
              <RecordTick
                key={record.id}
                record={record}
                left={((record.at - start) / span) * 100}
                selected={record.id === selectedId}
                onSelect={onSelectRecord}
              />
            ))}
          </div>
          <div className="overview-axis">
            <span>{time(start)}</span>
            <span>{time(end)}</span>
          </div>
        </>
      )}
      <div className="overview-axis">
        <span>{mode === "balanced" ? "短阶段不会被压扁；仍可切换真实时间查看耗时比例" : `${allRecords.length} 条记录 · 点击圆点查看详情`}</span>
        <span>{projection.totalRecords} records</span>
      </div>
    </div>
  );
}
