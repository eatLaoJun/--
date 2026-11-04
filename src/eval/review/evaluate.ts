import type {
  EvaluationMetrics,
  EvaluationResult,
  JudgeResult,
  LabelSet,
  LabeledDefect,
  MatchPair,
  ReviewFinding,
  ReviewRun,
  UnresolvedFinding,
} from "./types.js";
import type { Judge } from "./judge.js";
import { jaccard } from "../../utils/text.js";
import { overlapRatio } from "./judge.js";

interface Candidate {
  defect: LabeledDefect;
  score: number;
}

export async function evaluateReviewRun(
  run: ReviewRun,
  labels: LabelSet,
  judge: Judge,
): Promise<EvaluationResult> {
  const findings = deduplicateFindings(run.findings);
  const matchedDefects = new Map<string, MatchPair>();
  const matches: MatchPair[] = [];
  const falsePositives: UnresolvedFinding[] = [];
  const undecided: UnresolvedFinding[] = [];

  for (const finding of findings) {
    const candidates = candidatesFor(finding, labels.defects);
    let accepted: MatchPair | undefined;
    let unsure: { candidate: Candidate; result: JudgeResult } | undefined;

    for (const candidate of candidates) {
      if (matchedDefects.has(candidate.defect.id)) continue;
      const result = await judge.judge(finding, candidate.defect, candidate.score);
      if (result.verdict === "same") {
        accepted = {
          findingId: finding.id,
          defectId: candidate.defect.id,
          candidateScore: candidate.score,
          judge: result,
        };
        break;
      }
      if (result.verdict === "unsure" && !unsure) {
        unsure = { candidate, result };
      }
    }

    if (accepted) {
      matches.push(accepted);
      matchedDefects.set(accepted.defectId, accepted);
      continue;
    }
    if (unsure) {
      undecided.push({
        findingId: finding.id,
        reason: "judge requested arbitration: possible semantic match",
        candidateDefectId: unsure.candidate.defect.id,
        judge: unsure.result,
      });
      continue;
    }
    const sameLocationMatched = candidates.some((candidate) => matchedDefects.has(candidate.defect.id));
    if (sameLocationMatched) {
      undecided.push({
        findingId: finding.id,
        reason: "duplicate or additional issue at an already-matched location; needs arbitration",
      });
      continue;
    }
    falsePositives.push({
      findingId: finding.id,
      reason:
        candidates.length === 0
          ? "no labeled defect candidate at this file/range"
          : "all candidates judged as a different defect",
    });
  }

  const falseNegatives = labels.defects.filter((defect) => !matchedDefects.has(defect.id));
  const tp = matches.length;
  const fp = falsePositives.length;
  const fn = falseNegatives.length;
  const metrics: EvaluationMetrics = {
    tp,
    fp,
    fn,
    undecided: undecided.length,
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
    fpRatio: tp + fp > 0 ? fp / (tp + fp) : null,
    labeledDefects: labels.defects.length,
    findings: run.findings.length,
    deduplicatedFindings: findings.length,
  };

  return {
    runId: run.runId,
    strategy: run.strategy,
    model: run.model,
    labelVersion: labels.version,
    metrics,
    matches,
    falsePositives,
    falseNegatives,
    undecided,
    rootCauseSummary: {
      falsePositive: countBy(
        falsePositives.map((item) => findings.find((f) => f.id === item.findingId)?.rootCause ?? "uncategorized"),
      ),
      falseNegative: countBy(falseNegatives.map((defect) => defect.rootCause)),
      undecided: countBy(
        undecided.map(
          (item) =>
            findings.find((f) => f.id === item.findingId)?.rootCause ??
            labels.defects.find((d) => d.id === item.candidateDefectId)?.rootCause ??
            "uncategorized",
        ),
      ),
    },
    judgeName: judge.name,
    createdAt: new Date().toISOString(),
  };
}

export function deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (const finding of findings) {
    const duplicate = out.some(
      (existing) =>
        normalizeFile(existing.file) === normalizeFile(finding.file) &&
        overlapRatio(existing, finding) >= 0.5 &&
        jaccard(existing.message, finding.message) >= 0.55 &&
        (existing.rootCause ?? "") === (finding.rootCause ?? ""),
    );
    if (!duplicate) out.push(finding);
  }
  return out;
}

function candidatesFor(finding: ReviewFinding, defects: LabeledDefect[]): Candidate[] {
  const scored: Candidate[] = [];
  for (const defect of defects) {
    if (normalizeFile(finding.file) !== normalizeFile(defect.file)) continue;
    if (finding.side !== defect.side) continue;
    const overlap = overlapRatio(finding, defect);
    if (overlap <= 0) continue;
    const textScore = jaccard(finding.message, defect.description);
    const rootCauseBonus = finding.rootCause && finding.rootCause === defect.rootCause ? 0.3 : 0;
    scored.push({ defect, score: overlap * 0.5 + textScore * 0.2 + rootCauseBonus });
  }
  return scored.sort((a, b) => b.score - a.score);
}

function normalizeFile(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export function compareEvaluations(a: EvaluationResult, b: EvaluationResult): string {
  const delta = (x: number | null, y: number | null): string => {
    if (x === null || y === null) return "n/a";
    const diff = (y - x) * 100;
    return `${diff >= 0 ? "+" : ""}${diff.toFixed(1)}pp`;
  };
  return [
    "| metric | " + a.runId + " | " + b.runId + " | delta |",
    "| --- | --- | --- | --- |",
    `| Precision | ${fmt(a.metrics.precision)} | ${fmt(b.metrics.precision)} | ${delta(a.metrics.precision, b.metrics.precision)} |`,
    `| Recall | ${fmt(a.metrics.recall)} | ${fmt(b.metrics.recall)} | ${delta(a.metrics.recall, b.metrics.recall)} |`,
    `| TP | ${a.metrics.tp} | ${b.metrics.tp} | ${b.metrics.tp - a.metrics.tp} |`,
    `| FP | ${a.metrics.fp} | ${b.metrics.fp} | ${b.metrics.fp - a.metrics.fp} |`,
    `| FN | ${a.metrics.fn} | ${b.metrics.fn} | ${b.metrics.fn - a.metrics.fn} |`,
    `| Undecided | ${a.metrics.undecided} | ${b.metrics.undecided} | ${b.metrics.undecided - a.metrics.undecided} |`,
  ].join("\n");
}

export function formatReviewReport(result: EvaluationResult): string {
  const metricRows = [
    `- Label set: ${result.labelVersion}`,
    `- Judge: ${result.judgeName}`,
    `- Findings: ${result.metrics.findings} (deduplicated ${result.metrics.deduplicatedFindings})`,
    `- TP: ${result.metrics.tp}, FP: ${result.metrics.fp}, FN: ${result.metrics.fn}, Undecided: ${result.metrics.undecided}`,
    `- Precision: ${fmt(result.metrics.precision)}`,
    `- Recall: ${fmt(result.metrics.recall)}`,
    `- FP ratio: ${fmt(result.metrics.fpRatio)}`,
  ];
  return [
    `# Review evaluation: ${result.runId}`,
    "",
    `Strategy: ${result.strategy}`,
    "",
    "## Metrics",
    ...metricRows,
    "",
    "## Matches",
    ...result.matches.map(
      (m) => `- ${m.findingId} ↔ ${m.defectId} (candidate ${m.candidateScore.toFixed(2)}; ${m.judge.reason})`,
    ),
    "",
    "## False positives",
    ...(result.falsePositives.length
      ? result.falsePositives.map((fp) => `- ${fp.findingId}: ${fp.reason}`)
      : ["- none"]),
    "",
    "## False negatives",
    ...(result.falseNegatives.length
      ? result.falseNegatives.map((fn) => `- ${fn.id} (${fn.rootCause}): ${fn.description}`)
      : ["- none"]),
    "",
    "## Arbitration queue",
    ...(result.undecided.length
      ? result.undecided.map((item) => `- ${item.findingId}: ${item.reason}`)
      : ["- none"]),
    "",
    "## Root-cause attribution",
    `- FP: ${JSON.stringify(result.rootCauseSummary.falsePositive)}`,
    `- FN: ${JSON.stringify(result.rootCauseSummary.falseNegative)}`,
    `- Undecided: ${JSON.stringify(result.rootCauseSummary.undecided)}`,
  ].join("\n");
}

function fmt(value: number | null): string {
  return value === null ? "N/A" : value.toFixed(3);
}
