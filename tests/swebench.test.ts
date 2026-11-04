import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSwebenchEvaluation } from "../src/eval/swebench/run.js";
import { ScriptedAgentRunner } from "../src/eval/swebench/agent-runner.js";

const projectRoot = process.cwd();

test("swebench harness applies hidden tests only after the patch and scores both arms", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-swe-"));
  try {
    const runner = new ScriptedAgentRunner(async ({ runtime }) => {
      await runtime.applyChanges(
        [
          {
            path: "src/pagination.js",
            oldText: "return Math.floor(total / pageSize) + 1;",
            newText: "return Math.ceil(total / pageSize);",
          },
        ],
        "ceil fixes exact multiples",
      );
      await runtime.recordHypothesis({
        text: "floor+1 adds an extra page for exact multiples",
        evidence: ["src/pagination.js:15"],
        confidence: "high",
        status: "open",
      });
    });

    const result = await runSwebenchEvaluation({
      projectRoot,
      evalRoot: path.join(dir, "swebench"),
      instancesFile: "fixtures/swebench/instances.jsonl",
      arms: ["baseline", "enhanced"],
      limit: 1,
      agentRunner: runner,
    });

    assert.equal(result.report.arms.length, 2);
    for (const arm of result.report.arms) {
      assert.equal(arm.total, 1);
      assert.equal(arm.resolved, 1, `${arm.arm} should resolve the fixture`);
      assert.equal(arm.results[0].failureCategory, "resolved");
      assert.ok(arm.results[0].diffHash);
      assert.ok(arm.results[0].patchArtifactId);
      assert.ok(arm.results[0].failToPass.every((test) => test.passed));
      assert.ok(arm.results[0].passToPass.every((test) => test.passed));
    }
    assert.match(result.markdownPath, /swe-.*\.md$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("swebench harness records empty patches instead of counting them as resolved", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-swe-empty-"));
  try {
    const result = await runSwebenchEvaluation({
      projectRoot,
      evalRoot: path.join(dir, "swebench"),
      instancesFile: "fixtures/swebench/instances.jsonl",
      arms: ["baseline"],
      limit: 1,
      agentRunner: new ScriptedAgentRunner(async () => undefined),
    });
    assert.equal(result.report.arms[0].resolved, 0);
    assert.equal(result.report.arms[0].results[0].failureCategory, "empty_patch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
