export const STAGES = [
  "PREPARE",
  "REPRODUCE",
  "REPAIR",
  "VERIFY",
  "PACKAGE",
  "PUBLISH",
  "DONE",
] as const;

export type Stage = (typeof STAGES)[number];

export const LIFECYCLES = [
  "QUEUED",
  "RUNNING",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
  "PAUSED",
  "CANCELLING",
  "CANCELLED",
  "FAILED",
  "DELIVERED",
] as const;

export type Lifecycle = (typeof LIFECYCLES)[number];

export interface Budget {
  maxTokens: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  maxRepairIterations: number;
  maxNetworkRetries: number;
  maxEnvRetries: number;
  tokensUsed: number;
  toolCallsUsed: number;
  repairIterations: number;
  networkRetries: number;
  envRetries: number;
  startedAt: number;
  elapsedMs: number;
}

export interface TaskConstraints {
  protectedPaths: string[];
  allowedPaths: string[];
  notes: string[];
  acceptance: string[];
}

export interface EvidenceRef {
  id: string;
  claim: string;
  kind: "file" | "test" | "command" | "artifact" | "note";
  reference: string;
  at: number;
}

export interface Hypothesis {
  id: string;
  text: string;
  evidence: string[];
  confidence: "low" | "medium" | "high";
  status: "open" | "confirmed" | "rejected";
  at: number;
}

export interface HumanFeedback {
  id: string;
  message: string;
  priorPatchHash?: string;
  requestedAt: number;
  resolvedAt?: number;
}

export interface Attempt {
  id: string;
  action: string;
  result: "success" | "failure" | "unknown";
  detail: string;
  at: number;
}

export interface TaskState {
  confirmedFacts: EvidenceRef[];
  hypotheses: Hypothesis[];
  attempts: Attempt[];
  pendingQuestions: string[];
  nextAction?: string;
}

export interface VerificationRecord {
  id: string;
  taskId: string;
  kind: "repro" | "test" | "build" | "swebench";
  command: string;
  exitCode: number;
  timedOut: boolean;
  envError: boolean;
  durationMs: number;
  patchHash: string;
  baseCommit: string;
  envFingerprint: string;
  fingerprint: string;
  artifactId: string;
  keyOutput: string;
  at: number;
}

export interface ChangePackage {
  patchArtifactId: string;
  patchHash: string;
  diffStat: string;
  changedFiles: string[];
  rationale: string;
  verificationId: string;
  verificationFingerprint: string;
  riskNotes: string[];
  createdAt: number;
  approvedAt?: number;
}

export interface PrRecord {
  id: string;
  url: string;
  taskId: string;
  repo: string;
  branch: string;
  base: string;
  headCommit: string;
  title: string;
  body: string;
  status: "open" | "merged" | "closed";
  createdAt: number;
}

export interface Lease {
  owner: string;
  epoch: number;
  expiresAt: number;
}

export interface TaskMetrics {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  toolCalls: number;
  wallClockMs: number;
}

export interface Task {
  id: string;
  ticketId: string;
  projectId: string;
  title: string;
  description: string;
  expected: string;
  repoName: string;
  templatePath?: string;
  repoPath?: string;
  workspacePath?: string;
  baseCommit?: string;
  /** Latest content hash of the workspace diff relative to base_commit. */
  patchHash?: string;
  branch: string;
  /** Optional source metadata for an issue-driven task. */
  issueUrl?: string;
  issueNumber?: number;
  stage: Stage;
  lifecycle: Lifecycle;
  version: number;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  budget: Budget;
  constraints: TaskConstraints;
  commands: Record<string, string>;
  state: TaskState;
  feedback?: HumanFeedback[];
  changePackage?: ChangePackage;
  pr?: PrRecord;
  lease?: Lease;
  /** Monotonic lease epoch; retained across release so a stale executor is detectable. */
  leaseEpoch?: number;
  faults: string[];
  faultsFired: string[];
  lastError?: string;
  summary?: string;
  metrics: TaskMetrics;
}

export interface Ticket {
  ticketId: string;
  projectId: string;
  title: string;
  description: string;
  expected: string;
  repoName: string;
  repoTemplate?: string;
  issueUrl?: string;
  issueNumber?: number;
  commands: Record<string, string>;
  constraints?: Partial<TaskConstraints>;
  budget?: Partial<Budget>;
}

export interface HarnessConfig {
  root: string;
  projectRoot: string;
  autoApprove: boolean;
  model?: string;
  maxNudges?: number;
  fault?: string;
  quiet?: boolean;
}

export function createBudget(overrides: Partial<Budget> = {}): Budget {
  return {
    maxTokens: 180_000,
    maxToolCalls: 80,
    maxWallClockMs: 20 * 60_000,
    maxRepairIterations: 3,
    maxNetworkRetries: 2,
    maxEnvRetries: 1,
    tokensUsed: 0,
    toolCallsUsed: 0,
    repairIterations: 0,
    networkRetries: 0,
    envRetries: 0,
    startedAt: Date.now(),
    elapsedMs: 0,
    ...overrides,
  };
}

export function emptyState(): TaskState {
  return {
    confirmedFacts: [],
    hypotheses: [],
    attempts: [],
    pendingQuestions: [],
  };
}

export function isTerminalLifecycle(lifecycle: Lifecycle): boolean {
  return ["CANCELLED", "FAILED", "DELIVERED"].includes(lifecycle);
}

export function initialMetrics(): TaskMetrics {
  return {
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    toolCalls: 0,
    wallClockMs: 0,
  };
}
