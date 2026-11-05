import { time } from "../format";
import { flattenTrajectoryRecords, type TrajectoryProjection, type TrajectoryRecord } from "../trajectory/projection";

export function TrajectoryOverview({
  projection,
  selectedId,
  onSelectRecord,
  onSelectStage,
}: {
  projection: TrajectoryProjection;
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
        <span className="hint">点击色带跳到阶段 · 点击圆点打开记录 · {allRecords.length} 条记录</span>
      </div>
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
        {allRecords.map((record) => {
          const left = ((record.at - start) / span) * 100;
          return (
            <button
              key={record.id}
              className={`overview-tick ${record.status} ${record.id === selectedId ? "selected" : ""}`}
              style={{ left: `${left}%` }}
              title={`${record.kind} · ${record.title}\n${time(record.at)}${record.durationMs !== undefined ? ` · ${record.durationMs}ms` : ""}\n${record.summary ?? ""}`}
              onClick={() => onSelectRecord(record)}
            />
          );
        })}
      </div>
      <div className="overview-axis">
        <span>{time(start)}</span>
        <span>{time(end)}</span>
      </div>
    </div>
  );
}
