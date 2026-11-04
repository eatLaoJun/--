import { isEnvError } from "../../integrations/verification.js";
import { runShellCommand } from "../../integrations/git.js";
import type { SwebenchInstance, TestCaseResult, TestRunResult } from "./types.js";

export interface SwebenchVerifier {
  readonly name: string;
  verify(instance: SwebenchInstance, workspace: string): Promise<TestRunResult>;
}

/**
 * Local verifier: executes the instance's hidden test command and parses a JSON
 * result line. The real SWE-bench Docker harness can implement this interface
 * without changing the evaluation runner.
 */
export class LocalVerifier implements SwebenchVerifier {
  readonly name = "local-swebench-verifier";

  async verify(instance: SwebenchInstance, workspace: string): Promise<TestRunResult> {
    const result = await runShellCommand(instance.test_command, workspace, 180_000);
    const raw = `${result.stdout}\n${result.stderr}`;
    const parsed = parseResults(result.stdout) ?? parseResults(raw);
    return {
      exitCode: result.exitCode,
      results: parsed ?? [],
      rawOutput: raw,
      envError: isEnvError(result) || ((parsed?.length ?? 0) === 0 && result.exitCode !== 0 && /cannot find module/i.test(raw)),
    };
  }
}

function parseResults(stdout: string): TestCaseResult[] | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { results?: TestCaseResult[] };
      if (Array.isArray(parsed.results)) {
        return parsed.results.map((item) => ({
          name: String(item.name),
          passed: Boolean(item.passed),
          error: item.error ? String(item.error) : undefined,
        }));
      }
    } catch {
      // not the result line
    }
  }
  return undefined;
}

export function pickTests(all: TestCaseResult[], names: string[]): TestCaseResult[] {
  return names.map((name) => all.find((result) => result.name === name) ?? { name, passed: false, error: "missing test result" });
}
