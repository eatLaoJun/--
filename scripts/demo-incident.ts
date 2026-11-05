import path from "node:path";
import process from "node:process";
import { ForgePilotHarness } from "../src/harness/orchestrator.js";

const harness = new ForgePilotHarness({
  root: path.join(process.cwd(), ".forgepilot"),
  projectRoot: process.cwd(),
  autoApprove: true,
  model: process.env.FORGEPILOT_MODEL,
});

const { task } = await harness.createTaskFromIncident("INC-2026-001");
console.log(`[incident] ${task.incidentId} · ${task.service} · stage=${task.stage}`);
const result = await harness.run(task.id);
console.log(
  JSON.stringify(
    {
      taskId: result.task.id,
      source: result.task.source,
      incidentId: result.task.incidentId,
      service: result.task.service,
      repo: result.task.repoName,
      stage: result.task.stage,
      lifecycle: result.task.lifecycle,
      plan: result.task.plan,
      patchHash: result.task.changePackage?.patchHash,
      pr: result.task.pr,
      tokens: result.task.budget.tokensUsed,
      toolCalls: result.task.budget.toolCallsUsed,
    },
    null,
    2,
  ),
);
