import path from "node:path";
import process from "node:process";
import { ForgePilotHarness } from "../src/harness/orchestrator.js";
import { InjectedCrash } from "../src/harness/runtime.js";
import { formatReviewReport, evaluateReviewRun, compareEvaluations } from "../src/eval/review/evaluate.js";
import { loadLabelSet, loadReviewRun, writeReviewReport } from "../src/eval/review/io.js";
import { createJudge } from "../src/eval/review/judge.js";
import { createModelContext } from "../src/agent/session.js";

const projectRoot = process.cwd();
const root = path.join(projectRoot, ".forgepilot");

async function fixDemo(): Promise<void> {
  const harness = new ForgePilotHarness({
    root,
    projectRoot,
    autoApprove: true,
    model: process.env.FORGEPILOT_MODEL,
  });
  const { task } = await harness.createTaskFromTicket("fixtures/tickets/T-1001.json");
  console.log(`[demo] created ${task.id}`);
  const result = await harness.run(task.id);
  console.log(
    JSON.stringify(
      {
        taskId: result.task.id,
        stage: result.task.stage,
        lifecycle: result.task.lifecycle,
        baseCommit: result.task.baseCommit,
        branch: result.task.branch,
        changedFiles: result.task.changePackage?.changedFiles,
        patchHash: result.task.changePackage?.patchHash,
        verificationId: result.task.changePackage?.verificationId,
        pr: result.task.pr,
        tokens: result.task.budget.tokensUsed,
        toolCalls: result.task.budget.toolCallsUsed,
        contextSamples: result.contextMetrics.map((m) => ({
          before: m.beforeTokens,
          after: m.afterTokens,
          summarized: m.summarizedMessages,
          offloaded: m.offloadedToolOutputs,
          pairs: m.preservedToolPairs,
        })),
        summary: result.task.summary,
      },
      null,
      2,
    ),
  );
}

async function faultDemo(): Promise<void> {
  const harness = new ForgePilotHarness({
    root,
    projectRoot,
    autoApprove: true,
    fault: "afterPrCreate",
    model: process.env.FORGEPILOT_MODEL,
  });
  const { task } = await harness.createTaskFromTicket("fixtures/tickets/T-1001.json");
  console.log(`[fault-demo] created ${task.id}; simulating a lost PR response`);
  try {
    await harness.run(task.id);
  } catch (err) {
    if (!(err instanceof InjectedCrash)) throw err;
    console.log(`[fault-demo] crashed as expected: ${err.faultName}`);
  }
  const before = await harness.getTask(task.id);
  const prsBefore = await new ForgePilotHarness({ root, projectRoot, autoApprove: true }).stores.pr.list();
  console.log(`[fault-demo] task after crash: ${before?.stage}/${before?.lifecycle}; PR records: ${prsBefore.length}`);
  const resumed = await harness.run(task.id);
  const prsAfter = await harness.stores.pr.list();
  console.log(
    JSON.stringify(
      {
        taskId: resumed.task.id,
        stage: resumed.task.stage,
        lifecycle: resumed.task.lifecycle,
        pr: resumed.task.pr,
        prCountBefore: prsBefore.length,
        prCountAfter: prsAfter.length,
        recoveryNotes: resumed.recoveryNotes,
        noDuplicatePr: prsAfter.filter((pr) => pr.taskId === task.id).length === 1,
      },
      null,
      2,
    ),
  );
}

async function reviewDemo(): Promise<void> {
  const runA = await loadReviewRun(projectRoot, "fixtures/review/run-a.json");
  const runB = await loadReviewRun(projectRoot, "fixtures/review/run-b.json");
  const labels = await loadLabelSet(projectRoot, "fixtures/review/labels-v1.json");
  const useLlm = process.argv.includes("--llm");
  const models = useLlm ? await createModelContext(process.env.FORGEPILOT_MODEL) : undefined;
  const judge = await createJudge(useLlm ? "llm" : "heuristic", models);
  const a = await evaluateReviewRun(runA, labels, judge);
  const b = await evaluateReviewRun(runB, labels, judge);
  const out = path.join(root, "review");
  const writtenA = await writeReviewReport(out, a.runId, a, formatReviewReport(a));
  const writtenB = await writeReviewReport(out, b.runId, b, formatReviewReport(b));
  console.log(formatReviewReport(a));
  console.log("\n" + compareEvaluations(a, b));
  console.log(`\nreports: ${writtenA.markdownPath}, ${writtenB.markdownPath}`);
}

const mode = process.argv[2] ?? "fix";
if (mode === "fix") await fixDemo();
else if (mode === "fault") await faultDemo();
else if (mode === "review") await reviewDemo();
else {
  console.error("Usage: tsx scripts/demo.ts [fix|fault|review] [--llm]");
  process.exit(1);
}
