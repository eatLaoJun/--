import path from "node:path";
import process from "node:process";
import { ForgePilotHarness } from "../src/harness/orchestrator.js";

const projectRoot = process.cwd();
const root = path.join(projectRoot, ".forgepilot");
const harness = new ForgePilotHarness({
  root,
  projectRoot,
  autoApprove: false,
  model: process.env.FORGEPILOT_MODEL,
});

const { task } = await harness.createTaskFromIssue("fixtures/github/issue-101.json");
console.log(`[review-chat] issue: ${task.issueUrl}`);
console.log(`[review-chat] task: ${task.id}`);

const run = await harness.run(task.id);
console.log(`[review-chat] after fix: ${run.task.stage}/${run.task.lifecycle}`);
console.log(`[review-chat] PR: ${run.task.pr?.url ?? "(waiting for approval)"}`);

async function ask(question: string): Promise<void> {
  console.log(`\n工程师> ${question}`);
  process.stdout.write("ForgePilot> ");
  const result = await harness.askReview(task.id, question, (delta) => process.stdout.write(delta));
  process.stdout.write("\n");
  if (!result.answer.trim()) console.log("(empty answer)");
}

await ask("为什么用 Math.ceil 而不是继续用 Math.floor + 1？这个改动会影响非整除和 total=0 的场景吗？");
await ask("你验证了什么？把测试证据和涉及的代码位置说清楚。");

if (process.argv.includes("--request-changes")) {
  console.log("\n[review-chat] requesting changes...");
  await harness.requestChanges(
    task.id,
    "请把 src/pagination.js 顶部仍然描述旧 bug 的注释一起更新，然后重新验证。",
    { start: false },
  );
  const changed = await harness.run(task.id);
  console.log(`[review-chat] after changes: ${changed.task.stage}/${changed.task.lifecycle}`);
  await ask("这次按审核意见改了哪些地方？");
}

const beforeApprove = await harness.getTask(task.id);
if (beforeApprove?.lifecycle !== "WAITING_APPROVAL" || !beforeApprove.changePackage) {
  console.error(
    `[review-chat] task is not ready for approval: ${beforeApprove?.stage}/${beforeApprove?.lifecycle}` +
      (beforeApprove?.lastError ? ` — ${beforeApprove.lastError}` : ""),
  );
  process.exit(1);
}
const approved = await harness.approve(task.id);
console.log(`\n[review-chat] approved patch ${approved.changePackage?.patchHash.slice(0, 12)}`);
const delivered = await harness.run(task.id);
console.log(`[review-chat] final: ${delivered.task.stage}/${delivered.task.lifecycle}`);
console.log(`[review-chat] PR: ${delivered.task.pr?.url}`);
console.log(`[review-chat] chat messages: ${(await harness.reviewHistory(task.id)).length}`);
