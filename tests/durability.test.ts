import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStores } from "../src/harness/stores.js";
import { TaskRuntime, StaleLeaseError } from "../src/harness/runtime.js";
import { prepareTemplateWorkspace } from "../src/integrations/git.js";
import type { Task } from "../src/domain/types.js";
import { createBudget, initialMetrics } from "../src/domain/types.js";

const projectRoot = process.cwd();

async function makeRuntime(root: string, faults: string[] = []) {
  const taskId = `T-DUR-${Math.random().toString(16).slice(2, 8)}`;
  const prepared = await prepareTemplateWorkspace(
    path.join(projectRoot, "fixtures/demo-repo"),
    path.join(root, "workspaces", taskId),
    taskId,
  );
  const stores = createStores(root);
  const now = Date.now();
  const task: Task = {
    id: taskId,
    ticketId: "T-DUR",
    projectId: "test",
    title: "pagination bug",
    description: "fix pagination",
    expected: "40/20 -> 2",
    repoName: "demo-course-service",
    workspacePath: prepared.workspace.path,
    baseCommit: prepared.baseCommit,
    branch: prepared.branch,
    stage: "REPAIR",
    lifecycle: "RUNNING",
    version: 1,
    cancelRequested: false,
    createdAt: now,
    updatedAt: now,
    budget: createBudget({ maxTokens: 100_000, maxToolCalls: 20 }),
    constraints: { protectedPaths: ["tests/**", "scripts/**"], allowedPaths: ["**"], notes: [], acceptance: [] },
    commands: { test: "node --test tests/pagination.test.js" },
    state: { confirmedFacts: [], hypotheses: [], attempts: [], pendingQuestions: [] },
    faults,
    faultsFired: [],
    metrics: initialMetrics(),
  };
  await stores.tasks.create(task);
  return { stores, task, workspace: prepared.workspace, runtime: new TaskRuntime({ stores, task, workspace: prepared.workspace }) };
}

test("crash after patch write recovers from workspace diff without re-applying", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-dur-patch-"));
  try {
    const { stores, task, workspace, runtime } = await makeRuntime(dir, ["afterPatch"]);
    const changes = [
      {
        path: "src/pagination.js",
        oldText: "return Math.floor(total / pageSize) + 1;",
        newText: "return Math.ceil(total / pageSize);",
      },
    ];
    const first = await runtime.applyChanges(changes, "use ceil");
    assert.equal(first.replayed, false);
    const pending = await stores.operations.list(task.id);
    assert.equal(pending.length, 1);
    assert.notEqual(pending[0].status, "done", "operation must remain in-flight after the simulated crash");

    const recovered = new TaskRuntime({ stores, task: (await stores.tasks.get(task.id))!, workspace });
    const notes = await recovered.recover();
    assert.ok(notes.some((note) => note.includes("reconciled")), notes.join("\n"));
    const done = await stores.operations.list(task.id);
    assert.equal(done[0].status, "done");

    const replay = await recovered.applyChanges(changes, "use ceil");
    assert.equal(replay.replayed, true);
    const content = await readFile(path.join(workspace.path, "src/pagination.js"), "utf8");
    assert.match(content, /Math\.ceil\(total \/ pageSize\)/);
    assert.equal((content.match(/Math\.ceil/g) ?? []).length, 1, "patch must not be applied twice");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lost PR response is reconciled by querying the external record, with no duplicate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-dur-pr-"));
  try {
    const { stores, task, workspace, runtime } = await makeRuntime(dir, ["afterPrCreate"]);
    const patch = await runtime.applyChanges(
      [
        {
          path: "src/pagination.js",
          oldText: "return Math.floor(total / pageSize) + 1;",
          newText: "return Math.ceil(total / pageSize);",
        },
      ],
      "ceil fix",
    );
    await runtime.update((draft) => {
      draft.changePackage = {
        patchArtifactId: patch.artifactId,
        patchHash: patch.patchHash,
        diffStat: patch.diffStat,
        changedFiles: patch.changedFiles,
        rationale: "test",
        verificationId: "V-test",
        verificationFingerprint: "f".repeat(64),
        riskNotes: [],
        createdAt: Date.now(),
        approvedAt: Date.now(),
      };
    });
    await runtime.publishBranch();
    const created = await runtime.createPr();
    assert.ok(created.pr.id);
    const pending = (await stores.operations.list(task.id)).find((op) => op.toolName === "create_pr");
    assert.equal(pending?.status, "unknown");

    const recovered = new TaskRuntime({ stores, task: (await stores.tasks.get(task.id))!, workspace });
    const notes = await recovered.recover();
    assert.ok(notes.some((note) => note.includes("linked without recreating")), notes.join("\n"));
    assert.equal(await stores.pr.list().then((prs) => prs.filter((pr) => pr.taskId === task.id).length), 1);

    const again = await recovered.createPr();
    assert.equal(again.replayed, true);
    assert.equal(await stores.pr.list().then((prs) => prs.filter((pr) => pr.taskId === task.id).length), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale executor cannot write after another lease epoch takes over", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-dur-lease-"));
  try {
    const { stores, task, workspace } = await makeRuntime(dir);
    const lease = await stores.leases.acquire(task.id, "executor-a", 30_000);
    const runtime = new TaskRuntime({
      stores,
      task: (await stores.tasks.get(task.id))!,
      workspace,
      lease,
    });
    await runtime.update((draft) => {
      draft.state.nextAction = "still owner";
    });
    await stores.tasks.update(task.id, (draft) => {
      draft.lease = { owner: "executor-b", epoch: lease.epoch + 1, expiresAt: Date.now() + 30_000 };
      draft.leaseEpoch = lease.epoch + 1;
    });
    await assert.rejects(
      () => runtime.update((draft) => {
        draft.state.nextAction = "stale write";
      }),
      StaleLeaseError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale verification invalidates the change package after an edit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-dur-verify-"));
  try {
    const { stores, task, runtime } = await makeRuntime(dir);
    await stores.tasks.update(task.id, (draft) => {
      draft.stage = "PACKAGE";
      draft.lifecycle = "WAITING_APPROVAL";
      draft.changePackage = {
        patchArtifactId: "a".repeat(64),
        patchHash: "stale-patch-hash",
        diffStat: "1 file changed",
        changedFiles: ["src/pagination.js"],
        rationale: "stale",
        verificationId: "V-stale",
        verificationFingerprint: "f".repeat(64),
        riskNotes: [],
        createdAt: Date.now(),
      };
    });
    const notes = await runtime.recover();
    assert.ok(notes.some((note) => note.includes("invalidated")), notes.join("\n"));
    const after = await stores.tasks.get(task.id);
    assert.equal(after?.changePackage, undefined);
    assert.equal(after?.stage, "VERIFY");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
