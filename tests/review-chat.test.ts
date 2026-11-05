import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ForgePilotHarness } from "../src/harness/orchestrator.js";
import { buildReviewPrompt, buildReviewSystemPrompt } from "../src/review/prompt.js";
import { ReviewChatStore } from "../src/store/review-chat-store.js";
import type { VerificationRecord } from "../src/domain/types.js";

const projectRoot = process.cwd();

test("review chat store appends and lists messages per task", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-chat-"));
  try {
    const store = new ReviewChatStore(dir);
    await store.append({ taskId: "T1", role: "engineer", content: "why?" });
    await store.append({ taskId: "T1", role: "assistant", content: "because..." });
    await store.append({ taskId: "T2", role: "engineer", content: "other" });
    const messages = await store.list("T1");
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "engineer");
    assert.equal(messages[1].content, "because...");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review prompt carries diff, verification, history and unresolved feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-chat-prompt-"));
  try {
    const harness = new ForgePilotHarness({ root: path.join(dir, "state"), projectRoot, autoApprove: false });
    const { task } = await harness.createTaskFromTicket("fixtures/tickets/T-1001.json");
    const verification: VerificationRecord = {
      id: "V-1",
      taskId: task.id,
      kind: "test",
      command: "node --test tests/pagination.test.js",
      exitCode: 0,
      timedOut: false,
      envError: false,
      durationMs: 100,
      patchHash: "patch-1",
      baseCommit: task.baseCommit ?? "",
      envFingerprint: "env-1",
      fingerprint: "fp-1",
      artifactId: "a".repeat(64),
      keyOutput: "# fail 0",
      at: Date.now(),
    };
    const prompt = buildReviewPrompt({
      task: {
        ...task,
        patchHash: "patch-1",
        feedback: [
          {
            id: "F1",
            message: "请解释边界条件",
            priorPatchHash: "patch-1",
            requestedAt: Date.now(),
          },
        ],
      },
      history: [
        { id: "R1", taskId: task.id, role: "engineer", content: "为什么这样改？", at: Date.now() },
        { id: "R2", taskId: task.id, role: "assistant", content: "因为整除分支多算一页。", at: Date.now() },
      ],
      question: "非整除会受影响吗？",
      diff: "+ return Math.ceil(total / pageSize);",
      verification,
    });
    assert.match(prompt, /proposed_diff/);
    assert.match(prompt, /Math\.ceil/);
    assert.match(prompt, /# fail 0/);
    assert.match(prompt, /请解释边界条件/);
    assert.match(prompt, /非整除会受影响吗/);
    assert.match(prompt, /为什么这样改/);
    const timelinePrompt = buildReviewPrompt({
      task,
      history: [],
      question: "这个任务经历了哪些阶段？",
      diff: "+ return Math.ceil(total / pageSize);",
      verification,
      verifications: [verification],
      events: [
        { at: Date.now(), taskId: task.id, type: "incident_ingested", stage: "INGEST", detail: { service: "course-platform" } },
        { at: Date.now(), taskId: task.id, type: "repository_resolved", stage: "RESOLVE", detail: { repoName: "demo-course-service", baseCommit: "abc", branch: "fix" } },
        { at: Date.now(), taskId: task.id, type: "plan_recorded", stage: "PLAN", detail: { artifactId: "a".repeat(64), filesToChange: ["src/pagination.js"] } },
      ],
      stage: undefined,
    });
    assert.match(timelinePrompt, /<task_timeline>/);
    assert.match(timelinePrompt, /repository_resolved/);
    assert.match(timelinePrompt, /demo-course-service/);
    assert.match(timelinePrompt, /<verification_records>/);
    assert.match(buildReviewSystemPrompt(task), /Read-only/);
    assert.match(buildReviewSystemPrompt(task), /要求修改/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("request-changes re-enters REPAIR and blocks approval until resolved", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-chat-changes-"));
  try {
    const harness = new ForgePilotHarness({ root: path.join(dir, "state"), projectRoot, autoApprove: false });
    const { task } = await harness.createTaskFromTicket("fixtures/tickets/T-1001.json");
    await harness.stores.tasks.update(task.id, (draft) => {
      draft.stage = "PACKAGE";
      draft.lifecycle = "WAITING_APPROVAL";
      draft.patchHash = "patch-1";
      draft.changePackage = {
        patchArtifactId: "a".repeat(64),
        patchHash: "patch-1",
        diffStat: "1 file changed",
        changedFiles: ["src/pagination.js"],
        rationale: "initial fix",
        verificationId: "V-1",
        verificationFingerprint: "fp-1",
        riskNotes: [],
        createdAt: Date.now(),
      };
    });
    const updated = await harness.requestChanges(task.id, "请更新注释并重新验证", { start: false });
    assert.equal(updated.stage, "REPAIR");
    assert.equal(updated.lifecycle, "RUNNING");
    assert.equal(updated.changePackage, undefined);
    assert.equal(updated.feedback?.length, 1);
    assert.equal(updated.feedback?.[0].resolvedAt, undefined);
    assert.equal((await harness.reviewHistory(task.id)).length, 1);
    await assert.rejects(() => harness.approve(task.id), /No change package|Cannot approve/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review-chat usage is tracked but does not consume the repair budget", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-chat-budget-"));
  try {
    const harness = new ForgePilotHarness({ root: path.join(dir, "state"), projectRoot, autoApprove: false });
    const { task } = await harness.createTaskFromTicket("fixtures/tickets/T-1001.json");
    const runtime = new (await import("../src/harness/runtime.js")).TaskRuntime({
      stores: harness.stores,
      task,
      workspace: new (await import("../src/integrations/git.js")).GitWorkspace(task.workspacePath!),
    });
    const before = runtime.task.budget.tokensUsed;
    await runtime.addUsage({ input: 1000, output: 500, cacheRead: 0 }, { countAgainstBudget: false });
    const after = await runtime.reload();
    assert.equal(after.budget.tokensUsed, before);
    assert.equal(after.metrics.inputTokens, 1000);
    assert.equal(after.metrics.outputTokens, 500);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
