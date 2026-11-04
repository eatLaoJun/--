#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { ForgePilotHarness } from "./harness/orchestrator.js";
import { InjectedCrash } from "./harness/runtime.js";
import { loadReviewRun, loadLabelSet, writeReviewReport } from "./eval/review/io.js";
import { evaluateReviewRun, compareEvaluations, formatReviewReport } from "./eval/review/evaluate.js";
import { createJudge } from "./eval/review/judge.js";
import { createModelContext } from "./agent/session.js";
import { runSwebenchEvaluation } from "./eval/swebench/run.js";
import { startWebServer } from "./web/server.js";
import { createInterface } from "node:readline/promises";
import type { EvaluationResult } from "./eval/review/types.js";
import { readJson } from "./utils/paths.js";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { command, positional, flags };
}

function str(flags: Record<string, string | boolean>, key: string, fallback?: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : fallback;
}

function bool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(str(flags, "project-root", process.cwd())!);
  const root = path.resolve(str(flags, "root", path.join(projectRoot, ".forgepilot"))!);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "fix") {
    const harness = new ForgePilotHarness({
      root,
      projectRoot,
      autoApprove: bool(flags, "auto-approve"),
      model: str(flags, "model"),
      fault: str(flags, "fault"),
      maxNudges: Number(str(flags, "max-nudges", "2")),
      quiet: bool(flags, "quiet"),
    });
    let taskId = str(flags, "task");
    if (!taskId) {
      const issue = str(flags, "issue");
      const created = issue
        ? await harness.createTaskFromIssue(issue)
        : await harness.createTaskFromTicket(str(flags, "ticket", "fixtures/tickets/T-1001.json")!);
      taskId = created.task.id;
      console.log(`created ${taskId} (base ${created.task.baseCommit?.slice(0, 12)}, branch ${created.task.branch})`);
      if (created.task.issueUrl) console.log(`issue: ${created.task.issueUrl}`);
    }
    const result = await harness.run(taskId);
    printTaskResult(result.task, result.contextMetrics.length, result.recoveryNotes);
    return;
  }

  if (command === "status") {
    const taskId = positional[0] ?? str(flags, "task");
    if (!taskId) throw new Error("status requires a task id");
    const harness = new ForgePilotHarness({ root, projectRoot, autoApprove: false });
    const task = await harness.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  if (command === "approve") {
    const taskId = positional[0] ?? str(flags, "task");
    if (!taskId) throw new Error("approve requires a task id");
    const harness = new ForgePilotHarness({ root, projectRoot, autoApprove: false });
    await harness.approve(taskId);
    const result = await harness.run(taskId);
    printTaskResult(result.task, result.contextMetrics.length, result.recoveryNotes);
    return;
  }

  if (command === "cancel") {
    const taskId = positional[0] ?? str(flags, "task");
    if (!taskId) throw new Error("cancel requires a task id");
    const harness = new ForgePilotHarness({ root, projectRoot, autoApprove: false });
    await harness.cancel(taskId);
    const result = await harness.run(taskId);
    printTaskResult(result.task, result.contextMetrics.length, result.recoveryNotes);
    return;
  }

  if (command === "serve") {
    const web = await startWebServer({
      projectRoot,
      root,
      port: Number(str(flags, "port", "4310")),
      host: str(flags, "host", "127.0.0.1"),
      model: str(flags, "model"),
    });
    console.log(`ForgePilot workbench: ${web.url}`);
    console.log("Ctrl+C to stop.");
    process.on("SIGINT", async () => {
      await web.close();
      process.exit(0);
    });
    await new Promise<void>(() => undefined);
    return;
  }

  if (command === "chat") {
    const taskId = positional[0] ?? str(flags, "task");
    if (!taskId) throw new Error("chat requires a task id");
    const harness = new ForgePilotHarness({ root, projectRoot, autoApprove: false, model: str(flags, "model") });
    const task = await harness.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    console.log(`review chat · ${task.ticketId} · ${task.stage}/${task.lifecycle}`);

    const showTrace = !bool(flags, "no-trace");
    let thinkingOpen = false;
    const trace = (event: import("./agent/ui-events.js").AgentStreamEvent) => {
      if (!showTrace) return;
      if (event.type === "thinking_delta") {
        if (!thinkingOpen) {
          process.stderr.write("\n[thinking] ");
          thinkingOpen = true;
        }
        process.stderr.write(event.text);
      } else if (event.type === "thinking_end") {
        if (thinkingOpen) {
          process.stderr.write("\n");
          thinkingOpen = false;
        }
      } else if (event.type === "tool_start") {
        process.stderr.write(`\n[tool] ${event.toolName} ${event.input}\n`);
      } else if (event.type === "tool_end") {
        process.stderr.write(
          `[tool] ${event.toolName} ${event.isError ? "failed" : "ok"}` +
            (event.durationMs !== undefined ? ` ${event.durationMs}ms` : "") +
            "\n",
        );
      }
    };

    const ask = async (message: string) => {
      process.stdout.write("ForgePilot> ");
      const result = await harness.askReview(
        taskId,
        message,
        (delta) => process.stdout.write(delta),
        trace,
      );
      process.stdout.write("\n");
      return result.answer;
    };

    const oneShot = str(flags, "message");
    if (oneShot) {
      await ask(oneShot);
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      while (true) {
        const line = (await rl.question("\n工程师> ")).trim();
        if (!line) continue;
        if (["exit", "quit", ":q"].includes(line.toLowerCase())) break;
        await ask(line);
      }
    } finally {
      rl.close();
    }
    return;
  }

  if (command === "changes") {
    const taskId = positional[0] ?? str(flags, "task");
    const message = str(flags, "message");
    if (!taskId || !message) throw new Error("changes requires a task id and --message");
    const harness = new ForgePilotHarness({ root, projectRoot, autoApprove: false, model: str(flags, "model") });
    await harness.requestChanges(taskId, message, { start: false });
    const result = await harness.run(taskId);
    printTaskResult(result.task, result.contextMetrics.length, result.recoveryNotes);
    return;
  }

  if (command === "review-eval") {
    const runFile = str(flags, "run");
    const labelsFile = str(flags, "labels");
    if (!runFile || !labelsFile) throw new Error("review-eval requires --run and --labels");
    const run = await loadReviewRun(projectRoot, runFile);
    const labels = await loadLabelSet(projectRoot, labelsFile);
    const judgeKind = str(flags, "judge", "heuristic") as "heuristic" | "llm";
    const models = judgeKind === "llm" ? await createModelContext(str(flags, "model")) : undefined;
    const judge = await createJudge(judgeKind, models);
    const result = await evaluateReviewRun(run, labels, judge);
    const outDir = path.resolve(str(flags, "out", path.join(root, "review"))!);
    const written = await writeReviewReport(outDir, result.runId, result, formatReviewReport(result));
    console.log(formatReviewReport(result));
    console.log(`\nreport: ${written.markdownPath}\njson: ${written.jsonPath}`);
    return;
  }

  if (command === "replay") {
    const aFile = str(flags, "a");
    const bFile = str(flags, "b");
    if (!aFile || !bFile) throw new Error("replay requires --a and --b report json files");
    const a = await readJson<EvaluationResult>(path.resolve(projectRoot, aFile));
    const b = await readJson<EvaluationResult>(path.resolve(projectRoot, bFile));
    if (!a || !b) throw new Error("Could not read one of the replay reports");
    console.log(compareEvaluations(a, b));
    return;
  }

  if (command === "swebench") {
    const instances = str(flags, "instances", "fixtures/swebench/instances.jsonl")!;
    const arms = (str(flags, "arms", "baseline,enhanced") ?? "baseline,enhanced")
      .split(",")
      .map((arm) => arm.trim())
      .filter(Boolean) as Array<"baseline" | "enhanced">;
    const result = await runSwebenchEvaluation({
      projectRoot,
      evalRoot: path.resolve(str(flags, "eval-root", path.join(root, "swebench"))!),
      instancesFile: instances,
      arms,
      limit: flags.limit ? Number(flags.limit) : undefined,
      model: str(flags, "model"),
    });
    console.log(`swebench ${result.report.runId}`);
    console.log(`report: ${result.markdownPath}\njson: ${result.jsonPath}`);
    console.log(`resolved: ${result.report.arms.map((arm) => `${arm.arm} ${arm.resolved}/${arm.total}`).join(", ")}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printTaskResult(
  task: {
    id: string;
    stage: string;
    lifecycle: string;
    lastError?: string;
    summary?: string;
    pr?: { id: string; url: string; branch: string; headCommit: string };
    changePackage?: { patchHash: string; verificationId: string; changedFiles: string[]; diffStat: string };
    patchHash?: string;
    budget: { tokensUsed: number; toolCallsUsed: number; repairIterations: number };
    workspacePath?: string;
  },
  contextSamples: number,
  recoveryNotes: string[],
): void {
  console.log("");
  console.log(`task: ${task.id}`);
  console.log(`stage: ${task.stage} / lifecycle: ${task.lifecycle}`);
  console.log(`budget: ${task.budget.tokensUsed} tokens, ${task.budget.toolCallsUsed} tool calls, ${task.budget.repairIterations} repair iterations`);
  console.log(`context samples: ${contextSamples}`);
  if (recoveryNotes.length) console.log(`recovery:\n  - ${recoveryNotes.join("\n  - ")}`);
  if (task.patchHash) console.log(`current patch: ${task.patchHash.slice(0, 12)}`);
  if (task.changePackage) {
    console.log(`change package: ${task.changePackage.patchHash.slice(0, 12)} (${task.changePackage.changedFiles.join(", ")})`);
    console.log(task.changePackage.diffStat);
  }
  if (task.pr) console.log(`PR: ${task.pr.id} ${task.pr.url} (${task.pr.branch} @ ${task.pr.headCommit.slice(0, 12)})`);
  if (task.summary) console.log(`summary: ${task.summary}`);
  if (task.lastError) console.log(`last error: ${task.lastError}`);
  if (task.workspacePath) console.log(`workspace: ${task.workspacePath}`);
}

function printHelp(): void {
  console.log(`ForgePilot CLI

  serve [--port 4310] [--host 127.0.0.1] [--model provider/id]
  fix --ticket <file> | --issue <github-issue-url-or-fixture> [--auto-approve] [--task <id>] [--fault <name>]
  chat <taskId> [--message "..."] [--model provider/id] [--no-trace]
  changes <taskId> --message "请改成 ..."
  status <taskId>
  approve <taskId>
  cancel <taskId>
  review-eval --run <run.json> --labels <labels.json> [--judge heuristic|llm] [--model provider/id]
  replay --a <report-a.json> --b <report-b.json>
  swebench [--instances <file>] [--arms baseline,enhanced] [--limit N] [--model provider/id]

Common options: --project-root <dir> --root <.forgepilot dir>

Fault injection names: afterPatch, afterTestRecord, afterPrCreate
`);
}

main().catch((err) => {
  if (err instanceof InjectedCrash) {
    console.error(`\nSIMULATED CRASH: ${err.faultName}`);
    console.error("The workspace/lease now look like a dead executor. Re-run the same task id to recover:");
    console.error("  npm run dev -- fix --task <taskId> --auto-approve");
    process.exit(2);
  }
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
