import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { Stage, Task, TaskState } from "../domain/types.js";
import type { ArtifactStore } from "../store/artifact-store.js";
import { estimateTokens, hashObject, oneLine, truncate } from "../utils/text.js";

export interface ContextMetrics {
  taskId: string;
  stage: Stage;
  beforeTokens: number;
  afterTokens: number;
  stateTokens: number;
  digestTokens: number;
  recentTokens: number;
  droppedMessages: number;
  summarizedMessages: number;
  offloadedToolOutputs: number;
  preservedToolPairs: number;
  constraintHash: string;
  artifactRefs: string[];
  at: number;
}

export interface AssembledContext {
  messages: Message[];
  metrics: ContextMetrics;
}

const STATE_MARKER = "<forgepilot_state";
const DIGEST_MARKER = "<forgepilot_history_digest";
const MAX_STATE_TOKENS = 6000;
const MAX_DIGEST_TOKENS = 5000;
const OFFLOAD_CHARS = 3000;
const OFFLOAD_PREVIEW = 900;

/**
 * Layered context assembly. This runs inside the extension `context` hook before
 * every LLM call, so it only changes the request, never the persisted session.
 *
 * Order: fixed constraints + structured state -> older digest -> recent complete
 * interaction. Tool call/result pairs are never split. Full tool output is stored
 * as a content-addressed artifact and referenced by id.
 */
export class ContextAssembler {
  constructor(private readonly artifacts: ArtifactStore) {}

  async assemble(input: {
    task: Task;
    state: TaskState;
    stage: Stage;
    messages: AgentMessage[];
    budgetTokens: number;
  }): Promise<AssembledContext> {
    const original = input.messages.filter(isStandardMessage);
    const beforeTokens = original.reduce((sum, m) => sum + messageTokens(m), 0);

    const cleaned = original.filter((m) => !isInjectedBlock(m));
    let stateText = renderStateBlock(input.task, input.state, input.stage);
    const stateBudget = Math.min(Math.max(1200, Math.floor(input.budgetTokens * 0.25)), MAX_STATE_TOKENS);
    if (estimateTokens(stateText) > stateBudget) stateText = clipByTokens(stateText, stateBudget);
    const stateTokens = estimateTokens(stateText);

    const digestBudget = Math.min(Math.max(800, Math.floor(input.budgetTokens * 0.2)), MAX_DIGEST_TOKENS);
    const recentBudget = Math.max(1200, input.budgetTokens - Math.min(stateTokens, stateBudget) - digestBudget);

    const { start, recentTokens } = findRecentWindow(cleaned, recentBudget);
    const older = cleaned.slice(0, start);
    const recentRaw = cleaned.slice(start);

    let offloadedToolOutputs = 0;
    const artifactRefs = new Set<string>();

    const recent: Message[] = [];
    for (const message of recentRaw) {
      if (message.role === "toolResult") {
        const processed = await this.maybeOffload(message, input.task.id);
        if (processed.artifactId) {
          artifactRefs.add(processed.artifactId);
          offloadedToolOutputs += 1;
        }
        recent.push(processed.message);
      } else {
        recent.push(message);
      }
    }

    let digest = await renderDigest(older, input.task.id, artifactRefs, this.artifacts);
    let digestText = clipByTokens(digest, digestBudget);
    let digestTokens = estimateTokens(digestText);

    let assembled: Message[] = [
      userMessage(stateText),
      ...(digestText ? [userMessage(`${DIGEST_MARKER}>\n${digestText}\n</forgepilot_history_digest>`)] : []),
      ...recent,
    ];

    let total = assembled.reduce((sum, m) => sum + messageTokens(m), 0);
    let droppedMessages = 0;

    // First reduce the digest, then move the recent boundary forward. Never cut
    // inside a tool call/result relationship.
    while (total > input.budgetTokens && digestText.length > 0) {
      const lines = digestText.split("\n");
      if (lines.length <= 4) break;
      digestText = clipByTokens(lines.slice(0, Math.ceil(lines.length / 2)).join("\n"), Math.max(200, digestTokens / 2));
      digestTokens = estimateTokens(digestText);
      assembled = [
        userMessage(stateText),
        ...(digestText ? [userMessage(`${DIGEST_MARKER}>\n${digestText}\n</forgepilot_history_digest>`)] : []),
        ...recent,
      ];
      total = assembled.reduce((sum, m) => sum + messageTokens(m), 0);
    }

    while (total > input.budgetTokens && recent.length > 2) {
      let remove = 1;
      while (remove < recent.length && recent[remove]?.role === "toolResult") remove += 1;
      if (recent[remove]?.role === "toolResult") break;
      recent.splice(0, remove);
      droppedMessages += remove;
      total = assembled.reduce((sum, m) => sum + messageTokens(m), 0);
      assembled = [
        userMessage(stateText),
        ...(digestText ? [userMessage(`${DIGEST_MARKER}>\n${digestText}\n</forgepilot_history_digest>`)] : []),
        ...recent,
      ];
      total = assembled.reduce((sum, m) => sum + messageTokens(m), 0);
    }

    // Last-resort: keep only the tail text of the largest tool results.
    if (total > input.budgetTokens) {
      for (let i = assembled.length - 1; i >= 0 && total > input.budgetTokens; i -= 1) {
        const message = assembled[i];
        if (message.role !== "toolResult") continue;
        const compact = compactToolResult(message);
        total -= messageTokens(message) - messageTokens(compact);
        assembled[i] = compact;
      }
    }

    assembled = sanitizeToolPairs(assembled);
    const afterTokens = assembled.reduce((sum, m) => sum + messageTokens(m), 0);

    return {
      messages: assembled,
      metrics: {
        taskId: input.task.id,
        stage: input.stage,
        beforeTokens,
        afterTokens,
        stateTokens,
        digestTokens,
        recentTokens,
        droppedMessages,
        summarizedMessages: older.length,
        offloadedToolOutputs,
        preservedToolPairs: countPreservedPairs(assembled),
        constraintHash: hashObject({
          expected: input.task.expected,
          constraints: input.task.constraints,
          baseCommit: input.task.baseCommit,
        }),
        artifactRefs: [...artifactRefs],
        at: Date.now(),
      },
    };
  }

  private async maybeOffload(
    message: ToolResultMessage,
    taskId: string,
  ): Promise<{ message: ToolResultMessage; artifactId?: string }> {
    const text = textOf(message);
    if (text.length <= OFFLOAD_CHARS) return { message };
    const meta = await this.artifacts.put(text, {
      taskId,
      kind: `tool_output:${message.toolName}`,
      name: `${message.toolName}-${message.toolCallId}`,
    });
    const toolCallId = message.toolCallId;
    return {
      artifactId: meta.id,
      message: {
        ...message,
        content: [
          {
            type: "text",
            text:
              `[full output offloaded to artifact ${meta.id} (${meta.bytes} bytes); ` +
              `use read_artifact to inspect it]\n` +
              truncate(text, OFFLOAD_PREVIEW),
          },
        ],
      } satisfies ToolResultMessage,
    };
  }
}

function isStandardMessage(message: AgentMessage): message is Message {
  return (
    message &&
    typeof message === "object" &&
    ["user", "assistant", "toolResult", "system"].includes((message as { role?: string }).role ?? "")
  );
}

function isInjectedBlock(message: Message): boolean {
  if (message.role !== "user") return false;
  const text = textOf(message);
  return text.startsWith(STATE_MARKER) || text.startsWith(DIGEST_MARKER);
}

function userMessage(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function textOf(message: Message): string {
  if (message.role === "user" || message.role === "system") {
    return typeof message.content === "string"
      ? message.content
      : message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  }
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

function messageTokens(message: Message): number {
  if (message.role === "assistant") {
    return (
      12 +
      message.content.reduce((sum, block) => {
        if (block.type === "text") return sum + estimateTokens(block.text);
        if (block.type === "thinking") return sum + estimateTokens(block.thinking);
        return sum + estimateTokens(JSON.stringify(block.arguments ?? {})) + 8;
      }, 0)
    );
  }
  return 10 + estimateTokens(textOf(message));
}

function findRecentWindow(messages: Message[], budget: number): { start: number; recentTokens: number } {
  let tokens = 0;
  let start = messages.length;
  while (start > 0) {
    const next = messageTokens(messages[start - 1]);
    if (tokens + next > budget && start < messages.length) break;
    tokens += next;
    start -= 1;
  }
  // Do not start on a tool result: walk back to its assistant tool call.
  while (start > 0 && messages[start]?.role === "toolResult") start -= 1;
  return { start, recentTokens: tokens };
}

async function renderDigest(
  messages: Message[],
  taskId: string,
  artifactRefs: Set<string>,
  artifacts: ArtifactStore,
): Promise<string> {
  const lines: string[] = [];
  let previous = "";
  for (const message of messages) {
    let line = "";
    if (message.role === "user") {
      line = `USER: ${oneLine(textOf(message), 220)}`;
    } else if (message.role === "assistant") {
      const parts: string[] = [];
      for (const block of message.content) {
        if (block.type === "text") parts.push(oneLine(block.text, 180));
        if (block.type === "toolCall") {
          parts.push(`called ${block.name}(${oneLine(JSON.stringify(block.arguments), 180)})`);
        }
      }
      line = `ASSISTANT: ${parts.join(" | ")}`;
    } else if (message.role === "toolResult") {
      const text = textOf(message);
      line = `TOOL_RESULT ${message.toolName} [${message.isError ? "error" : "ok"}]: ${oneLine(text, 220)}`;
      if (text.length > OFFLOAD_CHARS) {
        const meta = await artifacts.put(text, {
          taskId,
          kind: `history_tool_output:${message.toolName}`,
          name: `${message.toolName}-${message.toolCallId}`,
        });
        artifactRefs.add(meta.id);
        line += ` [artifact:${meta.id}]`;
      }
    }
    if (!line || line === previous) continue;
    lines.push(line);
    previous = line;
  }
  return lines.join("\n");
}

function clipByTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const lines = text.split("\n");
  if (lines.length <= 2) return truncate(text, Math.max(200, maxTokens * 3));
  const keepHead = Math.max(2, Math.floor(lines.length * 0.25));
  const keepTail = Math.max(2, Math.floor(lines.length * 0.55));
  return [...lines.slice(0, keepHead), "...", ...lines.slice(-keepTail)].join("\n");
}

function compactToolResult(message: ToolResultMessage): ToolResultMessage {
  const text = textOf(message);
  return {
    ...message,
    content: [{ type: "text", text: truncate(text, OFFLOAD_PREVIEW) }],
  };
}

function sanitizeToolPairs(messages: Message[]): Message[] {
  const callIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") callIds.add(block.id);
    }
  }
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === "toolResult" && !callIds.has(message.toolCallId)) continue;
    if (out.length === 0 && message.role === "toolResult") continue;
    out.push(message);
  }
  return out;
}

function countPreservedPairs(messages: Message[]): number {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
    } else if (message.role === "toolResult") {
      results.add(message.toolCallId);
    }
  }
  let count = 0;
  for (const id of results) if (calls.has(id)) count += 1;
  return count;
}

export function renderStateBlock(task: Task, state: TaskState, stage: Stage): string {
  const facts = state.confirmedFacts.slice(-12).map((f) => `- [${f.kind}] ${f.claim} (ref: ${f.reference})`);
  const hypotheses = state.hypotheses
    .slice(-8)
    .map((h) => `- (${h.status}/${h.confidence}) ${h.text}${h.evidence.length ? ` [evidence: ${h.evidence.join(", ")}]` : ""}`);
  const attempts = state.attempts.slice(-8).map((a) => `- ${a.action}: ${a.result} — ${oneLine(a.detail, 200)}`);
  const remaining = task.budget.maxTokens - task.budget.tokensUsed;
  return [
    `<forgepilot_state stage="${stage}" lifecycle="${task.lifecycle}" version="${task.version}">`,
    `TASK: ${task.title}`,
    `GOAL: ${task.description}`,
    `EXPECTED: ${task.expected}`,
    `BASE_COMMIT: ${task.baseCommit ?? "unset"}`,
    `BRANCH: ${task.branch}`,
    `PATCH_HASH: ${task.patchHash ?? "clean"}`,
    `REMAINING_BUDGET: ${Math.max(0, remaining)} tokens, ${Math.max(0, task.budget.maxToolCalls - task.budget.toolCallsUsed)} tool calls`,
    "",
    "CONSTRAINTS (immutable):",
    ...(task.constraints.notes.length ? task.constraints.notes.map((n) => `- ${n}`) : ["- none"]),
    `- protected paths: ${task.constraints.protectedPaths.join(", ") || "(none)"}`,
    `- acceptance: ${task.constraints.acceptance.join("; ") || "(none)"}`,
    "",
    "CONFIRMED FACTS (must carry a tool/artifact reference):",
    ...(facts.length ? facts : ["- none yet"]),
    "",
    "HYPOTHESES (unconfirmed unless stated):",
    ...(hypotheses.length ? hypotheses : ["- none yet"]),
    "",
    "RECENT ATTEMPTS:",
    ...(attempts.length ? attempts : ["- none yet"]),
    "",
    "RULES: Never invent tool output. Never modify tests/protected paths. " +
      "A fact without a reference is a hypothesis. Do not claim VERIFY passed unless the current patch fingerprint matches.",
    "</forgepilot_state>",
  ].join("\n");
}

export function contextUsageRatio(tokens: number, contextWindow: number): number {
  return contextWindow > 0 ? tokens / contextWindow : 0;
}

export function resolveBudgetTokens(contextWindow: number, maxOutputTokens: number, reserve = 4096): number {
  return Math.max(2048, contextWindow - maxOutputTokens - reserve);
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

export function fileLineReference(file: string, startLine: number, endLine?: number): string {
  return `${file.replaceAll("\\", "/")}:${startLine}${endLine && endLine !== startLine ? `-${endLine}` : ""}`;
}

export function artifactReference(id: string): string {
  return `artifact:${id}`;
}

export function normalizeArtifactPath(id: string): string {
  return path.posix.normalize(id);
}
