import type { Stage, Task } from "./types.js";
import { STAGES } from "./types.js";

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

export const STAGE_TOOLS: Record<Stage, string[]> = {
  INGEST: ["get_task_status"],
  RESOLVE: ["get_task_status"],
  PLAN: [...READ_ONLY_TOOLS, "record_plan", "record_evidence", "get_task_status"],
  PREPARE: [...READ_ONLY_TOOLS, "get_ticket", "get_task_status"],
  REPRODUCE: [
    ...READ_ONLY_TOOLS,
    "run_verification",
    "record_evidence",
    "record_hypothesis",
    "get_task_status",
  ],
  REPAIR: [
    ...READ_ONLY_TOOLS,
    "apply_patch",
    "record_hypothesis",
    "record_evidence",
    "read_artifact",
    "get_task_status",
  ],
  VERIFY: [
    ...READ_ONLY_TOOLS,
    "run_verification",
    "read_artifact",
    "record_evidence",
    "get_task_status",
  ],
  PACKAGE: ["package_change", "read_artifact", "get_task_status", "request_input"],
  PUBLISH: ["publish_branch", "create_pr", "get_pr_status", "get_task_status"],
  DONE: ["get_task_status"],
};

export function stageIndex(stage: Stage): number {
  return STAGES.indexOf(stage);
}

export function nextStage(stage: Stage): Stage {
  const index = stageIndex(stage);
  if (index < 0 || index >= STAGES.length - 1) return "DONE";
  return STAGES[index + 1];
}

export function previousStage(stage: Stage): Stage {
  const index = stageIndex(stage);
  if (index <= 0) return STAGES[0];
  return STAGES[index - 1];
}

export function stageGoal(task: Task, stage: Stage): string {
  switch (stage) {
    case "INGEST":
      return "Read the incident from the event center, verify source and deduplication, then hand it to repository resolution. Do not modify code.";
    case "RESOLVE":
      return "Resolve the incident's service to an authorized repository, base branch, environment and trusted verification commands. Do not guess a repository.";
    case "PLAN":
      return "Read the repository and ticket, then record a structured plan: root-cause hypotheses, approach, alternatives, files, test plan and risks. Do not modify code.";
    case "PREPARE":
      return "Verify the isolated workspace and fixed base commit. Read the ticket and repository layout; do not modify code.";
    case "REPRODUCE":
      return "Reproduce the reported defect on the unmodified baseline. Run the configured repro command and record the observed evidence. Do not modify code.";
    case "REPAIR":
      return "Locate the root cause with file/line evidence, then produce the smallest correct patch using apply_patch. Do not modify tests or verification scripts.";
    case "VERIFY":
      return "Run the configured test/build verification on the current patch and record the result. If verification fails, report the failing evidence.";
    case "PACKAGE":
      return "Assemble the change package from the current diff and a matching successful verification. Request input if evidence is missing.";
    case "PUBLISH":
      return "Publish the approved commit to the task branch and create (or reconcile) the PR. Do not create duplicates.";
    case "DONE":
      return "Task is delivered. Report the final status and evidence references.";
  }
}

export function stagePrompt(task: Task, stage: Stage): string {
  const ticket = [
    `Title: ${task.title}`,
    `Description: ${task.description}`,
    `Expected: ${task.expected}`,
    `Constraints: ${task.constraints.notes.join("; ") || "(none)"}`,
    `Acceptance: ${task.constraints.acceptance.join("; ") || "(none)"}`,
  ].join("\n");

  return [
    `<forgepilot_stage stage="${stage}">`,
    stageGoal(task, stage),
    `</forgepilot_stage>`,
    "",
    "<ticket>",
    ticket,
    "</ticket>",
    "",
    "Work only through the available tools. Every factual claim about the code, tests or external state must cite a tool result.",
    "Do not claim a step succeeded without a matching tool result. If blocked, call request_input (only available in PACKAGE) or end with a concise blocker.",
  ].join("\n");
}

export function stageNudge(task: Task, stage: Stage, reason: string): string {
  return [
    `<forgepilot_nudge stage="${stage}">`,
    `The harness has not accepted this stage yet: ${reason}`,
    stageGoal(task, stage),
    "Continue using tools. Do not restate the plan without acting.",
    `</forgepilot_nudge>`,
  ].join("\n");
}
