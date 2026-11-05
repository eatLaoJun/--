import type { TraceEvent } from "../store/event-log.js";
import { oneLine, truncate } from "../utils/text.js";

function summary(event: TraceEvent): string {
  const detail = event.detail ?? {};
  switch (event.type) {
    case "task_created":
      return `source=${String(detail.source ?? "ticket")} incident=${String(detail.incidentId ?? "")}`;
    case "incident_ingested":
      return `service=${String(detail.service ?? "")} url=${String(detail.url ?? "")}`;
    case "repository_resolved":
      return `repo=${String(detail.repoName ?? "")} base=${String(detail.baseCommit ?? "").slice(0, 12)} branch=${String(detail.branch ?? "")}`;
    case "stage_advanced":
      return `→ ${String(detail.to ?? "")} · ${String(detail.nextAction ?? "")}`;
    case "plan_recorded":
      return `plan=${String(detail.artifactId ?? "").slice(0, 12)} files=${((detail.filesToChange as string[] | undefined) ?? []).join(",")}`;
    case "tool_call":
      return `${String(detail.name ?? "tool")} ${truncate(JSON.stringify(detail.input ?? {}), 240)}`;
    case "tool_result":
      return `${String(detail.toolName ?? "tool")} ${detail.isError ? "failed" : "ok"} ${String(detail.durationMs ?? "?")}ms ${truncate(String(detail.summary ?? ""), 240)}`;
    case "agent_turn": {
      const usage = (detail.usage ?? {}) as { input?: number; output?: number; cacheRead?: number };
      return `stage=${String(detail.stage ?? "")} tokens=${(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0)} tools=${String(detail.toolCalls ?? 0)} ${truncate(String(detail.summary ?? ""), 500)}`;
    }
    case "verification":
      return `${String(detail.kind ?? "")} exit=${String(detail.exitCode ?? "?")} fingerprint=${String(detail.fingerprint ?? "").slice(0, 12)} artifact=${String(detail.artifactId ?? "").slice(0, 12)}`;
    case "context_metrics":
      return `${String(detail.beforeTokens ?? "?")}→${String(detail.afterTokens ?? "?")} tokens summarized=${String(detail.summarizedMessages ?? 0)} offloaded=${String(detail.offloadedToolOutputs ?? 0)}`;
    case "package_created":
      return `patch=${String(detail.patchHash ?? "").slice(0, 12)} files=${((detail.changedFiles as string[] | undefined) ?? []).join(",")} verification=${String(detail.verificationId ?? "")}`;
    case "changes_requested":
      return String(detail.message ?? "");
    case "approved":
      return `patch=${String(detail.patchHash ?? "").slice(0, 12)}`;
    case "pr_created":
      return `${String(detail.prId ?? "")} ${String(detail.url ?? "")} head=${String(detail.headCommit ?? "").slice(0, 12)}`;
    case "recovery":
      return ((detail.notes as string[] | undefined) ?? []).join("; ");
    case "task_failed":
    case "background_run_failed":
      return String(detail.message ?? "");
    case "agent_settled":
      return `aborted=${String(detail.aborted ?? false)}`;
    case "delivered":
      return `${String(detail.prId ?? "")} ${String(detail.url ?? "")}`;
    default:
      return truncate(JSON.stringify(detail), 300);
  }
}

export function formatTimeline(events: TraceEvent[], maxEvents = 160): string {
  const selected = events.slice(-maxEvents);
  const lines = selected.map((event) => {
    const at = new Date(event.at).toISOString();
    const stage = event.stage ? `[${event.stage}] ` : "";
    return `${at} ${stage}${event.type}: ${oneLine(summary(event), 700)}`;
  });
  if (events.length > selected.length) {
    lines.unshift(`(timeline truncated: showing last ${selected.length} of ${events.length} events)`);
  }
  return lines.join("\n") || "(no timeline events yet)";
}
