import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { PatchChange } from "./schemas.js";
import {
  ApplyPatchSchema,
  CreatePrSchema,
  EmptySchema,
  PackageChangeSchema,
  ReadArtifactSchema,
  RecordEvidenceSchema,
  RecordHypothesisSchema,
  RunVerificationSchema,
  SearchCodebaseSchema,
} from "./schemas.js";
import type { TaskRuntime } from "../../harness/runtime.js";
import { isInside, safeJoin } from "../../utils/paths.js";
import { shortHash, truncate } from "../../utils/text.js";

const text = (value: string) => [{ type: "text" as const, text: value }];

export function createHarnessTools(runtime: TaskRuntime) {
  return [
    defineTool({
      name: "get_ticket",
      label: "Get Ticket",
      description: "Read the authorized ticket fields (title, description, expected behavior, constraints, commands).",
      parameters: EmptySchema,
      async execute() {
        const task = runtime.task;
        return {
          content: text(
            JSON.stringify(
              {
                ticketId: task.ticketId,
                projectId: task.projectId,
                title: task.title,
                description: task.description,
                expected: task.expected,
                baseCommit: task.baseCommit,
                commands: task.commands,
                constraints: task.constraints,
              },
              null,
              2,
            ),
          ),
          details: { ticketId: task.ticketId },
        };
      },
    }),

    defineTool({
      name: "run_verification",
      label: "Run Verification",
      description:
        "Run a trusted project command (repro/test/build) in the isolated workspace. " +
        "Only configured commands can run; the full log is stored as an artifact. " +
        "Use this to reproduce the defect or verify the current patch.",
      parameters: RunVerificationSchema,
      async execute(_toolCallId, params) {
        await runtime.checkBudget();
        const record = await runtime.runVerification(params.kind, params.note ?? "");
        return {
          content: text(
            [
              `kind: ${record.kind}`,
              `command: ${record.command}`,
              `exitCode: ${record.exitCode}${record.timedOut ? " (timed out)" : ""}${record.envError ? " (environment error)" : ""}`,
              `patchHash: ${record.patchHash}`,
              `fingerprint: ${record.fingerprint}`,
              `artifactId: ${record.artifactId}`,
              "key output:",
              record.keyOutput || "(no output)",
            ].join("\n"),
          ),
          details: record,
        };
      },
    }),

    defineTool({
      name: "apply_patch",
      label: "Apply Patch",
      description:
        "Apply a minimal, atomic patch using exact string replacement. Each oldText must be unique. " +
        "Tests and verification scripts are protected and cannot be modified. " +
        "Use read first and copy exact text; if it fails, re-read the file.",
      parameters: ApplyPatchSchema,
      async execute(_toolCallId, params) {
        await runtime.checkBudget();
        const result = await runtime.applyChanges(params.changes as PatchChange[], params.rationale);
        return {
          content: text(
            [
              `patchHash: ${result.patchHash}${result.replayed ? " (replayed)" : ""}`,
              `changed files: ${result.changedFiles.join(", ") || "(none)"}`,
              `artifactId: ${result.artifactId}`,
              "diff:",
              truncate(result.diff, 4000),
            ].join("\n"),
          ),
          details: {
            patchHash: result.patchHash,
            changedFiles: result.changedFiles,
            artifactId: result.artifactId,
            replayed: result.replayed,
          },
        };
      },
    }),

    defineTool({
      name: "record_hypothesis",
      label: "Record Hypothesis",
      description:
        "Record an unconfirmed root-cause hypothesis with concrete evidence references. " +
        "The harness keeps hypotheses separate from confirmed facts so summaries cannot turn guesses into facts.",
      parameters: RecordHypothesisSchema,
      async execute(_toolCallId, params) {
        const record = await runtime.recordHypothesis({
          text: params.hypothesis,
          evidence: params.evidence,
          confidence: params.confidence,
          status: "open",
        });
        return {
          content: text(`Recorded hypothesis ${record.id} (${record.confidence}, open).`),
          details: record,
        };
      },
    }),

    defineTool({
      name: "record_evidence",
      label: "Record Evidence",
      description: "Attach a factual claim to a concrete reference (file:line, test id/artifact id).",
      parameters: RecordEvidenceSchema,
      async execute(_toolCallId, params) {
        const record = await runtime.recordEvidence({
          claim: params.claim,
          kind: params.kind,
          reference: params.reference,
        });
        return {
          content: text(`Recorded evidence ${record.id}: ${record.claim} (${record.reference}).`),
          details: record,
        };
      },
    }),

    defineTool({
      name: "read_artifact",
      label: "Read Artifact",
      description:
        "Read a slice of a stored artifact (full test log, patch or offloaded tool output) by artifact id. " +
        "Use this instead of asking for the whole log to be repeated in context.",
      parameters: ReadArtifactSchema,
      async execute(_toolCallId, params) {
        const result = await runtime.stores.artifacts.getSlice(params.artifactId, params.offset ?? 0, params.limit ?? 8000);
        return {
          content: text(
            `artifact ${params.artifactId} (chars ${params.offset ?? 0}..${(params.offset ?? 0) + result.content.length} of ${result.totalChars}):\n\n${result.content}`,
          ),
          details: { artifactId: params.artifactId, totalChars: result.totalChars },
        };
      },
    }),

    defineTool({
      name: "package_change",
      label: "Package Change",
      description:
        "Build a reviewer-facing change package from the current diff plus a matching successful test verification. " +
        "Fails if the verification fingerprint is stale or missing.",
      parameters: PackageChangeSchema,
      async execute(_toolCallId, params) {
        const pkg = await runtime.packageChange(params.rationale);
        return {
          content: text(
            [
              `change package ready: ${pkg.diffStat}`,
              `patchHash: ${pkg.patchHash}`,
              `verification: ${pkg.verificationId}`,
              `changed files: ${pkg.changedFiles.join(", ")}`,
              "Awaiting human approval.",
            ].join("\n"),
          ),
          details: pkg,
        };
      },
    }),

    defineTool({
      name: "publish_branch",
      label: "Publish Branch",
      description:
        "Commit the approved change on the task branch. Idempotent by task + patch fingerprint; " +
        "returns the existing commit if the operation already succeeded.",
      parameters: EmptySchema,
      async execute() {
        const result = await runtime.publishBranch();
        return {
          content: text(`branch ${result.branch} @ ${result.commit}${result.replayed ? " (replayed)" : ""}`),
          details: result,
        };
      },
    }),

    defineTool({
      name: "create_pr",
      label: "Create PR",
      description:
        "Create or reconcile the PR for the task. If a PR for this task/branch already exists, it is returned " +
        "instead of creating a duplicate. A lost response is reconciled by querying the external record.",
      parameters: CreatePrSchema,
      async execute(_toolCallId, params) {
        const result = await runtime.createPr();
        return {
          content: text(
            `${result.pr.id} ${result.pr.url}\nbranch: ${result.pr.branch}\nhead: ${result.pr.headCommit}` +
              `${result.replayed ? "\n(reconciled existing PR)" : ""}`,
          ),
          details: result,
        };
      },
    }),

    defineTool({
      name: "get_pr_status",
      label: "Get PR Status",
      description: "Query the external PR record by task marker or PR id.",
      parameters: Type.Object({ prId: Type.Optional(Type.String()) }),
      async execute(_toolCallId, params) {
        const pr = params.prId
          ? await runtime.stores.pr.get(params.prId)
          : await runtime.stores.pr.findByTask(runtime.task.id);
        return {
          content: text(pr ? JSON.stringify(pr, null, 2) : "No PR found for this task."),
          details: pr ?? {},
        };
      },
    }),

    defineTool({
      name: "get_task_status",
      label: "Get Task Status",
      description: "Read the task's stage, lifecycle, budget and evidence status.",
      parameters: EmptySchema,
      async execute() {
        const task = await runtime.reload();
        return {
          content: text(
            JSON.stringify(
              {
                id: task.id,
                stage: task.stage,
                lifecycle: task.lifecycle,
                version: task.version,
                cancelRequested: task.cancelRequested,
                baseCommit: task.baseCommit,
                patchHash: task.changePackage?.patchHash ?? "clean",
                budget: {
                  tokens: `${task.budget.tokensUsed}/${task.budget.maxTokens}`,
                  toolCalls: `${task.budget.toolCallsUsed}/${task.budget.maxToolCalls}`,
                  repairIterations: `${task.budget.repairIterations}/${task.budget.maxRepairIterations}`,
                },
                pendingQuestions: task.state.pendingQuestions,
                pr: task.pr,
              },
              null,
              2,
            ),
          ),
          details: { stage: task.stage, lifecycle: task.lifecycle },
        };
      },
    }),

    defineTool({
      name: "request_input",
      label: "Request Input",
      description:
        "Stop the current stage and ask the human for missing information. Use only when the ticket is ambiguous " +
        "or required access/evidence cannot be obtained with the available tools.",
      parameters: Type.Object({ question: Type.String() }),
      async execute(_toolCallId, params) {
        await runtime.markWaitingInput(params.question);
        return {
          content: text(`Waiting for human input: ${params.question}`),
          details: { question: params.question },
        };
      },
    }),

    defineTool({
      name: "search_codebase",
      label: "Search Codebase",
      description:
        "Function/class-level code retrieval. Returns the most relevant code chunks with file and line ranges. " +
        "This is the retrieval-enhanced arm; it does not reveal hidden tests or reference patches.",
      parameters: SearchCodebaseSchema,
      async execute(_toolCallId, params) {
        const results = await searchCodebase(runtime.workspace.path, params.query, params.limit ?? 5);
        return {
          content: text(
            results
              .map(
                (r) =>
                  `### ${r.file}:${r.startLine}-${r.endLine} (${r.name}, score ${r.score.toFixed(2)})\n` +
                  "```\n" +
                  truncate(r.code, 2400) +
                  "\n```",
              )
              .join("\n\n") || "No matching code chunks.",
          ),
          details: { results: results.map(({ code: _code, ...rest }) => rest) },
        };
      },
    }),
  ];
}

interface CodeChunk {
  file: string;
  name: string;
  startLine: number;
  endLine: number;
  code: string;
}

interface ScoredChunk extends CodeChunk {
  score: number;
}

const indexCache = new Map<string, { at: number; chunks: CodeChunk[] }>();

async function searchCodebase(workspace: string, query: string, limit: number): Promise<ScoredChunk[]> {
  const chunks = await getIndex(workspace);
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/gu)
    .filter((term) => term.length > 1);
  if (terms.length === 0) return [];
  const scored = chunks.map((chunk) => {
    const haystack = `${chunk.name}\n${chunk.code}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (chunk.name.toLowerCase().includes(term)) score += 4;
      const occurrences = haystack.split(term).length - 1;
      score += Math.min(occurrences, 6);
    }
    if (chunk.name.toLowerCase() === query.toLowerCase()) score += 10;
    return { ...chunk, score };
  });
  return scored
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

async function getIndex(workspace: string): Promise<CodeChunk[]> {
  const cached = indexCache.get(workspace);
  if (cached && Date.now() - cached.at < 5_000) return cached.chunks;
  const chunks: CodeChunk[] = [];
  const files = await walk(workspace, workspace);
  for (const file of files) {
    try {
      const info = await stat(file);
      if (info.size > 300_000) continue;
      const content = await readFile(file, "utf8");
      chunks.push(...extractChunks(workspace, file, content));
    } catch {
      // unreadable file
    }
  }
  indexCache.set(workspace, { at: Date.now(), chunks });
  return chunks;
}

async function walk(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if ([".git", "node_modules", ".forgepilot", "dist", "coverage", ".eval"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (!isInside(root, full)) continue;
    if (entry.isDirectory()) out.push(...(await walk(root, full)));
    else if (entry.isFile() && /\.(m?[jt]sx?|cjs|py)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function extractChunks(root: string, file: string, content: string): CodeChunk[] {
  const lines = content.split(/\r?\n/);
  const defs: Array<{ line: number; name: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const patterns: RegExp[] = [
      /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
      /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
      /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
      /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/,
    ];
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        defs.push({ line: i, name: match[1] });
        break;
      }
    }
  }
  const relative = path.relative(root, file).replaceAll("\\", "/");
  return defs.map((def, index) => {
    const next = defs[index + 1]?.line ?? lines.length;
    const end = Math.min(next, def.line + 80, lines.length);
    return {
      file: relative,
      name: def.name,
      startLine: def.line + 1,
      endLine: end,
      code: lines.slice(def.line, end).join("\n"),
      score: 0,
    };
  });
}
