export interface ReviewFinding {
  id: string;
  file: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
  severity?: string;
  message: string;
  rootCause?: string;
}

export interface LabeledDefect {
  id: string;
  file: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
  description: string;
  rootCause: string;
  introducedByPr?: string;
  evidence?: string;
}

export interface ReviewRun {
  runId: string;
  strategy: string;
  model: string;
  createdAt: string;
  findings: ReviewFinding[];
}

export interface LabelSet {
  version: string;
  createdAt: string;
  defects: LabeledDefect[];
}

export interface JudgeResult {
  verdict: "same" | "different" | "unsure";
  confidence: number;
  reason: string;
  rootCause?: string;
  judge: string;
}

export interface MatchPair {
  findingId: string;
  defectId: string;
  candidateScore: number;
  judge: JudgeResult;
}

export interface UnresolvedFinding {
  findingId: string;
  reason: string;
  candidateDefectId?: string;
  judge?: JudgeResult;
}

export interface EvaluationMetrics {
  tp: number;
  fp: number;
  fn: number;
  undecided: number;
  precision: number | null;
  recall: number | null;
  fpRatio: number | null;
  labeledDefects: number;
  findings: number;
  deduplicatedFindings: number;
}

export interface EvaluationResult {
  runId: string;
  strategy: string;
  model: string;
  labelVersion: string;
  metrics: EvaluationMetrics;
  matches: MatchPair[];
  falsePositives: UnresolvedFinding[];
  falseNegatives: LabeledDefect[];
  undecided: UnresolvedFinding[];
  rootCauseSummary: {
    falsePositive: Record<string, number>;
    falseNegative: Record<string, number>;
    undecided: Record<string, number>;
  };
  judgeName: string;
  createdAt: string;
}
