import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { HarnessConfig, Task } from "../domain/types.js";
import { createBudget, initialMetrics } from "../domain/types.js";
import { STAGE_TOOLS, nextStage, stagePrompt } from "../domain/stages.js";
import { loadTicket } from "../integrations/ticket.js";
import { GitWorkspace, prepareTemplateWorkspace, sanitizeBranch } from "../integrations/git.js";
import { createStores, type HarnessStores } from "./stores.js";
import { CancelledError, InjectedCrash, TaskRuntime, BudgetExceededError } from "./runtime.js";
import { newTaskId } from "../store/task-store.js";
import { ContextAssembler, type ContextMetrics } from "../context/assembler.js";
import { createModelContext, runPiStageAgent, type ModelContext } from "../agent/session.js";
import { oneLine, sha256, shortHash } from "../utils/text.js";
import { OperationInFlightError } from "../store/operation-store.js";

export interface RunResult {
  task: Task;
  contextMetrics: ContextMetrics[];
  recoveryNotes: string[];
}

export class ForgePilotHarness {
  readonly stores: HarnessStores;
  readonly config: HarnessConfig;
  private readonly owner: string;
  private readonly activeSessions = new Map<string, AgentSession>();
  private models?: ModelContext;
  private contextMetrics: ContextMetrics[] = [];

  constructor(config: HarnessConfig) {
    this.config = config;
    this.stores = createStores(config.root);
    this.owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  }

  private async getModels(): Promise<ModelContext> {
    if (!this.models) this.models = await createModelContext(this.config.model);
    return this.models;
  }

  async createTaskFromTicket(ticketFile: string): Promise<{ task: Task; workspace: GitWorkspace }> {
    const loaded = await loadTicket(this.config.projectRoot, ticketFile);
    const taskId = newTaskId();
    const workspacePath = path.join(this.config.root, "workspaces", taskId);
    const prepared = await prepareTemplateWorkspace(loaded.templatePath, workspacePath, taskId);
    const now = Date.now();
    const task: Task = {
      id: taskId,
      ticketId: loaded.ticket.ticketId,
      projectId: loaded.ticket.projectId,
      title: loaded.ticket.title,
      description: loaded.ticket.description,
      expected: loaded.ticket.expected,
      repoName: loaded.ticket.repoName,
      templatePath: loaded.templatePath,
      workspacePath,
      baseCommit: prepared.baseCommit,
      branch: `${sanitizeBranch(taskId)}/fix`,
      stage: "PREPARE",
      lifecycle: "QUEUED",
      version: 1,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
      budget: loaded.budget,
      constraints: loaded.constraints,
      commands: loaded.commands,
      state: { confirmedFacts: [], hypotheses: [], attempts: [], pendingQuestions: [] },
      faults: this.config.fault ? [this.config.fault] : [],
      faultsFired: [],
      metrics: initialMetrics(),
    };
    await this.stores.tasks.create(task);
    await this.stores.events.append({
      taskId,
      type: "task_created",
      stage: "PREPARE",
      detail: { ticketId: task.ticketId, baseCommit: task.baseCommit, branch: task.branch },
    });
    return { task, workspace: prepared.workspace };
  }

  async listTasks(): Promise<Task[]> {
    return this.stores.tasks.list();
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    return this.stores.tasks.get(taskId);
  }

  async run(taskId: string): Promise<RunResult> {
    this.contextMetrics = [];
    const initial = await this.stores.tasks.get(taskId);
    if (!initial) throw new Error(`Task not found: ${taskId}`);
    if (!initial.workspacePath) throw new Error(`Task ${taskId} has no workspace`);

    const lease = await this.stores.leases.acquire(taskId, this.owner, 120_000);
    const workspace = new GitWorkspace(initial.workspacePath);
    const runtime = new TaskRuntime({
      stores: this.stores,
      task: initial,
      workspace,
      faults: this.config.fault ? [this.config.fault] : undefined,
      lease,
    });
    const heartbeat = setInterval(() => {
      void this.stores.leases.heartbeat(taskId, lease, 120_000).catch((err) => {
        if (process.env.FORGEPILOT_DEBUG_LEASE) console.error("[lease] heartbeat failed", (err as Error).message);
      });
    }, 20_000);
    let crash = false;
    const recoveryNotes: string[] = [];

    try {
      recoveryNotes.push(...(await runtime.recover()));
      let task = await runtime.reload();
      if (task.cancelRequested) {
        await this.finalizeCancel(runtime);
        return { task: await runtime.reload(), contextMetrics: this.contextMetrics, recoveryNotes };
      }
      if (task.lifecycle === "QUEUED") {
        task = await runtime.update((draft) => {
          draft.lifecycle = "RUNNING";
          draft.state.nextAction = "prepare the fixed workspace";
        });
      }

      while (true) {
        await this.stores.leases.heartbeat(taskId, lease, 120_000);
        task = await runtime.reload();
        if (task.cancelRequested || task.lifecycle === "CANCELLING") {
          await this.finalizeCancel(runtime);
          return { task: await runtime.reload(), contextMetrics: this.contextMetrics, recoveryNotes };
        }
        if (task.lifecycle === "CANCELLED" || task.lifecycle === "FAILED" || task.lifecycle === "DELIVERED") {
          return { task, contextMetrics: this.contextMetrics, recoveryNotes };
        }
        if (task.lifecycle === "WAITING_APPROVAL") {
          if (!this.config.autoApprove) {
            return { task, contextMetrics: this.contextMetrics, recoveryNotes };
          }
          await runtime.approve();
          continue;
        }
        await runtime.checkBudget();

        switch (task.stage) {
          case "PREPARE":
            await this.runPrepare(runtime);
            break;
          case "REPRODUCE":
            await this.runReproduce(runtime);
            break;
          case "REPAIR":
            await this.runRepair(runtime);
            break;
          case "VERIFY":
            await this.runVerify(runtime);
            break;
          case "PACKAGE":
            await this.runPackage(runtime);
            break;
          case "PUBLISH":
            await this.runPublish(runtime);
            break;
          case "DONE":
            await this.finish(runtime);
            return { task: await runtime.reload(), contextMetrics: this.contextMetrics, recoveryNotes };
        }

        const after = await runtime.reload();
        if (after.lifecycle === "WAITING_INPUT" || after.lifecycle === "PAUSED") {
          return { task: after, contextMetrics: this.contextMetrics, recoveryNotes };
        }
      }
    } catch (err) {
      if (err instanceof InjectedCrash) {
        crash = true;
        await this.stores.tasks.update(taskId, (draft) => {
          if (draft.lease) draft.lease.expiresAt = 0;
        });
        throw err;
      }
      if (err instanceof CancelledError) {
        await this.finalizeCancel(runtime);
        return { task: await runtime.reload(), contextMetrics: this.contextMetrics, recoveryNotes };
      }
      if (err instanceof BudgetExceededError) {
        await runtime.update((draft) => {
          draft.lifecycle = "PAUSED";
          draft.lastError = err.message;
          draft.state.nextAction = "human decision on budget";
        });
        return { task: await runtime.reload(), contextMetrics: this.contextMetrics, recoveryNotes };
      }
      const message = (err as Error).message;
      await runtime.update((draft) => {
        draft.lifecycle = "FAILED";
        draft.lastError = message;
        draft.state.nextAction = "human inspection";
      });
      await runtime.event("task_failed", { message });
      return { task: await runtime.reload(), contextMetrics: this.contextMetrics, recoveryNotes };
    } finally {
      clearInterval(heartbeat);
      if (!crash) {
        await this.stores.leases.release(taskId, lease).catch(() => undefined);
      }
    }
  }

  async approve(taskId: string): Promise<Task> {
    const runtime = await this.loadRuntime(taskId);
    const task = await runtime.approve();
    await runtime.saveCheckpoint("publish the approved patch");
    await runtime.event("approved", { patchHash: task.changePackage?.patchHash });
    return task;
  }

  async cancel(taskId: string): Promise<Task> {
    const task = await this.stores.tasks.update(taskId, (draft) => {
      draft.cancelRequested = true;
      if (!["DELIVERED", "FAILED", "CANCELLED"].includes(draft.lifecycle)) {
        draft.lifecycle = "CANCELLING";
      }
      return draft;
    });
    this.activeSessions.get(taskId)?.abort().catch(() => undefined);
    await this.stores.events.append({ taskId, type: "cancel_requested", stage: task.stage });
    if (!this.activeSessions.has(taskId)) {
      const runtime = await this.loadRuntime(taskId);
      await this.finalizeCancel(runtime);
      return runtime.task;
    }
    return task;
  }

  private async loadRuntime(taskId: string): Promise<TaskRuntime> {
    const task = await this.stores.tasks.get(taskId);
    if (!task?.workspacePath) throw new Error(`Task not found or workspace missing: ${taskId}`);
    return new TaskRuntime({
      stores: this.stores,
      task,
      workspace: new GitWorkspace(task.workspacePath),
      faults: this.config.fault ? [this.config.fault] : undefined,
    });
  }

  private async runPrepare(runtime: TaskRuntime): Promise<void> {
    const task = await runtime.reload();
    if (!task.baseCommit) throw new Error("baseCommit is missing");
    const head = await runtime.workspace.head();
    if (head !== task.baseCommit) {
      throw new Error(`Workspace HEAD ${head.slice(0, 12)} does not match base_commit ${task.baseCommit.slice(0, 12)}`);
    }
    await runtime.recordEvidence({
      claim: "Isolated workspace prepared at the fixed base commit.",
      kind: "command",
      reference: `git:${task.baseCommit.slice(0, 12)}`,
    });
    await this.advance(runtime, "REPRODUCE", "reproduce the defect on the baseline");
  }

  private async runReproduce(runtime: TaskRuntime): Promise<void> {
    const task = await runtime.reload();
    if (task.commands.repro) {
      const record = await runtime.runVerification("repro", "baseline reproduction");
      this.afterFault(runtime);
      if (record.exitCode === 0) {
        await runtime.recordEvidence({
          claim: "Reported defect reproduced on the unmodified baseline.",
          kind: "test",
          reference: `${record.id} / artifact:${record.artifactId}`,
        });
        await this.advance(runtime, "REPAIR", "locate the root cause and produce the minimal patch");
        return;
      }
      if (record.envError) {
        await this.handleEnvFailure(runtime, "repro");
        return;
      }
    }

    // Fall back to the visible test command as reproduction evidence.
    const test = await runtime.runVerification("test", "baseline test");
    this.afterFault(runtime);
    if (test.exitCode !== 0 && !test.envError) {
      await runtime.recordEvidence({
        claim: "Baseline test fails on the unmodified checkout, so the defect is observable.",
        kind: "test",
        reference: `${test.id} / artifact:${test.artifactId}`,
      });
      await this.advance(runtime, "REPAIR", "locate the root cause and produce the minimal patch");
      return;
    }
    if (test.envError) {
      await this.handleEnvFailure(runtime, "test");
      return;
    }
    await runtime.markWaitingInput(
      "Could not reproduce the defect: the repro command exited non-zero and the baseline tests pass. " +
        "Please clarify the reproduction steps or expected behavior.",
    );
  }

  private async runRepair(runtime: TaskRuntime): Promise<void> {
    const models = await this.getModels();
    const assembler = new ContextAssembler(this.stores.artifacts);
    const maxAttempts = Math.max(1, (this.config.maxNudges ?? 2) + 1);
    let lastReason = "";

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const task = await runtime.reload();
      const prompt =
        attempt === 0
          ? stagePrompt(task, "REPAIR")
          : stagePrompt(task, "REPAIR") +
            "\n\n<forgepilot_nudge>\nThe harness has not accepted the repair yet: " +
            lastReason +
            "\nUse tools to read the relevant code, record an evidence-backed hypothesis, then apply a minimal patch.\n</forgepilot_nudge>";
      await runPiStageAgent({
        runtime,
        stage: "REPAIR",
        prompt,
        allowedTools: STAGE_TOOLS.REPAIR,
        assembler,
        models,
        onContextMetrics: (metrics) => this.contextMetrics.push(metrics),
        onSession: (session) => this.activeSessions.set(task.id, session),
        onSessionDisposed: () => this.activeSessions.delete(task.id),
        onToolCall: (name, input) => {
          void runtime.event("tool_call", { name, input: sanitizeInput(input) });
        },
      });
      this.afterFault(runtime);
      await runtime.checkBudget();

      const after = await runtime.reload();
      if (after.lifecycle === "WAITING_INPUT") return;
      if (after.cancelRequested) throw new CancelledError(after.id);

      const diff = await runtime.currentDiff();
      const hasPatch = diff.diff.trim().length > 0;
      const hasHypothesis = after.state.hypotheses.length > 0;
      if (hasPatch && hasHypothesis) {
        await runtime.recordEvidence({
          claim: `Patch ${diff.patchHash.slice(0, 12)} applied to ${diff.changedFiles.length} file(s).`,
          kind: "artifact",
          reference: `patch:${diff.patchHash}`,
        });
        await this.advance(runtime, "VERIFY", "verify the current patch fingerprint");
        return;
      }
      lastReason = !hasPatch
        ? "no workspace diff was produced. Read the relevant files and call apply_patch."
        : "a patch exists but no root-cause hypothesis was recorded. Call record_hypothesis with file:line evidence.";
    }

    await runtime.markWaitingInput(`Repair did not converge: ${lastReason}`);
  }

  private async runVerify(runtime: TaskRuntime): Promise<void> {
    const task = await runtime.reload();
    const test = await runtime.runVerification("test", "post-patch verification");
    this.afterFault(runtime);
    const currentPatch = await runtime.currentPatchHash();
    if (test.envError) {
      await this.handleEnvFailure(runtime, "test");
      return;
    }
    if (test.exitCode !== 0 || test.patchHash !== currentPatch) {
      await runtime.update((draft) => {
        draft.budget.repairIterations += 1;
        draft.state.nextAction = "repair based on the failing verification evidence";
      });
      await runtime.recordEvidence({
        claim: "Post-patch tests failed.",
        kind: "test",
        reference: `${test.id} / artifact:${test.artifactId}`,
      });
      const latest = await runtime.reload();
      if (latest.budget.repairIterations >= latest.budget.maxRepairIterations) {
        await runtime.markWaitingInput(
          `Repair budget exhausted after ${latest.budget.repairIterations} failed verification round(s). ` +
            `Latest evidence: ${test.id}. Human decision required.`,
        );
        return;
      }
      await this.advance(runtime, "REPAIR", "fix the failing tests using the recorded evidence");
      return;
    }

    if (task.commands.build) {
      const build = await runtime.runVerification("build", "post-patch build");
      this.afterFault(runtime);
      if (build.envError) {
        await this.handleEnvFailure(runtime, "build");
        return;
      }
      if (build.exitCode !== 0) {
        await runtime.update((draft) => {
          draft.budget.repairIterations += 1;
        });
        await this.advance(runtime, "REPAIR", "fix the failing build using the recorded evidence");
        return;
      }
    }

    await runtime.recordEvidence({
      claim: "Tests and build pass on the current patch fingerprint.",
      kind: "test",
      reference: `${test.id} / patch:${currentPatch}`,
    });
    await this.advance(runtime, "PACKAGE", "assemble the change package and request approval");
  }

  private async runPackage(runtime: TaskRuntime): Promise<void> {
    const task = await runtime.reload();
    if (!task.changePackage) {
      const hypothesis = [...task.state.hypotheses].reverse().find((h) => h.status !== "rejected");
      try {
        await runtime.packageChange(
          hypothesis?.text ?? `Fix for ${task.ticketId}: ${task.title}`,
        );
      } catch (err) {
        await runtime.markWaitingInput(`Cannot package the change: ${(err as Error).message}`);
        return;
      }
    }
    await runtime.update((draft) => {
      draft.stage = "PACKAGE";
      draft.lifecycle = "WAITING_APPROVAL";
      draft.state.nextAction = "wait for human approval of this exact patch";
    });
    await runtime.saveCheckpoint("publish the approved patch");
    await runtime.event("waiting_approval", { patchHash: runtime.task.changePackage?.patchHash });
  }

  private async runPublish(runtime: TaskRuntime): Promise<void> {
    const task = await runtime.reload();
    if (!task.changePackage) throw new Error("Cannot publish without a change package");
    if (!task.changePackage.approvedAt) {
      if (!this.config.autoApprove) {
        await runtime.update((draft) => {
          draft.lifecycle = "WAITING_APPROVAL";
        });
        return;
      }
      await runtime.approve();
    }
    try {
      await runtime.publishBranch();
      this.afterFault(runtime);
      const result = await runtime.createPr();
      this.afterFault(runtime);
      const status = await this.stores.pr.get(result.pr.id);
      if (!status) throw new Error("PR creation returned without a queryable external record");
      await runtime.finishDelivered(
        `Delivered ${status.id}: ${status.url} (branch ${status.branch} @ ${status.headCommit.slice(0, 12)}). ` +
          `Patch ${task.changePackage.patchHash.slice(0, 12)} verified by ${task.changePackage.verificationId}. ` +
          `Human review and merge remain required.`,
      );
      await runtime.saveCheckpoint("delivered; awaiting human review/merge");
      await runtime.event("delivered", { prId: status.id, url: status.url });
    } catch (err) {
      if (err instanceof OperationInFlightError) {
        await runtime.recover();
        await runtime.publishBranch();
        const result = await runtime.createPr();
        await runtime.finishDelivered(`Delivered ${result.pr.id}: ${result.pr.url} (reconciled).`);
        return;
      }
      throw err;
    }
  }

  private async finish(runtime: TaskRuntime): Promise<void> {
    const task = await runtime.reload();
    if (task.lifecycle !== "DELIVERED") {
      await runtime.finishDelivered(
        task.summary ?? `Task ${task.id} complete. PR: ${task.pr?.url ?? "none"}.`,
      );
    }
    await runtime.saveCheckpoint("delivered");
  }

  private async advance(runtime: TaskRuntime, stage: Task["stage"], nextAction: string): Promise<void> {
    await runtime.update((draft) => {
      draft.stage = stage;
      draft.lifecycle = "RUNNING";
      draft.state.nextAction = nextAction;
    });
    await runtime.saveCheckpoint(nextAction);
    await runtime.event("stage_advanced", { to: stage, nextAction });
  }

  private async handleEnvFailure(runtime: TaskRuntime, kind: string): Promise<void> {
    await runtime.update((draft) => {
      draft.budget.envRetries += 1;
      draft.lastError = `Environment failure during ${kind}`;
    });
    const task = await runtime.reload();
    if (task.budget.envRetries > task.budget.maxEnvRetries) {
      await runtime.update((draft) => {
        draft.lifecycle = "PAUSED";
        draft.state.nextAction = "fix the execution environment; do not patch code";
      });
      return;
    }
    await runtime.update((draft) => {
      draft.state.nextAction = "retry after environment fix (do not change code)";
    });
  }

  private async finalizeCancel(runtime: TaskRuntime): Promise<void> {
    const notes = await runtime.recover().catch(() => []);
    await runtime.update((draft) => {
      draft.lifecycle = "CANCELLED";
      draft.lastError = notes.length ? `Cancelled after reconciliation: ${notes.join("; ")}` : "Cancelled by user";
      draft.state.nextAction = "cancelled; created branches/PRs are preserved for inspection";
    });
    await runtime.saveCheckpoint("cancelled").catch(() => undefined);
    await runtime.event("cancelled", { notes });
  }

  private afterFault(runtime: TaskRuntime): void {
    const fault = runtime.takePendingFault();
    if (fault) throw new InjectedCrash(fault);
  }
}

function sanitizeInput(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const text = JSON.stringify(input);
  if (text.length <= 1200) return input;
  return { truncated: true, preview: oneLine(text, 1000), hash: sha256(text).slice(0, 16) };
}
