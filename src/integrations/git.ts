import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { copyDirFiltered, ensureDir, exists, safeJoin } from "../utils/paths.js";
import { hashObject } from "../utils/text.js";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  command: string;
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs = 120_000,
  env: Record<string, string> = {},
): Promise<CommandResult> {
  const started = Date.now();
  const mergedEnv = { ...process.env, ...env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
  return new Promise<CommandResult>((resolve) => {
    const child = execFile(
      command,
      [],
      {
        cwd,
        shell: true,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: mergedEnv,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        const timedOut = Boolean(err?.killed) && /timed? ?out/i.test(String(err?.message ?? ""));
        resolve({
          command,
          exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          signal: err?.signal ?? null,
          timedOut,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          durationMs: Date.now() - started,
        });
      },
    );
    child.on("error", () => {
      // execFile callback handles errors; this keeps unhandled event noise out.
    });
  });
}

export class GitWorkspace {
  private baseRef?: string;

  constructor(public readonly path: string) {}

  setBase(ref: string): void {
    this.baseRef = ref;
  }

  private base(): string {
    return this.baseRef ?? "HEAD";
  }

  async git(args: string[], timeoutMs = 60_000): Promise<string> {
    const result = await this.gitRaw(args, timeoutMs);
    return result.trim();
  }

  /** Raw stdout is required for porcelain status, where leading spaces are significant. */
  async gitRaw(args: string[], timeoutMs = 60_000): Promise<string> {
    const result = await runShellCommand(`git ${args.map(quoteShell).join(" ")}`, this.path, timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
    }
    return result.stdout.replace(/\r\n/g, "\n");
  }

  async tryGit(args: string[]): Promise<string | undefined> {
    try {
      return await this.git(args);
    } catch {
      return undefined;
    }
  }

  async init(): Promise<void> {
    await this.tryGit(["init", "-q", "-b", "main"]);
    await this.tryGit(["config", "user.name", "ForgePilot"]);
    await this.tryGit(["config", "user.email", "forgepilot@local"]);
    await this.tryGit(["config", "commit.gpgsign", "false"]);
  }

  async head(): Promise<string> {
    return this.git(["rev-parse", "HEAD"]);
  }

  async diff(): Promise<string> {
    const tracked = await this.git(["diff", "--binary", this.base()]);
    const status = await this.gitRaw(["status", "--porcelain"]);
    if (!status.trim()) return tracked;
    const untracked = status
      .split(/\r?\n/)
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3).trim());
    const parts = [tracked];
    for (const file of untracked) {
      if (!file) continue;
      try {
        const content = await readFile(safeJoin(this.path, file), "utf8");
        parts.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n${content
          .split(/\r?\n/)
          .map((line) => `+${line}`)
          .join("\n")}\n`);
      } catch {
        // Binary or unreadable files are represented by name only.
        parts.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n`);
      }
    }
    return parts.join("\n").trim();
  }

  async diffStat(): Promise<string> {
    const tracked = await this.git(["diff", "--stat", this.base()]);
    const status = await this.gitRaw(["status", "--porcelain"]);
    return [tracked, status].filter(Boolean).join("\n").trim();
  }

  async changedFiles(): Promise<string[]> {
    const names = await this.git(["diff", "--name-only", this.base()]);
    const files = new Set(
      names
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const status = await this.gitRaw(["status", "--porcelain"]);
    for (const line of status.split(/\r?\n/)) {
      if (!line.startsWith("?? ")) continue;
      const file = line.slice(3).trim();
      if (file) files.add(file);
    }
    return [...files];
  }

  async patchHash(): Promise<string> {
    const diff = await this.diff();
    return hashObject({ diff });
  }

  async commitAll(message: string): Promise<string> {
    await this.git(["add", "-A"]);
    const status = await this.gitRaw(["status", "--porcelain"]);
    if (!status.trim()) throw new Error("No changes to commit");
    await this.git(["commit", "-q", "-m", quoteShell(message)]);
    return this.head();
  }

  async currentBranch(): Promise<string> {
    return this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  async hasCommit(commit: string): Promise<boolean> {
    const resolved = await this.tryGit(["cat-file", "-t", commit]);
    return resolved === "commit";
  }

  async ensureBranch(branch: string): Promise<void> {
    const current = await this.currentBranch();
    if (current !== branch) {
      await this.git(["checkout", "-q", "-B", branch]);
    }
  }
}

function quoteShell(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function prepareTemplateWorkspace(
  templatePath: string,
  destPath: string,
  taskId: string,
): Promise<{ workspace: GitWorkspace; baseCommit: string; branch: string }> {
  if (await exists(destPath)) {
    throw new Error(`Workspace already exists: ${destPath}`);
  }
  await ensureDir(destPath);
  await copyDirFiltered(templatePath, destPath, (relative) => {
    const normalized = relative.replaceAll("\\", "/");
    return (
      normalized === ".git" ||
      normalized.startsWith(".git/") ||
      normalized === "node_modules" ||
      normalized.startsWith("node_modules/") ||
      normalized === ".forgepilot" ||
      normalized.startsWith(".forgepilot/")
    );
  });
  const workspace = new GitWorkspace(destPath);
  await workspace.init();
  await workspace.git(["add", "-A"]);
  await workspace.git(["commit", "-q", "-m", `baseline for ${taskId}`]);
  const baseCommit = await workspace.head();
  workspace.setBase(baseCommit);
  const branch = `${sanitizeBranch(taskId)}/fix`;
  await workspace.ensureBranch(branch);
  return { workspace, baseCommit, branch };
}

export async function prepareExistingRepoWorktree(
  repoPath: string,
  destPath: string,
  baseCommit: string,
  branch: string,
): Promise<GitWorkspace> {
  const source = new GitWorkspace(path.resolve(repoPath));
  if (!(await source.hasCommit(baseCommit))) {
    throw new Error(`base_commit not found in repository: ${baseCommit}`);
  }
  await ensureDir(path.dirname(destPath));
  await source.git(["worktree", "add", "-q", "--detach", destPath, baseCommit]);
  const workspace = new GitWorkspace(destPath);
  workspace.setBase(baseCommit);
  await workspace.ensureBranch(branch);
  return workspace;
}

export async function envFingerprint(workspacePath: string): Promise<string> {
  const lockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "requirements.txt", "poetry.lock"];
  const hashes: Record<string, string> = {};
  for (const name of lockfiles) {
    try {
      hashes[name] = hashObject(await readFile(path.join(workspacePath, name), "utf8"));
    } catch {
      // absent lockfile
    }
  }
  return hashObject({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    lockfiles: hashes,
  });
}

export function sanitizeBranch(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9/_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "task";
}
