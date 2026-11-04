import path from "node:path";
import process from "node:process";
import { runSwebenchEvaluation } from "../src/eval/swebench/run.js";

const args = process.argv.slice(2);
const limitIndex = args.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 2;
const armsArg = args.includes("--baseline-only") ? "baseline" : "baseline,enhanced";

const result = await runSwebenchEvaluation({
  projectRoot: process.cwd(),
  evalRoot: path.join(process.cwd(), ".forgepilot", "swebench"),
  instancesFile: "fixtures/swebench/instances.jsonl",
  arms: armsArg.split(",") as Array<"baseline" | "enhanced">,
  limit,
  model: process.env.FORGEPILOT_MODEL,
});
console.log(`run: ${result.report.runId}`);
for (const arm of result.report.arms) {
  console.log(
    `${arm.arm}: ${arm.resolved}/${arm.total} resolved, ` +
      `avg ${arm.averageInputTokens.toFixed(0)} input tokens, ${arm.averageToolCalls.toFixed(1)} tool calls, ` +
      `${(arm.averageWallClockMs / 1000).toFixed(1)}s`,
  );
  for (const item of arm.results) {
    console.log(`  - ${item.instanceId}: ${item.resolved ? "resolved" : item.failureCategory}${item.error ? ` (${item.error})` : ""}`);
  }
}
console.log(`report: ${result.markdownPath}`);
