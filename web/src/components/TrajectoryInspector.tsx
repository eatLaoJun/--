import { useEffect, useState } from "react";
import { time } from "../format";
import type { TrajectoryRecord } from "../trajectory/projection";

const TABS = ["summary", "input", "output", "raw"] as const;
type Tab = (typeof TABS)[number];

export function TrajectoryInspector({ record, onClose }: { record?: TrajectoryRecord; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("summary");

  useEffect(() => {
    setTab("summary");
  }, [record?.id]);

  if (!record) {
    return (
      <aside className="trajectory-inspector empty">
        <div className="empty-small">选择左侧一条记录查看详情。</div>
      </aside>
    );
  }

  const usage = record.usage;
  const total = usage ? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) : 0;
  const inputText = record.input === undefined ? "" : JSON.stringify(record.input, null, 2);
  const rawText = JSON.stringify(record.detail ?? {}, null, 2);
  const outputText = record.output ?? (record.children?.length ? record.children.map((child) => `${child.status === "error" ? "✗" : "✓"} ${child.kind}: ${child.title} — ${child.summary ?? ""}`).join("\n") : "");

  return (
    <aside className="trajectory-inspector">
      <header className="inspector-head">
        <div>
          <p className="eyebrow">{record.kind.toUpperCase()} · {record.stage}</p>
          <h3>{record.title}</h3>
          <p className="hint">{time(record.at)}{record.durationMs !== undefined ? ` · ${record.durationMs}ms` : ""}{total ? ` · ${total.toLocaleString()} tokens` : ""}</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="关闭详情">×</button>
      </header>

      <div className="inspector-tabs">
        {TABS.map((item) => (
          <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
            {item === "summary" ? "概览" : item === "input" ? "输入" : item === "output" ? "输出" : "原始"}
          </button>
        ))}
      </div>

      <div className="inspector-body">
        {tab === "summary" ? (
          <>
            <div className="kv"><span>状态</span><b className={record.status === "error" ? "danger" : record.status === "ok" ? "ok" : "warn"}>{record.status}</b></div>
            <div className="kv"><span>阶段</span><b>{record.stage}</b></div>
            {record.toolName ? <div className="kv"><span>工具</span><b className="mono">{record.toolName}</b></div> : null}
            {record.fingerprint ? <div className="kv"><span>指纹</span><b className="mono small">{record.fingerprint}</b></div> : null}
            {record.artifactId ? (
              <div className="kv">
                <span>Artifact</span>
                <b><a href={`/api/artifacts/${record.artifactId}`} target="_blank" rel="noreferrer" className="link">完整日志 / patch →</a></b>
              </div>
            ) : null}
            <p className="inspector-summary">{record.summary ?? "(no summary)"}</p>
            {record.kind === "verification" && record.output ? <pre className="inspector-pre">{record.output}</pre> : null}
            {record.kind === "assistant" ? (
              <div className="inspector-children">
                <h4>工具调用 ({record.children?.length ?? 0})</h4>
                {(record.children ?? []).map((child) => (
                  <div className={`inspector-child ${child.status}`} key={child.id}>
                    <span>{child.status === "error" ? "✗" : "✓"}</span>
                    <b>{child.title}</b>
                    <span className="mono small">{child.durationMs !== undefined ? `${child.durationMs}ms` : ""}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {tab === "input" ? (
          inputText ? <pre className="inspector-pre">{inputText}</pre> : <div className="empty-small">这条记录没有输入参数。</div>
        ) : null}

        {tab === "output" ? (
          outputText ? <pre className="inspector-pre">{outputText}</pre> : <div className="empty-small">这条记录没有保存输出摘要。</div>
        ) : null}

        {tab === "raw" ? <pre className="inspector-pre">{rawText}</pre> : null}
      </div>
    </aside>
  );
}
