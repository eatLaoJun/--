import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { Stage, Task } from "../domain/types.js";
import { TaskRuntime, CancelledError } from "../harness/runtime.js";
import { ContextAssembler, type ContextMetrics } from "../context/assembler.js";
import { buildSystemPrompt } from "./prompt.js";
import { createHarnessExtension } from "./extension.js";
import { createHarnessTools } from "./tools/index.js";
import { oneLine } from "../utils/text.js";
import type { AgentStreamEvent } from "./ui-events.js";
import { fromAssistantStreamEvent, fromToolEndEvent, fromToolStartEvent, fromToolUpdateEvent } from "./ui-events.js";

export interface ModelContext {
  runtime: ModelRuntime;
  model?: Model<Api>;
  name: string;
}

export async function createModelContext(spec?: string): Promise<ModelContext> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const available = await runtime.getAvailable();
  if (available.length === 0) {
    return { runtime, name: "(no model)" };
  }
  if (spec) {
    const slash = spec.indexOf("/");
    const provider = slash > 0 ? spec.slice(0, slash) : undefined;
    const id = slash > 0 ? spec.slice(slash + 1) : spec;
    const model = available.find(
      (candidate) => candidate.id === id && (!provider || candidate.provider === provider),
    );
    if (!model) {
      throw new Error(
        `Model ${spec} is not available. Available: ${available.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
      );
    }
    return { runtime, model, name: `${model.provider}/${model.id}` };
  }
  const preferred =
    available.find((m) => m.provider === "dsh" && m.id === "deepseek-v4.1-flash") ??
    available.find((m) => m.provider === "dsh") ??
    available[0];
  return { runtime, model: preferred, name: `${preferred.provider}/${preferred.id}` };
}

export interface PiStageRunOptions {
  runtime: TaskRuntime;
  stage: Stage;
  prompt: string;
  allowedTools: string[];
  assembler: ContextAssembler;
  models: ModelContext;
  systemPromptText?: string;
  allowWaiting?: boolean;
  countAgainstBudget?: boolean;
  /** Wall-clock timeout for this session. Defaults to the task's remaining budget. */
  wallClockMs?: number;
  recordAttempt?: boolean;
  onContextMetrics?: (metrics: ContextMetrics) => void;
  onToolCall?: (name: string, input: unknown, toolCallId: string) => void;
  onText?: (delta: string) => void;
  onStreamEvent?: (event: AgentStreamEvent) => void;
  onSession?: (session: AgentSession) => void;
  onSessionDisposed?: () => void;
}

export interface PiStageRunResult {
  finalText: string;
  usage: Usage;
  toolCalls: number;
  wallClockMs: number;
  sessionId: string;
  modelName: string;
}

/**
 * One stage = one in-memory session. The durable state is the task store +
 * checkpoints + artifacts, not the chat transcript, so a stage boundary can
 * safely reset the session and rebuild context from structured state.
 */
export async function runPiStageAgent(options: PiStageRunOptions): Promise<PiStageRunResult> {
  const { runtime, stage, allowedTools, assembler, models } = options;
  const workspace = runtime.workspace.path;
  const task: Task = runtime.task;
  const extension = createHarnessExtension({
    runtime,
    stage,
    allowedTools,
    assembler,
    systemPromptText: options.systemPromptText,
    allowWaiting: options.allowWaiting,
    countAgainstBudget: options.countAgainstBudget,
    onContextMetrics: options.onContextMetrics,
    onToolCall: options.onToolCall,
  });

  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: getAgentDir(),
    systemPromptOverride: () =>
      options.systemPromptText ?? buildSystemPrompt(task, stage, allowedTools),
    appendSystemPromptOverride: () => [],
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    extensionFactories: [extension],
  });
  await loader.reload();

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: workspace,
    model: models.model,
    modelRuntime: models.runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(workspace),
    customTools: createHarnessTools(runtime),
    tools: allowedTools,
  });
  if (modelFallbackMessage) {
    await runtime.event("model_fallback", { message: modelFallbackMessage });
  }
  options.onSession?.(session);

  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  let finalText = "";
  let toolCalls = 0;
  const started = Date.now();
  let abortReason: string | undefined;

  const unsubscribe = session.subscribe((event) => {
    if (process.env.FORGEPILOT_DEBUG_EVENTS) {
      const extra =
        event.type === "tool_execution_start"
          ? ` ${event.toolName}`
          : event.type === "message_update"
            ? ` ${event.assistantMessageEvent.type}`
            : "";
      console.error("[event]", event.type + extra);
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") options.onText?.(update.delta);
      const mapped = fromAssistantStreamEvent(update);
      if (mapped) options.onStreamEvent?.(mapped);
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message;
      usage.input += message.usage.input;
      usage.output += message.usage.output;
      usage.cacheRead += message.usage.cacheRead;
      usage.cacheWrite += message.usage.cacheWrite;
      usage.totalTokens += message.usage.totalTokens;
      usage.cost.input += message.usage.cost.input;
      usage.cost.output += message.usage.cost.output;
      usage.cost.cacheRead += message.usage.cost.cacheRead;
      usage.cost.cacheWrite += message.usage.cost.cacheWrite;
      usage.cost.total += message.usage.cost.total;
      const text = message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text.trim()) finalText = text;
      void runtime.addUsage(
        {
          input: message.usage.input,
          output: message.usage.output,
          cacheRead: message.usage.cacheRead,
        },
        { countAgainstBudget: options.countAgainstBudget !== false },
      );
      return;
    }
    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      options.onStreamEvent?.(fromToolStartEvent(event));
      return;
    }
    if (event.type === "tool_execution_update") {
      options.onStreamEvent?.(fromToolUpdateEvent(event));
      return;
    }
    if (event.type === "tool_execution_end") {
      const mapped = fromToolEndEvent(event);
      options.onStreamEvent?.(mapped);
      if (mapped.type === "tool_end") {
        void runtime.event("tool_result", {
          toolCallId: mapped.toolCallId,
          toolName: mapped.toolName,
          isError: mapped.isError,
          durationMs: mapped.durationMs,
          summary: mapped.summary,
        });
      }
      return;
    }
    if (event.type === "agent_settled") {
      if (event.aborted && !abortReason) abortReason = "aborted";
      options.onStreamEvent?.({ type: "settled", aborted: event.aborted });
    }
  });

  const remainingBudgetMs = task.budget.maxWallClockMs - (Date.now() - task.budget.startedAt);
  const wallClockMs = options.wallClockMs ?? Math.max(10_000, remainingBudgetMs);
  const abortTimer = setTimeout(() => {
    if (!session) return;
    abortReason = "wall-clock budget";
    void session.abort();
  }, wallClockMs);

  try {
    await runtime.ensureNotCancelled();
    await session.prompt(options.prompt);
    await runtime.ensureNotCancelled();
    if (abortReason && abortReason !== "aborted") {
      throw new Error(`Agent stopped: ${abortReason}`);
    }
    const latest = await runtime.reload();
    if (latest.cancelRequested || latest.lifecycle === "CANCELLING" || latest.lifecycle === "CANCELLED") {
      throw new CancelledError(latest.id);
    }
    if (finalText.trim() && options.recordAttempt !== false) {
      await runtime.update((draft) => {
        draft.state.attempts.push({
          id: `A-${Date.now()}-agent`,
          action: `agent:${stage}`,
          result: "success",
          detail: oneLine(finalText, 400),
          at: Date.now(),
        });
        if (draft.state.attempts.length > 80) draft.state.attempts.shift();
      });
    }
    await runtime.event("agent_turn", {
      stage,
      sessionId: session.sessionId,
      model: models.name,
      summary: oneLine(finalText, 900),
      toolCalls,
      wallClockMs: Date.now() - started,
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        totalTokens: usage.totalTokens,
      },
      aborted: Boolean(abortReason),
    });
    return {
      finalText,
      usage,
      toolCalls,
      wallClockMs: Date.now() - started,
      sessionId: session.sessionId,
      modelName: models.name,
    };
  } finally {
    clearTimeout(abortTimer);
    unsubscribe();
    session.dispose();
    options.onSessionDisposed?.();
  }
}

export function sessionSummary(session: AgentSession): string {
  return `${session.sessionId} (${session.sessionFile ?? "in-memory"})`;
}
