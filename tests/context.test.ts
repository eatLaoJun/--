import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { ArtifactStore } from "../src/store/artifact-store.js";
import { ContextAssembler } from "../src/context/assembler.js";
import type { Task, TaskState } from "../src/domain/types.js";
import { createBudget, initialMetrics } from "../src/domain/types.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function assistantCall(id: string, name: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: { path: "src/pagination.js" } }],
    api: "test",
    provider: "test",
    model: "test",
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function toolResult(id: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function makeTask(workspace: string): Task {
  const now = Date.now();
  return {
    id: "T-CTX",
    ticketId: "T-1",
    projectId: "test",
    title: "pagination bug",
    description: "exact multiple adds an empty page",
    expected: "total=40,pageSize=20 -> 2 pages",
    repoName: "repo",
    workspacePath: workspace,
    baseCommit: "abc123",
    branch: "T-CTX/fix",
    stage: "REPAIR",
    lifecycle: "RUNNING",
    version: 1,
    cancelRequested: false,
    createdAt: now,
    updatedAt: now,
    budget: createBudget(),
    constraints: {
      protectedPaths: ["tests/**"],
      allowedPaths: ["**"],
      notes: ["Only change src/"],
      acceptance: ["totalPages(40,20) === 2"],
    },
    commands: { test: "node --test" },
    state: { confirmedFacts: [], hypotheses: [], attempts: [], pendingQuestions: [] },
    faults: [],
    faultsFired: [],
    metrics: initialMetrics(),
  };
}

test("layered context preserves constraints and tool pairs while offloading logs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-ctx-"));
  try {
    const store = new ArtifactStore(dir);
    const assembler = new ContextAssembler(store);
    const task = makeTask(dir);
    const state: TaskState = {
      confirmedFacts: [
        { id: "E1", claim: "baseline test fails", kind: "test", reference: "V-1", at: Date.now() },
      ],
      hypotheses: [
        { id: "H1", text: "floor+1 adds an extra page", evidence: ["src/pagination.js:15"], confidence: "high", status: "open", at: Date.now() },
      ],
      attempts: [],
      pendingQuestions: [],
    };
    const bigLog = "FAIL src/pagination.js:15 expected 2 actual 3\n" + "stack line\n".repeat(4000);
    const messages: Message[] = [
      user("fix the ticket"),
      assistantCall("c1", "read"),
      toolResult("c1", bigLog),
      assistantText("The bug is in totalPages."),
      assistantCall("c2", "run_verification"),
      toolResult("c2", "exit 1\n" + "error detail\n".repeat(2000)),
      assistantText("I will patch the formula."),
    ];

    const assembled = await assembler.assemble({
      task,
      state,
      stage: "REPAIR",
      messages,
      budgetTokens: 4500,
    });

    assert.ok(assembled.metrics.afterTokens < assembled.metrics.beforeTokens);
    assert.ok(assembled.metrics.summarizedMessages > 0);
    assert.ok(assembled.metrics.artifactRefs.length > 0 || assembled.metrics.offloadedToolOutputs > 0);
    const stateBlock = assembled.messages.find(
      (message) => message.role === "user" && String(message.content).startsWith("<forgepilot_state"),
    );
    assert.ok(stateBlock, "structured state block must be present");
    assert.match(String(stateBlock!.content), /total=40,pageSize=20 -> 2 pages/);
    assert.match(String(stateBlock!.content), /Only change src\//);
    assert.doesNotMatch(String(stateBlock!.content), /before any null check/, "hypotheses must not become facts");

    const callIds = new Set<string>();
    for (const message of assembled.messages) {
      if (message.role === "assistant") {
        for (const block of message.content) if (block.type === "toolCall") callIds.add(block.id);
      }
    }
    for (const message of assembled.messages) {
      if (message.role === "toolResult") assert.ok(callIds.has(message.toolCallId), "orphan tool result");
    }

    const again = await assembler.assemble({
      task,
      state,
      stage: "REPAIR",
      messages: assembled.messages,
      budgetTokens: 4500,
    });
    const stateBlocks = again.messages.filter(
      (message) => message.role === "user" && String(message.content).startsWith("<forgepilot_state"),
    );
    assert.equal(stateBlocks.length, 1, "state block must not duplicate across calls");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact slices can be re-read on demand", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-art-"));
  try {
    const store = new ArtifactStore(dir);
    const meta = await store.put("abcdefghij", { taskId: "T", kind: "test", name: "log" });
    const slice = await store.getSlice(meta.id, 2, 4);
    assert.equal(slice.content, "cdef");
    assert.equal(slice.totalChars, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
