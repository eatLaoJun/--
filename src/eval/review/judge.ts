import type { Message } from "@earendil-works/pi-ai";
import type { JudgeResult, LabeledDefect, ReviewFinding } from "./types.js";
import { jaccard, extractJsonObject } from "../../utils/text.js";
import type { ModelContext } from "../../agent/session.js";

export interface Judge {
  readonly name: string;
  judge(finding: ReviewFinding, defect: LabeledDefect, candidateScore: number): Promise<JudgeResult>;
}

export function overlapRatio(a: ReviewFinding | LabeledDefect, b: ReviewFinding | LabeledDefect): number {
  const start = Math.max(a.startLine, b.startLine);
  const end = Math.min(a.endLine, b.endLine);
  if (end >= start) {
    const overlap = end - start + 1;
    const union = Math.max(a.endLine, b.endLine) - Math.min(a.startLine, b.startLine) + 1;
    return union > 0 ? overlap / union : 0;
  }
  const distance = start - end;
  return distance <= 3 ? 0.15 : 0;
}

export class HeuristicJudge implements Judge {
  readonly name = "heuristic-judge-v1";

  async judge(finding: ReviewFinding, defect: LabeledDefect, candidateScore: number): Promise<JudgeResult> {
    const textScore = jaccard(finding.message, defect.description);
    const overlap = overlapRatio(finding, defect);
    const rootCauseMatch = finding.rootCause && finding.rootCause === defect.rootCause;
    const score =
      textScore * 0.45 +
      overlap * 0.25 +
      (rootCauseMatch ? 0.25 : 0) +
      (finding.file.replaceAll("\\", "/") === defect.file.replaceAll("\\", "/") ? 0.05 : 0);
    const confidence = Math.max(0, Math.min(1, score));
    let verdict: JudgeResult["verdict"] = "different";
    if (confidence >= 0.45) verdict = "same";
    else if (confidence >= 0.28) verdict = "unsure";
    return {
      verdict,
      confidence,
      reason:
        `heuristic: textJaccard=${textScore.toFixed(2)}, intervalOverlap=${overlap.toFixed(2)}, ` +
        `rootCauseMatch=${Boolean(rootCauseMatch)}, candidateScore=${candidateScore.toFixed(2)}`,
      rootCause: finding.rootCause ?? defect.rootCause,
      judge: this.name,
    };
  }
}

export class LlmJudge implements Judge {
  readonly name: string;

  constructor(private readonly models: ModelContext) {
    this.name = `llm-judge:${models.name}`;
  }

  async judge(finding: ReviewFinding, defect: LabeledDefect, candidateScore: number): Promise<JudgeResult> {
    if (!this.models.model) {
      const fallback = await new HeuristicJudge().judge(finding, defect, candidateScore);
      return { ...fallback, reason: `no model available; ${fallback.reason}` };
    }
    const prompt = [
      "You are an independent review-quality judge. Decide whether two review findings describe the SAME underlying defect.",
      "Use code behavior, trigger condition and root cause. File/line overlap is only a candidate hint; do not accept it as semantic proof.",
      "A generic suggestion ('add tests', 'consider refactoring') is NOT the same as a specific defect.",
      "A different root cause at the same location is NOT the same defect.",
      "",
      "<review_finding>",
      `id: ${finding.id}`,
      `file: ${finding.file}:${finding.startLine}-${finding.endLine} (${finding.side})`,
      `rootCause: ${finding.rootCause ?? "unknown"}`,
      `message: ${finding.message}`,
      "</review_finding>",
      "",
      "<labeled_defect>",
      `id: ${defect.id}`,
      `file: ${defect.file}:${defect.startLine}-${defect.endLine} (${defect.side})`,
      `rootCause: ${defect.rootCause}`,
      `description: ${defect.description}`,
      "</labeled_defect>",
      "",
      "Return ONLY JSON:",
      '{"verdict":"same|different|unsure","confidence":0.0,"reason":"short evidence-based reason","rootCause":"category"}',
    ].join("\n");

    try {
      const messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
      const response = await this.models.runtime.complete(
        this.models.model,
        { systemPrompt: "You are a strict offline evaluator. Return JSON only.", messages },
        { temperature: 0, maxTokens: 500 },
      );
      const text = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const parsed = extractJsonObject(text) as {
        verdict?: string;
        confidence?: number;
        reason?: string;
        rootCause?: string;
      };
      const verdict =
        parsed.verdict === "same" || parsed.verdict === "different" || parsed.verdict === "unsure"
          ? parsed.verdict
          : "unsure";
      return {
        verdict,
        confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
        reason: parsed.reason ?? "judge returned no reason",
        rootCause: parsed.rootCause,
        judge: this.name,
      };
    } catch (err) {
      const fallback = await new HeuristicJudge().judge(finding, defect, candidateScore);
      return {
        ...fallback,
        judge: `${this.name}+fallback`,
        reason: `judge call failed (${(err as Error).message}); ${fallback.reason}`,
      };
    }
  }
}

export async function createJudge(kind: "heuristic" | "llm", models?: ModelContext): Promise<Judge> {
  if (kind === "heuristic") return new HeuristicJudge();
  if (!models) throw new Error("LLM judge requires a model context");
  return new LlmJudge(models);
}
