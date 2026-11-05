export interface TaskSummary {
  id: string;
  ticketId: string;
  title: string;
  stage: string;
  lifecycle: string;
  issueUrl?: string;
  patchHash?: string;
  changedFiles: string[];
  pr?: { id: string; url: string; branch: string; headCommit: string; status: string };
  updatedAt: number;
  running: boolean;
}

export interface VerificationRecord {
  id: string;
  taskId: string;
  kind: string;
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

export interface ReviewMessage {
  id: string;
  taskId: string;
  role: "engineer" | "assistant" | "system";
  content: string;
  at: number;
  meta?: {
    model?: string;
    patchHash?: string;
    thinkingChars?: number;
    tools?: Array<{ toolCallId: string; toolName: string; isError: boolean; durationMs?: number; summary: string }>;
  };
}

export interface Task {
  id: string;
  ticketId: string;
  projectId: string;
  title: string;
  description: string;
  expected: string;
  repoName: string;
  issueUrl?: string;
  issueNumber?: number;
  baseCommit?: string;
  branch: string;
  stage: string;
  lifecycle: string;
  patchHash?: string;
  budget: {
    maxTokens: number;
    maxToolCalls: number;
    maxWallClockMs: number;
    maxRepairIterations: number;
    tokensUsed: number;
    toolCallsUsed: number;
    repairIterations: number;
  };
  metrics: { inputTokens: number; outputTokens: number; toolCalls: number; llmCalls: number };
  changePackage?: {
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
  };
  pr?: { id: string; url: string; branch: string; headCommit: string; status: string };
  feedback?: Array<{ id: string; message: string; requestedAt: number; resolvedAt?: number; priorPatchHash?: string }>;
  summary?: string;
  lastError?: string;
  workspacePath?: string;
}

export interface EventItem {
  at: number;
  taskId: string;
  type: string;
  stage?: string;
  detail?: Record<string, unknown>;
}

export interface TaskDetail {
  task: Task;
  chat: ReviewMessage[];
  verifications: VerificationRecord[];
  events: EventItem[];
  diff: string;
  running: boolean;
  reviewTools: string[];
}

export interface IssueFixture {
  file: string;
  number?: number;
  title: string;
  url?: string;
  labels?: string[];
}
