import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStores } from "../src/harness/stores.js";
import type { Task } from "../src/domain/types.js";
import { createBudget, initialMetrics } from "../src/domain/types.js";
import { LeaseHeldError } from "../src/store/lease.js";
import { semanticOperationKey } from "../src/store/operation-store.js";
import { appendJsonl } from "../src/utils/paths.js";
import type { PrRecord } from "../src/domain/types.js";

function makeTask(id: string): Task {
  const now = Date.now();
  return {
    id,
    ticketId: `T-${id}`,
    projectId: "test",
    title: "test task",
    description: "fix a bug",
    expected: "tests pass",
    repoName: "repo",
    workspacePath: path.join(tmpdir(), "missing-workspace"),
    baseCommit: "abc123",
    branch: `${id}/fix`,
    stage: "PREPARE",
    lifecycle: "QUEUED",
    version: 1,
    cancelRequested: false,
    createdAt: now,
    updatedAt: now,
    budget: createBudget(),
    constraints: { protectedPaths: ["tests/**"], allowedPaths: ["**"], notes: [], acceptance: [] },
    commands: { test: "node --version" },
    state: { confirmedFacts: [], hypotheses: [], attempts: [], pendingQuestions: [] },
    faults: [],
    faultsFired: [],
    metrics: initialMetrics(),
  };
}

test("task store enforces compare-and-swap and lease ownership", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-store-"));
  try {
    const stores = createStores(dir);
    const task = await stores.tasks.create(makeTask("T1"));
    assert.equal((await stores.tasks.get("T1"))?.version, 1);

    const saved = await stores.tasks.save({ ...task, title: "changed" }, 1);
    assert.equal(saved.version, 2);
    await assert.rejects(() => stores.tasks.save({ ...task, title: "stale" }, 1), /version conflict/i);

    const lease = await stores.leases.acquire("T1", "owner-a", 10_000);
    assert.equal(lease.epoch, 1);
    await assert.rejects(() => stores.leases.acquire("T1", "owner-b", 10_000), LeaseHeldError);
    await stores.leases.release("T1", lease);
    const takeover = await stores.leases.acquire("T1", "owner-b", 10_000);
    assert.equal(takeover.epoch, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("semantic operation replay does not execute twice", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-op-"));
  try {
    const stores = createStores(dir);
    await stores.tasks.create(makeTask("T2"));
    const opKey = semanticOperationKey({
      taskId: "T2",
      opType: "create_pr",
      target: "branch",
      inputHash: "patch-1",
      version: "base-1",
    });
    const first = await stores.operations.begin({
      taskId: "T2",
      opKey,
      toolName: "create_pr",
      inputHash: "patch-1",
    });
    assert.equal(first.replay, false);
    await stores.operations.complete(first.record, { prId: "PR-1" });
    const replay = await stores.operations.begin({
      taskId: "T2",
      opKey,
      toolName: "create_pr",
      inputHash: "patch-1",
    });
    assert.equal(replay.replay, true);
    assert.deepEqual(replay.record.result, { prId: "PR-1" });

    await assert.rejects(
      () =>
        stores.operations.begin({
          taskId: "T2",
          opKey,
          toolName: "create_pr",
          inputHash: "different-input",
        }),
      /different input/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PR adapter reconciles by task marker without creating a duplicate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-pr-"));
  try {
    const stores = createStores(dir);
    const record: PrRecord = {
      id: "PR-X",
      url: "local://pr/PR-X",
      taskId: "T3",
      repo: "repo",
      branch: "T3/fix",
      base: "main",
      headCommit: "deadbeef",
      title: "fix",
      body: "[forgepilot:task:T3]",
      status: "open",
      createdAt: Date.now(),
    };
    await appendJsonl(path.join(dir, "prs", "prs.jsonl"), record);
    const second = await stores.pr.create({
      taskId: "T3",
      repo: "repo",
      branch: "T3/fix",
      base: "main",
      headCommit: "deadbeef",
      title: "fix",
      body: "retry",
    });
    assert.equal(second.id, "PR-X");
    assert.equal((await stores.pr.list()).filter((pr) => pr.taskId === "T3").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
