import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { evaluateReviewRun, compareEvaluations } from "../src/eval/review/evaluate.js";
import { loadLabelSet, loadReviewRun } from "../src/eval/review/io.js";
import { HeuristicJudge } from "../src/eval/review/judge.js";

const projectRoot = process.cwd();

test("review evaluation produces one-to-one matches, FP/FN and arbitration", async () => {
  const run = await loadReviewRun(projectRoot, "fixtures/review/run-a.json");
  const labels = await loadLabelSet(projectRoot, "fixtures/review/labels-v1.json");
  const result = await evaluateReviewRun(run, labels, new HeuristicJudge());

  assert.equal(result.metrics.tp, 3);
  assert.equal(result.metrics.fp, 1);
  assert.equal(result.metrics.fn, 1);
  assert.equal(result.metrics.undecided, 1);
  assert.equal(result.metrics.precision, 0.75);
  assert.equal(result.metrics.recall, 0.75);
  assert.deepEqual(
    result.matches.map((match) => `${match.findingId}->${match.defectId}`).sort(),
    ["F1->D1", "F2->D2", "F4->D3"],
  );
  assert.equal(result.falsePositives[0].findingId, "F3");
  assert.equal(result.falseNegatives[0].id, "D4");
  assert.equal(result.undecided[0].findingId, "F5");
  assert.equal(result.rootCauseSummary.falseNegative.inverted_authorization, 1);
});

test("improved strategy shows precision/recall delta", async () => {
  const labels = await loadLabelSet(projectRoot, "fixtures/review/labels-v1.json");
  const a = await evaluateReviewRun(
    await loadReviewRun(projectRoot, "fixtures/review/run-a.json"),
    labels,
    new HeuristicJudge(),
  );
  const b = await evaluateReviewRun(
    await loadReviewRun(projectRoot, "fixtures/review/run-b.json"),
    labels,
    new HeuristicJudge(),
  );
  assert.equal(b.metrics.precision, 1);
  assert.equal(b.metrics.recall, 1);
  assert.equal(b.metrics.fp, 0);
  assert.equal(b.metrics.fn, 0);
  assert.match(compareEvaluations(a, b), /Recall/);
});
