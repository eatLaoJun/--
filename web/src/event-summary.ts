import type { EventItem } from "./types";

export function summarizeEvent(event: EventItem): string {
  const detail = event.detail ?? {};
  switch (event.type) {
    case "task_created":
      return `source ${String(detail.source ?? "ticket")} · incident ${String(detail.incidentId ?? "")} · base ${String(detail.baseCommit ?? "").slice(0, 12)}`;
    case "tool_call":
      return `${String(detail.name ?? "tool")} ${JSON.stringify(detail.input ?? {}).slice(0, 220)}`;
    case "incident_ingested":
      return `service ${String(detail.service ?? "")} · ${String(detail.incidentId ?? "")} · ${String(detail.url ?? "")}`;
    case "repository_resolved":
      return `${String(detail.repoName ?? "")} · base ${String(detail.baseCommit ?? "").slice(0, 12)} · ${String(detail.branch ?? "")}`;
    case "plan_recorded":
      return `plan artifact ${String(detail.artifactId ?? "").slice(0, 12)} · files ${((detail.filesToChange as string[] | undefined) ?? []).join(", ")}`;
    case "agent_turn": {
      const usage = (detail.usage ?? {}) as { input?: number; output?: number; cacheRead?: number };
      const tokens = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0);
      return `${String(detail.stage ?? "")} · ${String(detail.summary ?? "(no text)")} · ${tokens} tokens · ${String(detail.toolCalls ?? 0)} tools`;
    }
    case "tool_result":
      return `${String(detail.toolName ?? "tool")} ${detail.isError ? "failed" : "ok"} · ${String(detail.durationMs ?? "?")}ms · ${String(detail.summary ?? "")}`;
    case "verification":
      return `${String(detail.kind ?? "")} → exit ${String(detail.exitCode ?? "?")} · patch ${String(detail.fingerprint ?? "").slice(0, 10)}`;
    case "context_metrics":
      return `${String(detail.beforeTokens ?? "?")} → ${String(detail.afterTokens ?? "?")} tokens · summarized ${String(detail.summarizedMessages ?? 0)} · offloaded ${String(detail.offloadedToolOutputs ?? 0)}`;
    case "stage_advanced":
      return `→ ${String(detail.to ?? "")} · ${String(detail.nextAction ?? "")}`;
    case "changes_requested":
      return String(detail.message ?? "");
    case "package_created":
      return `patch ${String(detail.patchHash ?? "").slice(0, 12)} · ${(detail.changedFiles as string[] | undefined)?.join(", ") ?? ""}`;
    case "pr_created":
      return `${String(detail.prId ?? "")} ${String(detail.url ?? "")}`;
    case "recovery":
      return ((detail.notes as string[] | undefined) ?? []).join("；");
    case "task_failed":
    case "background_run_failed":
      return String(detail.message ?? "");
    case "agent_settled":
      return `aborted=${String(detail.aborted ?? false)}`;
    default:
      return JSON.stringify(detail).slice(0, 260);
  }
}
