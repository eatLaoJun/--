import { Type } from "typebox";

export interface PatchChange {
  path: string;
  oldText: string;
  newText: string;
}

export const PatchChangeSchema = Type.Object({
  path: Type.String({ description: "Workspace-relative file path, e.g. src/pagination.js" }),
  oldText: Type.String({ description: "Exact existing text to replace; must be unique in the file" }),
  newText: Type.String({ description: "Replacement text" }),
});

export const ApplyPatchSchema = Type.Object({
  changes: Type.Array(PatchChangeSchema, { minItems: 1, maxItems: 12 }),
  rationale: Type.String({ description: "Why this minimal change fixes the reported defect" }),
});

export const RunVerificationSchema = Type.Object({
  kind: Type.Union([Type.Literal("repro"), Type.Literal("test"), Type.Literal("build")], {
    description: "Which trusted project command to run",
  }),
  note: Type.Optional(Type.String({ description: "Short context for the evidence record" })),
});

export const RecordHypothesisSchema = Type.Object({
  hypothesis: Type.String({ description: "Proposed root cause, explicitly marked as unconfirmed" }),
  evidence: Type.Array(Type.String(), { description: "File:line, test output or artifact references" }),
  confidence: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
});

export const RecordEvidenceSchema = Type.Object({
  claim: Type.String({ description: "A factual claim about code, tests or external state" }),
  kind: Type.Union([
    Type.Literal("file"),
    Type.Literal("test"),
    Type.Literal("command"),
    Type.Literal("artifact"),
    Type.Literal("note"),
  ]),
  reference: Type.String({ description: "Concrete reference, e.g. src/pagination.js:3 or V-123" }),
});

export const ReadArtifactSchema = Type.Object({
  artifactId: Type.String({ description: "Content-addressed artifact id" }),
  offset: Type.Optional(Type.Number({ minimum: 0 })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20000 })),
});

export const RecordPlanSchema = Type.Object({
  rootCauseHypotheses: Type.Array(Type.String(), { description: "Candidate root causes, each with a file:line reference" }),
  approach: Type.String({ description: "Chosen minimal approach" }),
  alternatives: Type.Array(Type.String(), { description: "Alternatives considered and why rejected" }),
  filesToChange: Type.Array(Type.String(), { description: "Expected files to change" }),
  testPlan: Type.Array(Type.String(), { description: "Verification/reproduction plan" }),
  risks: Type.Array(Type.String(), { description: "Residual risks and edge cases" }),
  evidence: Type.Array(Type.String(), { description: "file:line or tool-result references" }),
});

export const PackageChangeSchema = Type.Object({
  rationale: Type.String({ description: "Reviewer-facing explanation of the fix and evidence" }),
});

export const CreatePrSchema = Type.Object({
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
});

export const SearchCodebaseSchema = Type.Object({
  query: Type.String({ description: "Symbol, function name or behavior to retrieve" }),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 12 })),
});

export const EmptySchema = Type.Object({});
