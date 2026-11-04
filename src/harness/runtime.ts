import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { PatchChange } from "../agent/tools/schemas.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import type {
  ChangePackage,
  Lease,
  EvidenceRef,
  Hypothesis,
  PrRecord,
  Stage,
  Task,
  TaskState,
  VerificationRecord,
} from "../domain/types.js";
import { executeVerification } from "../integrations/verification.js";
import { envFingerprint, GitWorkspace } from "../integrations/git.js";
import type { HarnessStores } from "./stores.js";
import { hashObject, shortHash } from "../utils/text.js";
import { ensureDir, matchesAnyGlob, safeJoin } from "../utils/paths.js";
import { semanticOperationKey } from "../store/operation-store.js";

export class InjectedCrash extends Error {
  constructor(public readonly faultName: string) {
    super(`Injected crash: ${faultName}`);
    this.name = "InjectedCrash";
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class CancelledError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} was cancelled`);
    this.name = "CancelledError";
  }
}

export interface RuntimeDeps {
  stores: HarnessStores;
  task: Task;
  workspace: GitWorkspace;
  faults?: string[];
  lease?: Lease;
}

export class StaleLeaseError extends Error {
  constructor(taskId: string) {
    super(`Executor no longer holds a valid lease for ${taskId}; refusing to write state.`);
    this.name = "StaleLeaseError";
  }
}

export class TaskRuntime {
  task: Task;
  readonly workspace: GitWorkspace;
  readonly stores: HarnessStores;
  private pendingFault?: string;
  private patchHashCache?: { hash: string; at: number };
  private readonly lease?: Lease;

  constructor(deps: RuntimeDeps) {
    this.task = deps.task;
    this.workspace = deps.workspace;
    if (this.task.baseCommit) this.workspace.setBase(this.task.baseCommit);
    this.stores = deps.stores;
    this.lease = deps.lease;
    if (deps.faults?.length && this.task.faults.length === 0) {
      this.task.faults = [...deps.faults];
    }
  }

  get state(): TaskState {
    return this.task.state;
  }

  async reload(): Promise<Task> {
    const latest = await this.stores.tasks.get(this.task.id);
    if (latest) this.task = latest;
    return this.task;
  }

  async update(mutator: (draft: Task) => void): Promise<Task> {
    if (this.lease) {
      let latest = await this.stores.tasks.get(this.task.id);
      if (
        latest?.lease &&
        latest.lease.owner === this.lease.owner &&
        latest.lease.epoch === this.lease.epoch &&
        latest.lease.expiresAt < Date.now() + 5_000
      ) {
        await this.stores.leases.heartbeat(this.task.id, this.lease, 120_000);
        latest = await this.stores.tasks.get(this.task.id);
      }
      if (
        !latest?.lease ||
        latest.lease.owner !== this.lease.owner ||
        latest.lease.epoch !== this.lease.epoch
      ) {
        if (process.env.FORGEPILOT_DEBUG_LEASE) {
          console.error("[lease] stale", this.task.id, "runtime", this.lease, "latest", latest?.lease);
        }
        throw new StaleLeaseError(this.task.id);
      }
    }
    this.task = await this.stores.tasks.update(this.task.id, (draft) => {
      mutator(draft);
      return draft;
    });
    return this.task;
  }

  async event(type: string, detail?: Record<string, unknown>): Promise<void> {
    await this.stores.events.append({
      taskId: this.task.id,
      type,
      stage: this.task.stage,
      detail,
    });
  }

  async ensureNotCancelled(): Promise<void> {
    const latest = await this.reload();
    if (latest.cancelRequested || latest.lifecycle === "CANCELLING" || latest.lifecycle === "CANCELLED") {
      throw new CancelledError(latest.id);
    }
  }

  async checkBudget(): Promise<void> {
    const task = this.task;
    if (task.budget.tokensUsed >= task.budget.maxTokens) {
      throw new BudgetExceededError(`Token budget exhausted (${task.budget.tokensUsed}/${task.budget.maxTokens})`);
    }
    if (task.budget.toolCallsUsed >= task.budget.maxToolCalls) {
      throw new BudgetExceededError(`Tool call budget exhausted (${task.budget.toolCallsUsed}/${task.budget.maxToolCalls})`);
    }
    if (Date.now() - task.budget.startedAt >= task.budget.maxWallClockMs) {
      throw new BudgetExceededError("Wall-clock budget exhausted");
    }
  }

  async addUsage(usage: { input: number; output: number; cacheRead: number }): Promise<void> {
    await this.update((draft) => {
      draft.metrics.llmCalls += 1;
      draft.metrics.inputTokens += usage.input;
      draft.metrics.outputTokens += usage.output;
      draft.metrics.cacheReadTokens += usage.cacheRead;
      draft.budget.tokensUsed += usage.input + usage.output + usage.cacheRead;
      draft.budget.elapsedMs = Date.now() - draft.budget.startedAt;
    });
  }

  async countToolCall(toolName: string): Promise<void> {
    await this.update((draft) => {
      draft.budget.toolCallsUsed += 1;
      draft.metrics.toolCalls += 1;
      draft.budget.elapsedMs = Date.now() - draft.budget.startedAt;
      draft.state.attempts.push({
        id: `A-${Date.now()}-${shortHash(toolName, 4)}`,
        action: `tool:${toolName}`,
        result: "unknown",
        detail: "started",
        at: Date.now(),
      });
      if (draft.state.attempts.length > 80) draft.state.attempts.shift();
    });
  }

  async currentPatchHash(): Promise<string> {
    const now = Date.now();
    if (this.patchHashCache && now - this.patchHashCache.at < 500) return this.patchHashCache.hash;
    const hash = await this.workspace.patchHash();
    this.patchHashCache = { hash, at: now };
    return hash;
  }

  async currentDiff(): Promise<{ diff: string; patchHash: string; diffStat: string; changedFiles: string[] }> {
    const [diff, diffStat, changedFiles] = await Promise.all([
      this.workspace.diff(),
      this.workspace.diffStat(),
      this.workspace.changedFiles(),
    ]);
    return { diff, patchHash: hashObject({ diff }), diffStat, changedFiles };
  }

  async offload(content: string, kind: string, name?: string): Promise<string> {
    const meta = await this.stores.artifacts.put(content, { taskId: this.task.id, kind, name });
    return meta.id;
  }

  async recordEvidence(input: Omit<EvidenceRef, "id" | "at">): Promise<EvidenceRef> {
    const evidence: EvidenceRef = {
      ...input,
      id: `E-${Date.now()}-${shortHash(input.claim, 4)}`,
      at: Date.now(),
    };
    await this.update((draft) => {
      draft.state.confirmedFacts.push(evidence);
      if (draft.state.confirmedFacts.length > 40) draft.state.confirmedFacts.shift();
    });
    return evidence;
  }

  async recordHypothesis(input: Omit<Hypothesis, "id" | "at">): Promise<Hypothesis> {
    const hypothesis: Hypothesis = {
      ...input,
      id: `H-${Date.now()}-${shortHash(input.text, 4)}`,
      at: Date.now(),
    };
    await this.update((draft) => {
      draft.state.hypotheses.push(hypothesis);
      if (draft.state.hypotheses.length > 30) draft.state.hypotheses.shift();
    });
    return hypothesis;
  }

  async applyChanges(changes: PatchChange[], rationale: string): Promise<{
    patchHash: string;
    diff: string;
    diffStat: string;
    changedFiles: string[];
    artifactId: string;
    replayed: boolean;
  }> {
    await this.ensureNotCancelled();
    const inputHash = hashObject({ changes });
    const opKey = semanticOperationKey({
      taskId: this.task.id,
      opType: "apply_patch",
      target: "workspace",
      inputHash,
      version: this.task.baseCommit,
    });
    const { record, replay } = await this.stores.operations.begin({
      taskId: this.task.id,
      opKey,
      toolName: "apply_patch",
      inputHash,
      maxAttempts: 2,
    });
    if (replay) {
      const result = record.result as {
        patchHash: string;
        diff: string;
        diffStat: string;
        changedFiles: string[];
        artifactId: string;
      };
      return { ...result, replayed: true };
    }

    const prepared: Array<{ absolute: string; relative: string; content: string }> = [];
    const seen = new Set<string>();
    for (const change of changes) {
      const absolute = safeJoin(this.workspace.path, change.path);
      const relative = path.relative(this.workspace.path, absolute).replaceAll("\\", "/");
      if (matchesAnyGlob(relative, this.task.constraints.protectedPaths)) {
        throw new Error(
          `Protected path cannot be modified: ${relative}. Tests and verification scripts are owned by the harness.`,
        );
      }
      if (!matchesAnyGlob(relative, this.task.constraints.allowedPaths)) {
        throw new Error(`Path is outside the task's allowed modification range: ${relative}`);
      }
      const current = await readFile(absolute, "utf8").catch((err) => {
        throw new Error(`Cannot read ${relative}: ${(err as Error).message}. Use read first and quote an exact unique oldText.`);
      });
      if (seen.has(relative)) {
        throw new Error(`Duplicate file in one patch: ${relative}. Merge edits into one change entry.`);
      }
      seen.add(relative);
      const occurrences = countOccurrences(current, change.oldText);
      if (occurrences === 0) {
        throw new Error(
          `oldText not found in ${relative}. Include the exact current text (whitespace sensitive); use read to re-check.`,
        );
      }
      if (occurrences > 1) {
        throw new Error(
          `oldText appears ${occurrences} times in ${relative}. Add surrounding context so the replacement is unique.`,
        );
      }
      prepared.push({ absolute, relative, content: current.replace(change.oldText, change.newText) });
    }

    // Write temp files first, then rename, so a validation failure cannot leave a
    // half-applied patch.
    const temps: Array<{ tmp: string; absolute: string }> = [];
    for (const item of prepared) {
      const tmp = `${item.absolute}.forgepilot-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
      await writeFile(tmp, item.content, "utf8");
      temps.push({ tmp, absolute: item.absolute });
    }
    for (const item of temps) {
      await rename(item.tmp, item.absolute);
    }

    const { diff, patchHash, diffStat, changedFiles } = await this.currentDiff();
    this.patchHashCache = { hash: patchHash, at: Date.now() };
    const artifact = await this.stores.artifacts.put(diff, {
      taskId: this.task.id,
      kind: "patch",
      name: `patch-${patchHash.slice(0, 12)}.diff`,
    });
    const result = { patchHash, diff, diffStat, changedFiles, artifactId: artifact.id };

    await this.update((draft) => {
      draft.patchHash = patchHash;
      draft.state.attempts.push({
        id: `A-${Date.now()}-patch`,
        action: "apply_patch",
        result: "success",
        detail: `${changedFiles.length} file(s), patch ${patchHash.slice(0, 12)}; rationale: ${rationale}`,
        at: Date.now(),
      });
      draft.state.nextAction = "verify the patch on the current fingerprint";
    });

    if (await this.shouldFire("afterPatch")) {
      const current = await this.stores.operations.get(this.task.id, opKey);
      if (current) {
        await this.stores.operations.markUnknown(current, "simulated crash after patch write, before checkpoint");
      }
      this.pendingFault = "afterPatch";
      return { ...result, patchHash, diff, diffStat, changedFiles, artifactId: artifact.id, replayed: false };
    }

    await this.stores.operations.complete(record, result, artifact.id);
    return { ...result, replayed: false };
  }

  async runVerification(kind: "repro" | "test" | "build" | "swebench", note = ""): Promise<VerificationRecord> {
    await this.ensureNotCancelled();
    const command = this.task.commands[kind];
    if (!command) throw new Error(`No configured command for kind=${kind}. Trusted project configuration owns commands.`);
    const patchHash = await this.currentPatchHash();
    const env = await envFingerprint(this.workspace.path);
    const existing = (await this.stores.verifications.list(this.task.id))
      .slice()
      .reverse()
      .find(
        (record) =>
          record.kind === kind &&
          record.command === command &&
          record.patchHash === patchHash &&
          record.baseCommit === (this.task.baseCommit ?? "") &&
          record.envFingerprint === env,
      );
    if (existing) return existing;

    const hasDiff = (await this.workspace.diff()).trim().length > 0;
    const execution = await executeVerification({
      taskId: this.task.id,
      kind,
      command,
      workspacePath: this.workspace.path,
      baseCommit: this.task.baseCommit ?? "",
      patchHash,
      timeoutMs: 120_000,
    });

    const output = `${execution.result.stdout}\n${execution.result.stderr}`.trim();
    const artifact = await this.stores.artifacts.put(output, {
      taskId: this.task.id,
      kind: `verification:${kind}`,
      name: `${kind}-${shortHash(execution.fingerprint, 8)}.log`,
    });
    const record: VerificationRecord = {
      id: `V-${Date.now()}-${shortHash(execution.fingerprint, 6)}`,
      taskId: this.task.id,
      kind,
      command,
      exitCode: execution.result.exitCode,
      timedOut: execution.result.timedOut,
      envError: execution.envError,
      durationMs: execution.result.durationMs,
      patchHash,
      baseCommit: this.task.baseCommit ?? "",
      envFingerprint: env,
      fingerprint: execution.fingerprint,
      artifactId: artifact.id,
      keyOutput: execution.keyOutput,
      at: Date.now(),
    };
    await this.stores.verifications.append(record);
    await this.update((draft) => {
      draft.patchHash = hasDiff ? patchHash : undefined;
      draft.state.attempts.push({
        id: `A-${Date.now()}-verify`,
        action: `run_verification:${kind}`,
        result: execution.result.exitCode === 0 ? "success" : "failure",
        detail: `${command} -> exit ${execution.result.exitCode}${note ? ` (${note})` : ""}`,
        at: Date.now(),
      });
      if (draft.state.attempts.length > 80) draft.state.attempts.shift();
      if (execution.envError) draft.budget.envRetries += 1;
      draft.state.nextAction =
        execution.result.exitCode === 0 ? "proceed using this verification evidence" : "inspect key output / artifacts";
    });
    await this.event("verification", {
      kind,
      exitCode: record.exitCode,
      fingerprint: record.fingerprint,
      artifactId: record.artifactId,
    });

    if (await this.shouldFire("afterTestRecord")) {
      this.pendingFault = "afterTestRecord";
    }
    return record;
  }

  async packageChange(rationale: string): Promise<ChangePackage> {
    const { diff, patchHash, diffStat, changedFiles } = await this.currentDiff();
    if (!diff.trim()) throw new Error("No patch to package. Apply a change first.");
    const verifications = await this.stores.verifications.list(this.task.id);
    const test = verifications
      .slice()
      .reverse()
      .find((v) => v.kind === "test" && v.patchHash === patchHash && !v.envError);
    if (!test) {
      throw new Error(
        "No test verification matches the current patch fingerprint. Run run_verification(kind=test) before packaging.",
      );
    }
    if (test.exitCode !== 0) {
      throw new Error(`Latest matching test verification failed (exit ${test.exitCode}); fix the code before packaging.`);
    }
    if (this.task.commands.build) {
      const build = verifications
        .slice()
        .reverse()
        .find((v) => v.kind === "build" && v.patchHash === patchHash && !v.envError);
      if (build && build.exitCode !== 0) {
        throw new Error(`Latest matching build verification failed (exit ${build.exitCode}).`);
      }
    }
    const artifact = await this.stores.artifacts.put(diff, {
      taskId: this.task.id,
      kind: "change_package",
      name: `change-${patchHash.slice(0, 12)}.diff`,
    });
    const pkg: ChangePackage = {
      patchArtifactId: artifact.id,
      patchHash,
      diffStat,
      changedFiles,
      rationale,
      verificationId: test.id,
      verificationFingerprint: test.fingerprint,
      riskNotes: [
        "Patch is verified only for the recorded fingerprint; any later edit invalidates it.",
        "Human review and merge remain required.",
      ],
      createdAt: Date.now(),
    };
    await this.update((draft) => {
      draft.changePackage = pkg;
      draft.patchHash = patchHash;
      draft.state.nextAction = "wait for human approval of this exact patch";
    });
    await this.event("package_created", { patchHash, verificationId: test.id, changedFiles });
    return pkg;
  }

  async approve(): Promise<Task> {
    const task = await this.reload();
    if (!task.changePackage) throw new Error("No change package to approve");
    if (task.stage !== "PACKAGE") throw new Error(`Cannot approve in stage ${task.stage}`);
    return this.update((draft) => {
      draft.changePackage!.approvedAt = Date.now();
      draft.stage = "PUBLISH";
      draft.lifecycle = "RUNNING";
      draft.state.nextAction = "publish the approved commit and reconcile the PR";
    });
  }

  async publishBranch(): Promise<{ branch: string; commit: string; replayed: boolean }> {
    await this.ensureNotCancelled();
    const pkg = this.task.changePackage;
    if (!pkg) throw new Error("No approved change package");
    if (!pkg.approvedAt) throw new Error("Change package has not been approved; publish is blocked.");
    const patchHash = await this.currentPatchHash();
    if (patchHash !== pkg.patchHash) {
      throw new Error("Workspace changed after approval; re-verify and re-approve before publishing.");
    }
    const opKey = semanticOperationKey({
      taskId: this.task.id,
      opType: "publish_branch",
      target: this.task.branch,
      inputHash: patchHash,
      version: this.task.baseCommit,
    });
    const { record, replay } = await this.stores.operations.begin({
      taskId: this.task.id,
      opKey,
      toolName: "publish_branch",
      inputHash: patchHash,
      maxAttempts: 2,
    });
    if (replay) return record.result as { branch: string; commit: string; replayed: boolean };

    await this.workspace.ensureBranch(this.task.branch);
    const commit = await this.workspace.commitAll(`${this.task.ticketId}: ${this.task.title}`);
    const result = { branch: this.task.branch, commit, replayed: false };
    await this.stores.operations.complete(record, result);
    await this.update((draft) => {
      draft.state.attempts.push({
        id: `A-${Date.now()}-publish`,
        action: "publish_branch",
        result: "success",
        detail: `${draft.branch} @ ${commit.slice(0, 12)}`,
        at: Date.now(),
      });
    });
    await this.event("branch_published", { branch: this.task.branch, commit });
    return result;
  }

  async createPr(): Promise<{ pr: PrRecord; replayed: boolean }> {
    await this.ensureNotCancelled();
    if (this.task.pr) return { pr: this.task.pr, replayed: true };
    const head = await this.workspace.head();
    if (head === this.task.baseCommit) {
      throw new Error("Nothing has been published yet; call publish_branch before create_pr.");
    }
    const patchHash = this.task.changePackage?.patchHash ?? (await this.currentPatchHash());
    const opKey = semanticOperationKey({
      taskId: this.task.id,
      opType: "create_pr",
      target: this.task.branch,
      inputHash: patchHash,
      version: head,
    });
    const existingPr = await this.stores.pr.findByTask(this.task.id);
    if (existingPr) {
      const pending = (await this.stores.operations.list(this.task.id)).find(
        (op) => op.toolName === "create_pr" && op.status !== "done",
      );
      if (pending) await this.stores.operations.complete(pending, { pr: existingPr });
      await this.update((draft) => {
        draft.pr = existingPr;
      });
      return { pr: existingPr, replayed: true };
    }
    const { record, replay } = await this.stores.operations.begin({
      taskId: this.task.id,
      opKey,
      toolName: "create_pr",
      inputHash: patchHash,
      maxAttempts: 2,
    });
    if (replay) {
      const pr = (record.result as { pr: PrRecord }).pr;
      await this.update((draft) => {
        draft.pr = pr;
      });
      return { pr, replayed: true };
    }

    const pkg = this.task.changePackage;
    const pr = await this.stores.pr.create({
      taskId: this.task.id,
      repo: this.task.repoName,
      branch: this.task.branch,
      base: "main",
      headCommit: head,
      title: `[${this.task.ticketId}] ${this.task.title}`,
      body: [
        "## Summary",
        pkg?.rationale ?? "Automated bug fix.",
        "",
        "## Evidence",
        `- patch: ${patchHash}`,
        `- verification: ${pkg?.verificationId ?? "n/a"}`,
        `- changed files: ${pkg?.changedFiles.join(", ") ?? "n/a"}`,
        "",
        "Generated by ForgePilot. Human review and merge are required.",
      ].join("\n"),
    });

    if (await this.shouldFire("afterPrCreate")) {
      const current = await this.stores.operations.get(this.task.id, opKey);
      if (current) await this.stores.operations.markUnknown(current, "simulated lost PR response");
      this.pendingFault = "afterPrCreate";
      return { pr, replayed: false };
    }

    await this.stores.operations.complete(record, { pr });
    await this.update((draft) => {
      draft.pr = pr;
      draft.state.attempts.push({
        id: `A-${Date.now()}-pr`,
        action: "create_pr",
        result: "success",
        detail: `${pr.id} ${pr.url}`,
        at: Date.now(),
      });
    });
    await this.event("pr_created", { prId: pr.id, url: pr.url, headCommit: head });
    return { pr, replayed: false };
  }

  takePendingFault(): string | undefined {
    const fault = this.pendingFault;
    this.pendingFault = undefined;
    return fault;
  }

  private async shouldFire(name: string): Promise<boolean> {
    if (!this.task.faults.includes(name)) return false;
    if (this.task.faultsFired.includes(name)) return false;
    await this.update((draft) => {
      if (!draft.faultsFired.includes(name)) draft.faultsFired.push(name);
    });
    return true;
  }

  async saveCheckpoint(nextSafeAction: string): Promise<Checkpoint> {
    const patchHash = await this.currentPatchHash();
    const head = await this.workspace.head();
    const ops = await this.stores.operations.list(this.task.id);
    const latestVerification = await this.stores.verifications.latest(this.task.id, "test");
    const checkpoint: Checkpoint = {
      id: `C-${Date.now()}-${shortHash(`${this.task.id}${this.task.stage}`, 4)}`,
      taskId: this.task.id,
      stage: this.task.stage,
      lifecycle: this.task.lifecycle,
      taskVersion: this.task.version,
      nextSafeAction,
      workspace: {
        path: this.workspace.path,
        head,
        patchHash,
        diffStat: await this.workspace.diffStat(),
      },
      operationsDone: ops.filter((op) => op.status === "done").map((op) => op.opKey),
      operationsPending: ops.filter((op) => op.status !== "done").map((op) => op.opKey),
      verificationFingerprint: latestVerification?.fingerprint,
      state: structuredClone(this.task.state),
      budget: structuredClone(this.task.budget),
      createdAt: Date.now(),
    };
    await this.stores.checkpoints.save(checkpoint);
    return checkpoint;
  }

  /** Reconcile in-flight operations after an executor crash or lease takeover. */
  async recover(): Promise<string[]> {
    const notes: string[] = [];
    await this.reload();
    const ops = await this.stores.operations.list(this.task.id);
    for (const op of ops) {
      if (op.status === "done" || op.status === "failed") continue;
      if (op.toolName === "apply_patch") {
        const { patchHash, changedFiles } = await this.currentDiff();
        if (patchHash && changedFiles.length > 0) {
          const partial = (op.result as { patchHash?: string } | undefined)?.patchHash;
          if (!partial || partial === patchHash) {
            await this.stores.operations.complete(op, {
              patchHash,
              changedFiles,
              diff: "(recovered; read patch artifact or workspace diff)",
              diffStat: await this.workspace.diffStat(),
              artifactId: (await this.offload(await this.workspace.diff(), "patch", `recovered-${patchHash.slice(0, 8)}.diff`)),
            });
            notes.push(`apply_patch: reconciled from workspace diff ${patchHash.slice(0, 12)}`);
          } else {
            await this.stores.operations.fail(op, `workspace patch ${patchHash.slice(0, 12)} != recorded ${partial.slice(0, 12)}`);
            notes.push("apply_patch: workspace mismatch, marked failed for a clean retry");
          }
        } else {
          await this.stores.operations.fail(op, "no workspace changes found");
          notes.push("apply_patch: no changes found, marked failed");
        }
      } else if (op.toolName === "create_pr") {
        const pr = await this.stores.pr.findByTask(this.task.id);
        if (pr) {
          await this.stores.operations.complete(op, { pr });
          await this.update((draft) => {
            draft.pr = pr;
          });
          notes.push(`create_pr: found existing ${pr.id}, linked without recreating`);
        } else {
          await this.stores.operations.fail(op, "no PR found for task marker");
          notes.push("create_pr: no PR found, marked failed so it can be retried");
        }
      } else if (op.toolName === "publish_branch") {
        const head = await this.workspace.tryGit(["rev-parse", "HEAD"]);
        const dirty = await this.workspace.tryGit(["status", "--porcelain"]);
        if (head && !dirty?.trim()) {
          await this.stores.operations.complete(op, { branch: this.task.branch, commit: head, replayed: true });
          notes.push(`publish_branch: reconciled at ${head.slice(0, 12)}`);
        } else {
          await this.stores.operations.fail(op, dirty?.trim() ? "workspace still dirty; commit not confirmed" : "cannot read workspace HEAD");
          notes.push("publish_branch: not confirmed, marked failed for a clean retry");
        }
      } else if (op.toolName === "run_verification") {
        const latest = await this.stores.verifications.latest(this.task.id);
        if (latest) {
          await this.stores.operations.complete(op, { verificationId: latest.id });
          notes.push(`run_verification: reconciled with ${latest.id}`);
        } else {
          await this.stores.operations.fail(op, "no verification record");
        }
      } else {
        await this.stores.operations.markUnknown(op, "unrecognized pending operation");
        notes.push(`${op.toolName}: left unknown for human inspection`);
      }
    }

    // Evidence invalidation: a change after verification makes the package stale.
    await this.reload();
    const currentPatch = await this.currentPatchHash();
    const currentDiff = await this.workspace.diff();
    await this.update((draft) => {
      draft.patchHash = currentDiff.trim() ? currentPatch : undefined;
    });
    if (this.task.changePackage && this.task.changePackage.patchHash !== currentPatch) {
      await this.update((draft) => {
        draft.changePackage = undefined;
        if (["PACKAGE", "PUBLISH", "DONE"].includes(draft.stage)) {
          draft.stage = "VERIFY";
          draft.lifecycle = "RUNNING";
        }
        draft.state.nextAction = "re-verify: patch changed after the recorded verification";
      });
      notes.push("change package invalidated: patch fingerprint changed");
    }

    if (this.task.pr && this.task.stage === "PUBLISH") {
      await this.update((draft) => {
        draft.stage = "DONE";
        draft.lifecycle = "DELIVERED";
        draft.summary = `Reconciled existing PR ${draft.pr!.id}: ${draft.pr!.url}. Human review and merge remain required.`;
      });
      notes.push("PR exists; task reconciled to DONE/DELIVERED");
    }

    if (notes.length > 0) {
      await this.event("recovery", { notes });
    }
    return notes;
  }

  async finishDelivered(summary: string): Promise<Task> {
    return this.update((draft) => {
      draft.stage = "DONE";
      draft.lifecycle = "DELIVERED";
      draft.summary = summary;
      draft.state.nextAction = undefined;
      draft.budget.elapsedMs = Date.now() - draft.budget.startedAt;
    });
  }

  async markFailed(error: string): Promise<Task> {
    return this.update((draft) => {
      draft.lifecycle = "FAILED";
      draft.lastError = error;
      draft.state.nextAction = "human inspection";
    });
  }

  async markWaitingInput(question: string): Promise<Task> {
    return this.update((draft) => {
      draft.lifecycle = "WAITING_INPUT";
      draft.state.pendingQuestions.push(question);
      draft.state.nextAction = "waiting for user input";
    });
  }

  async listArtifactsForMessages(messages: Message[]): Promise<string[]> {
    const refs = new Set<string>();
    const pattern = /artifact[:\s]+([a-f0-9]{64})/gi;
    for (const message of messages) {
      const text = JSON.stringify(message);
      for (const match of text.matchAll(pattern)) refs.add(match[1]);
    }
    return [...refs];
  }

  async ensureDirFor(file: string): Promise<void> {
    await ensureDir(path.dirname(file));
  }
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) throw new Error("oldText must not be empty");
  let count = 0;
  let index = 0;
  while (true) {
    const found = content.indexOf(needle, index);
    if (found < 0) break;
    count += 1;
    index = found + Math.max(1, needle.length);
  }
  return count;
}
