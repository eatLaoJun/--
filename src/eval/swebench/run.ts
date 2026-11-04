import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { ModelContext } from "../../agent/session.js";
import { createModelContext } from "../../agent/session.js";
import type { Task } from "../../domain/types.js";
import { createBudget, initialMetrics } from "../../domain/types.js";
import { createStores } from "../../harness/stores.js";
import { TaskRuntime } from "../../harness/runtime.js";
import { GitWorkspace, prepareTemplateWorkspace, sanitizeBranch } from "../../integrations/git.js";
import { applyHiddenTests, loadSwebenchInstances } from "./instances.js";
import { LocalVerifier, pickTests, type SwebenchVerifier } from "./verifier.js";
import type {
  AgentRunner,
  ArmReport,
  FailureCategory,
  InstanceRunResult,
  SwebenchArm,
  SwebenchInstance,
  SwebenchReport,
  TestCaseResult,
} from "./types.js";
import { PiSweAgentRunner } from "./agent-runner.js";
import { atomicWriteJson, ensureDir } from "../../utils/paths.js";
import { shortHash } from "../../utils/text.js";

export interface SwebenchRunOptions {
  projectRoot: string;
  evalRoot: string;
  instancesFile: string;
  arms: SwebenchArm[];
  limit?: number;
  model?: string;
  agentRunner?: AgentRunner;
  verifier?: SwebenchVerifier;
  onContextMetrics?: Parameters<typeof import("../../agent/session.js").runPiStageAgent>[0]["onContextMetrics"];
}

export async function runSwebenchEvaluation(options: SwebenchRunOptions): Promise<{
  report: SwebenchReport;
  jsonPath: string;
  markdownPath: string;
}> {
  const runId = `swe-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${shortHash(String(Math.random()), 4)}`;
  const instancesAll = await loadSwebenchInstances(options.projectRoot, options.instancesFile);
  const instances = options.limit ? instancesAll.slice(0, options.limit) : instancesAll;
  if (instances.length === 0) throw new Error("No SWE-bench instances selected");
  const models: ModelContext | undefined = options.agentRunner
    ? undefined
    : await createModelContext(options.model);
  const agentRunner = options.agentRunner ?? new PiSweAgentRunner(models!, options.onContextMetrics);
  const verifier = options.verifier ?? new LocalVerifier();
  const runRoot = path.join(options.evalRoot, "runs", runId);
  const storesRoot = path.join(runRoot, "state");
  await ensureDir(runRoot);

  const baselineValidation = new Map<string, { valid: boolean; results: TestCaseResult[]; error?: string }>();
  for (const instance of instances) {
    baselineValidation.set(instance.instance_id, await validateBaseline(instance, options.projectRoot, runRoot, verifier));
  }

  const arms: ArmReport[] = [];
  for (const arm of options.arms) {
    const results: InstanceRunResult[] = [];
    for (const instance of instances) {
      results.push(
        await runOne({
          instance,
          arm,
          projectRoot: options.projectRoot,
          runRoot,
          storesRoot,
          agentRunner,
          verifier,
          baseline: baselineValidation.get(instance.instance_id)!,
        }),
      );
    }
    arms.push(aggregateArm(arm, results));
  }

  const report: SwebenchReport = {
    runId,
    modelName: models?.name ?? agentRunner.name,
    dataset: path.basename(options.instancesFile),
    instanceIds: instances.map((instance) => instance.instance_id),
    createdAt: new Date().toISOString(),
    arms,
    notes: [
      "Generation input never includes the reference patch, hidden tests or FAIL_TO_PASS/PASS_TO_PASS fields.",
      "Both arms use the same model, environment, sample list and per-instance budgets.",
      "Hidden tests are applied only after the agent finishes.",
      "This local verifier is interface-compatible with the official SWE-bench harness, but numbers from this run are not official leaderboard results.",
    ],
  };

  const reportDir = path.join(options.evalRoot, "reports");
  await ensureDir(reportDir);
  const jsonPath = path.join(reportDir, `${runId}.json`);
  const markdownPath = path.join(reportDir, `${runId}.md`);
  await atomicWriteJson(jsonPath, report);
  await writeFile(markdownPath, formatSwebenchReport(report) + "\n", "utf8");
  return { report, jsonPath, markdownPath };
}

async function validateBaseline(
  instance: SwebenchInstance,
  projectRoot: string,
  runRoot: string,
  verifier: SwebenchVerifier,
): Promise<{ valid: boolean; results: TestCaseResult[]; error?: string }> {
  const baselineDir = path.join(runRoot, "baseline", instance.instance_id);
  try {
    await prepareTemplateWorkspace(path.resolve(projectRoot, instance.repo_template), baselineDir, `BASE-${instance.instance_id}`);
    await applyHiddenTests(projectRoot, baselineDir, instance.hidden_tests);
    const run = await verifier.verify(instance, baselineDir);
    const f2p = pickTests(run.results, instance.fail_to_pass);
    const p2p = pickTests(run.results, instance.pass_to_pass);
    const f2pOk = f2p.every((test) => !test.passed);
    const p2pOk = p2p.every((test) => test.passed);
    if (!f2pOk || !p2pOk) {
      return {
        valid: false,
        results: run.results,
        error: `baseline contract invalid (F2P should fail: ${f2pOk}, P2P should pass: ${p2pOk})`,
      };
    }
    return { valid: true, results: run.results };
  } catch (err) {
    return { valid: false, results: [], error: (err as Error).message };
  }
}

async function runOne(input: {
  instance: SwebenchInstance;
  arm: SwebenchArm;
  projectRoot: string;
  runRoot: string;
  storesRoot: string;
  agentRunner: AgentRunner;
  verifier: SwebenchVerifier;
  baseline: { valid: boolean; results: TestCaseResult[]; error?: string };
}): Promise<InstanceRunResult> {
  const { instance, arm, projectRoot, runRoot, storesRoot, agentRunner, verifier, baseline } = input;
  const taskId = `SWE-${sanitizeBranch(instance.instance_id)}-${arm}-${shortHash(`${Date.now()}${Math.random()}`, 5)}`;
  const workspacePath = path.join(runRoot, "workspaces", `${instance.instance_id}-${arm}-${shortHash(taskId, 6)}`);
  const tracePath = path.join(storesRoot, "tasks", taskId, "events.jsonl");
  const taskSkeleton: Partial<InstanceRunResult> = {
    instanceId: instance.instance_id,
    arm,
    resolved: false,
    failureCategory: "harness_error",
    changedFiles: [],
    testResults: [],
    failToPass: [],
    passToPass: [],
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    wallClockMs: 0,
    tracePath,
  };

  if (!baseline.valid) {
    return {
      ...(taskSkeleton as InstanceRunResult),
      failureCategory: "harness_error",
      error: baseline.error,
    };
  }

  try {
    const prepared = await prepareTemplateWorkspace(
      path.resolve(projectRoot, instance.repo_template),
      workspacePath,
      taskId,
    );
    const stores = createStores(storesRoot);
    const now = Date.now();
    const task: Task = {
      id: taskId,
      ticketId: instance.instance_id,
      projectId: "swebench-local",
      title: instance.instance_id,
      description: instance.problem_statement,
      expected: "Hidden FAIL_TO_PASS tests pass and PASS_TO_PASS tests do not regress.",
      repoName: instance.instance_id,
      templatePath: path.resolve(projectRoot, instance.repo_template),
      workspacePath,
      baseCommit: prepared.baseCommit,
      branch: `${sanitizeBranch(taskId)}/fix`,
      stage: "REPAIR",
      lifecycle: "RUNNING",
      version: 1,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
      budget: createBudget({
        maxTokens: instance.max_tokens ?? 60_000,
        maxToolCalls: instance.max_tool_calls ?? 20,
        maxWallClockMs: instance.max_wall_clock_ms ?? 300_000,
        maxRepairIterations: 2,
      }),
      constraints: {
        protectedPaths: ["tests/**", ".eval/**"],
        allowedPaths: ["**"],
        notes: ["Do not modify tests or hidden evaluation files."],
        acceptance: ["FAIL_TO_PASS pass", "PASS_TO_PASS do not regress"],
      },
      commands: {
        ...(instance.commands ?? {}),
        test: instance.commands?.test ?? "node --test",
      },
      state: { confirmedFacts: [], hypotheses: [], attempts: [], pendingQuestions: [] },
      faults: [],
      faultsFired: [],
      metrics: initialMetrics(),
    };
    await stores.tasks.create(task);
    await stores.events.append({ taskId, type: "swebench_started", detail: { instance: instance.instance_id, arm } });
    const runtime = new TaskRuntime({ stores, task, workspace: new GitWorkspace(workspacePath) });
    await runtime.recordEvidence({
      claim: "SWE-bench instance workspace prepared at the fixed base commit.",
      kind: "command",
      reference: `git:${prepared.baseCommit.slice(0, 12)}`,
    });

    const agentOutput = await agentRunner.run({ instance, arm, runtime });
    const after = await runtime.reload();
    const diff = await runtime.currentDiff();
    const changedFiles = diff.changedFiles;
    let patchArtifactId: string | undefined;
    if (diff.diff.trim()) {
      patchArtifactId = await runtime.offload(diff.diff, "swebench_patch", `${instance.instance_id}-${arm}.diff`);
    }

    let testResults: TestCaseResult[] = [];
    let failureCategory: FailureCategory = "resolved";
    let error: string | undefined;

    if (!diff.diff.trim()) {
      failureCategory = "empty_patch";
    } else {
      await applyHiddenTests(projectRoot, workspacePath, instance.hidden_tests);
      const run = await verifier.verify(instance, workspacePath);
      testResults = run.results;
      const f2p = pickTests(run.results, instance.fail_to_pass);
      const p2p = pickTests(run.results, instance.pass_to_pass);
      const f2pOk = f2p.every((test) => test.passed);
      const p2pOk = p2p.every((test) => test.passed);
      if (run.envError || run.results.length === 0) {
        failureCategory = "env_error";
        error = "hidden test command produced no parseable results or hit an environment error";
      } else if (!p2pOk) {
        failureCategory = "p2p_regression";
      } else if (!f2pOk) {
        failureCategory = "test_fail";
      } else {
        failureCategory = "resolved";
      }
      await stores.events.append({
        taskId,
        type: "swebench_verified",
        detail: { failureCategory, f2p: f2p.map((t) => t.name), p2p: p2p.map((t) => t.name) },
      });

      return {
        instanceId: instance.instance_id,
        arm,
        resolved: failureCategory === "resolved",
        failureCategory,
        diffHash: diff.patchHash,
        changedFiles,
        patchArtifactId,
        testResults,
        failToPass: f2p,
        passToPass: p2p,
        inputTokens: Math.max(agentOutput.inputTokens, after.metrics.inputTokens),
        outputTokens: Math.max(agentOutput.outputTokens, after.metrics.outputTokens),
        toolCalls: Math.max(agentOutput.toolCalls, after.metrics.toolCalls),
        wallClockMs: Math.max(agentOutput.wallClockMs, after.metrics.wallClockMs || 0),
        tracePath,
        error,
      };
    }

    return {
      instanceId: instance.instance_id,
      arm,
      resolved: false,
      failureCategory,
      diffHash: diff.patchHash,
      changedFiles,
      patchArtifactId,
      testResults,
      failToPass: [],
      passToPass: [],
      inputTokens: Math.max(agentOutput.inputTokens, after.metrics.inputTokens),
      outputTokens: Math.max(agentOutput.outputTokens, after.metrics.outputTokens),
      toolCalls: Math.max(agentOutput.toolCalls, after.metrics.toolCalls),
      wallClockMs: Math.max(agentOutput.wallClockMs, after.metrics.wallClockMs || 0),
      tracePath,
      error,
    };
  } catch (err) {
    const message = (err as Error).message;
    const budget = /budget/i.test(message);
    return {
      ...(taskSkeleton as InstanceRunResult),
      failureCategory: budget ? "budget_exceeded" : "agent_error",
      error: message,
    };
  }
}

function aggregateArm(arm: SwebenchArm, results: InstanceRunResult[]): ArmReport {
  const total = results.length;
  const resolved = results.filter((result) => result.resolved).length;
  const taxonomy: Record<string, number> = {};
  for (const result of results) {
    taxonomy[result.failureCategory] = (taxonomy[result.failureCategory] ?? 0) + 1;
  }
  const avg = (pick: (result: InstanceRunResult) => number): number =>
    total ? results.reduce((sum, result) => sum + pick(result), 0) / total : 0;
  return {
    arm,
    total,
    resolved,
    resolvedRate: total ? resolved / total : 0,
    averageInputTokens: avg((result) => result.inputTokens),
    averageOutputTokens: avg((result) => result.outputTokens),
    averageToolCalls: avg((result) => result.toolCalls),
    averageWallClockMs: avg((result) => result.wallClockMs),
    failureTaxonomy: taxonomy,
    results,
  };
}

export function formatSwebenchReport(report: SwebenchReport): string {
  const lines: string[] = [
    `# SWE-bench local evaluation ${report.runId}`,
    "",
    `- Model: ${report.modelName}`,
    `- Dataset: ${report.dataset}`,
    `- Instances: ${report.instanceIds.join(", ")}`,
    "",
    "## Arm comparison",
    "",
    "| arm | resolved / N | rate | avg input tok | avg output tok | avg tool calls | avg time |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.arms.map(
      (arm) =>
        `| ${arm.arm} | ${arm.resolved}/${arm.total} | ${(arm.resolvedRate * 100).toFixed(1)}% | ` +
        `${arm.averageInputTokens.toFixed(0)} | ${arm.averageOutputTokens.toFixed(0)} | ` +
        `${arm.averageToolCalls.toFixed(1)} | ${(arm.averageWallClockMs / 1000).toFixed(1)}s |`,
    ),
    "",
    "## Failure taxonomy",
    "",
    ...report.arms.flatMap((arm) => [
      `### ${arm.arm}`,
      ...Object.entries(arm.failureTaxonomy).map(([category, count]) => `- ${category}: ${count}`),
      "",
    ]),
    "## Per-instance",
    "",
    ...report.arms.flatMap((arm) => [
      `### ${arm.arm}`,
      ...arm.results.map(
        (result) =>
          `- ${result.instanceId}: ${result.resolved ? "resolved" : result.failureCategory}` +
          `${result.diffHash ? ` (patch ${result.diffHash.slice(0, 12)})` : ""}` +
          `${result.error ? ` — ${result.error}` : ""}`,
      ),
      "",
    ]),
    "## Notes",
    "",
    ...report.notes.map((note) => `- ${note}`),
  ];
  return lines.join("\n");
}
