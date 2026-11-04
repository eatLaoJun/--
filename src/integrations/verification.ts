import { hashObject, lastLines, truncate } from "../utils/text.js";
import { runShellCommand, envFingerprint, type CommandResult } from "./git.js";

export interface VerificationExecution {
  command: string;
  result: CommandResult;
  envError: boolean;
  keyOutput: string;
  fingerprint: string;
  envFingerprint: string;
  patchHash: string;
  baseCommit: string;
}

export function isEnvError(result: CommandResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.timedOut) return false;
  if (result.exitCode === 127 || result.exitCode === 126) return true;
  if (/ENOENT|not recognized as an internal or external command|command not found/i.test(text)) return true;
  if (/Cannot find module|MODULE_NOT_FOUND|No such file or directory.*node_modules/i.test(text)) return true;
  return false;
}

export function keyOutputLines(stdout: string, stderr: string, maxLines = 60): string {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const important = lines.filter((line) =>
    /(fail|error|assert|expected|actual|exception|traceback|not ok|✗|×)/i.test(line),
  );
  const selected = important.length > 0 ? important.slice(-maxLines) : lastLines(lines.join("\n"), maxLines);
  return truncate(selected.join("\n"), 6000);
}

export async function executeVerification(input: {
  taskId: string;
  kind: string;
  command: string;
  workspacePath: string;
  baseCommit: string;
  patchHash: string;
  timeoutMs?: number;
}): Promise<VerificationExecution> {
  const result = await runShellCommand(input.command, input.workspacePath, input.timeoutMs ?? 120_000);
  const env = await envFingerprint(input.workspacePath);
  const envError = isEnvError(result);
  const fingerprint = hashObject({
    taskId: input.taskId,
    kind: input.kind,
    command: input.command,
    baseCommit: input.baseCommit,
    patchHash: input.patchHash,
    envFingerprint: env,
    result: { exitCode: result.exitCode, envError },
  });
  return {
    command: input.command,
    result,
    envError,
    keyOutput: keyOutputLines(result.stdout, result.stderr),
    fingerprint,
    envFingerprint: env,
    patchHash: input.patchHash,
    baseCommit: input.baseCommit,
  };
}
