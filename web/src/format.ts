export function time(value?: number): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function shortHash(value?: string): string {
  return value ? value.slice(0, 12) : "—";
}

export function stageLabel(stage: string): string {
  return stage;
}

export function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    task_created: "任务创建",
    stage_advanced: "阶段推进",
    tool_call: "工具调用",
    tool_result: "工具结果",
    agent_turn: "AI turn",
    verification: "验证",
    package_created: "变更包",
    waiting_approval: "等待审批",
    changes_requested: "要求修改",
    approved: "已审批",
    branch_published: "分支推送",
    pr_created: "PR 创建",
    delivered: "已交付",
    recovery: "恢复",
    cancelled: "取消",
    task_failed: "失败",
    context_metrics: "上下文",
    agent_settled: "Agent 结束",
    model_fallback: "模型回退",
    background_run_failed: "后台失败",
    swebench_started: "SWE-bench 开始",
    swebench_verified: "SWE-bench 验证",
    swebench_nudge: "SWE-bench 提醒",
  };
  return labels[type] ?? type;
}

export function eventTone(type: string): string {
  if (["task_failed", "background_run_failed", "cancelled"].includes(type)) return "danger";
  if (["approved", "delivered", "pr_created", "branch_published"].includes(type)) return "success";
  if (["changes_requested", "waiting_approval", "recovery"].includes(type)) return "warn";
  if (["tool_call", "tool_result", "agent_turn", "verification"].includes(type)) return "info";
  return "muted";
}
