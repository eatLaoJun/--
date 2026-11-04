export interface HiddenTestFile {
  path: string;
  source: string;
}

export interface SwebenchInstance {
  instance_id: string;
  repo_template: string;
  problem_statement: string;
  hidden_tests: HiddenTestFile[];
  test_command: string;
  fail_to_pass: string[];
  pass_to_pass: string[];
  commands: Record<string, string>;
  max_tokens: number;
  max_tool_calls: number;
  max_wall_clock_ms: number;
}

export type SwebenchArm = "baseline" | "enhanced";

export interface TestCaseResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface TestRunResult {
  exitCode: number;
  results: TestCaseResult[];
  rawOutput: string;
  envError: boolean;
}

export type FailureCategory =
  | "resolved"
  | "empty_patch"
  | "test_fail"
  | "p2p_regression"
  | "env_error"
  | "budget_exceeded"
  | "agent_error"
  | "harness_error";

export interface InstanceRunResult {
  instanceId: string;
  arm: SwebenchArm;
  resolved: boolean;
  failureCategory: FailureCategory;
  diffHash?: string;
  changedFiles: string[];
  patchArtifactId?: string;
  testResults: TestCaseResult[];
  failToPass: TestCaseResult[];
  passToPass: TestCaseResult[];
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  wallClockMs: number;
  tracePath: string;
  error?: string;
}

export interface ArmReport {
  arm: SwebenchArm;
  total: number;
  resolved: number;
  resolvedRate: number;
  averageInputTokens: number;
  averageOutputTokens: number;
  averageToolCalls: number;
  averageWallClockMs: number;
  failureTaxonomy: Record<string, number>;
  results: InstanceRunResult[];
}

export interface SwebenchReport {
  runId: string;
  modelName: string;
  dataset: string;
  instanceIds: string[];
  createdAt: string;
  arms: ArmReport[];
  notes: string[];
}

export interface AgentRunOutput {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  wallClockMs: number;
  finalText: string;
}

export interface AgentRunner {
  readonly name: string;
  run(input: {
    instance: SwebenchInstance;
    arm: SwebenchArm;
    runtime: import("../../harness/runtime.js").TaskRuntime;
  }): Promise<AgentRunOutput>;
}
