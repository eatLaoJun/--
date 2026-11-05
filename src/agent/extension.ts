import type { ExtensionFactory, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Stage } from "../domain/types.js";
import type { TaskRuntime } from "../harness/runtime.js";
import { ContextAssembler, resolveBudgetTokens, type ContextMetrics } from "../context/assembler.js";
import { buildSystemPrompt } from "./prompt.js";
import { safeJoin } from "../utils/paths.js";
import { truncate } from "../utils/text.js";

export interface HarnessExtensionOptions {
  runtime: TaskRuntime;
  stage: Stage;
  allowedTools: string[];
  assembler: ContextAssembler;
  systemPromptText?: string;
  allowWaiting?: boolean;
  countAgainstBudget?: boolean;
  onContextMetrics?: (metrics: ContextMetrics) => void;
  onToolCall?: (name: string, input: unknown, toolCallId: string) => void;
}

const HARD_BLOCKED = new Set(["bash", "powershell", "edit", "write"]);

/**
 * All hooks that must intercept or rewrite agent behavior live in the extension
 * layer: `context`, `tool_call`, `tool_result` and `before_agent_start` are not
 * delivered to session.subscribe.
 */
export function createHarnessExtension(options: HarnessExtensionOptions): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      if (event.messageType !== "user") return;
      return {
        systemPrompt:
          options.systemPromptText ??
          buildSystemPrompt(options.runtime.task, options.stage, options.allowedTools),
      };
    });

    pi.on("context", async (event, ctx) => {
      const task = await options.runtime.reload();
      const contextWindow = ctx.model?.contextWindow ?? 128_000;
      const maxOutput = ctx.model?.maxTokens ?? 8_192;
      const budgetTokens = resolveBudgetTokens(contextWindow, maxOutput);
      const assembled = await options.assembler.assemble({
        task,
        state: task.state,
        stage: options.stage,
        messages: event.messages,
        budgetTokens,
      });
      options.onContextMetrics?.(assembled.metrics);
      await options.runtime.event("context_metrics", {
        beforeTokens: assembled.metrics.beforeTokens,
        afterTokens: assembled.metrics.afterTokens,
        summarizedMessages: assembled.metrics.summarizedMessages,
        offloadedToolOutputs: assembled.metrics.offloadedToolOutputs,
        preservedToolPairs: assembled.metrics.preservedToolPairs,
        droppedMessages: assembled.metrics.droppedMessages,
        stateTokens: assembled.metrics.stateTokens,
        digestTokens: assembled.metrics.digestTokens,
        recentTokens: assembled.metrics.recentTokens,
        estimatedSavedTokens: assembled.metrics.beforeTokens - assembled.metrics.afterTokens,
        constraintHash: assembled.metrics.constraintHash,
      });
      return { messages: assembled.messages };
    });

    pi.on("tool_call", async (event, ctx) => {
      try {
        if (HARD_BLOCKED.has(event.toolName)) {
          return { block: true, reason: `${event.toolName} is not available in ForgePilot; use apply_patch.` };
        }
        if (!options.allowedTools.includes(event.toolName)) {
          return {
            block: true,
            reason: `Tool ${event.toolName} is not available in stage ${options.stage}.`,
          };
        }
        const task = await options.runtime.reload();
        if (task.cancelRequested || task.lifecycle === "CANCELLING" || task.lifecycle === "CANCELLED") {
          return { block: true, reason: "Task was cancelled; no further side effects are allowed." };
        }
        if (!options.allowWaiting && task.lifecycle !== "RUNNING") {
          return { block: true, reason: `Task lifecycle is ${task.lifecycle}; tools are not allowed.` };
        }
        if (
          options.allowWaiting &&
          !["RUNNING", "WAITING_APPROVAL", "WAITING_INPUT", "PAUSED", "DELIVERED"].includes(task.lifecycle)
        ) {
          return { block: true, reason: `Task lifecycle is ${task.lifecycle}; read-only review tools are not allowed.` };
        }
        if (options.countAgainstBudget !== false && task.budget.toolCallsUsed >= task.budget.maxToolCalls) {
          return { block: true, reason: "Tool call budget exhausted; stop and report the blocker." };
        }
        const pathError = validateToolPaths(ctx, event.input);
        if (pathError) {
          if (process.env.FORGEPILOT_DEBUG_EVENTS) console.error("[gate] path blocked", pathError);
          return { block: true, reason: pathError };
        }
        await options.runtime.countToolCall(event.toolName, options.countAgainstBudget !== false);
        options.onToolCall?.(event.toolName, event.input, event.toolCallId);
        return undefined;
      } catch (err) {
        if (process.env.FORGEPILOT_DEBUG_EVENTS) console.error("[gate] error", (err as Error).message);
        return { block: true, reason: `Harness gate error: ${(err as Error).message}` };
      }
    });

    pi.on("tool_result", async (event) => {
      if (event.isError) return;
      const text = event.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text.length <= 6000) return;
      const meta = await options.runtime.stores.artifacts.put(text, {
        taskId: options.runtime.task.id,
        kind: `tool_result:${event.toolName}`,
        name: `${event.toolName}-${event.toolCallId}`,
      });
      return {
        content: [
          {
            type: "text",
            text:
              `[tool output offloaded to artifact ${meta.id} (${meta.bytes} bytes); use read_artifact]\n` +
              truncate(text, 900),
          },
        ],
      };
    });

    pi.on("agent_settled", async (event) => {
      await options.runtime.event("agent_settled", { aborted: event.aborted, stage: options.stage });
    });
  };
}

function validateToolPaths(ctx: ExtensionContext, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const root = ctx.cwd;
  const record = input as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of ["path", "file_path", "repo_path"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) paths.push(value);
  }
  if (Array.isArray(record.changes)) {
    for (const change of record.changes) {
      if (change && typeof change === "object" && typeof (change as { path?: unknown }).path === "string") {
        paths.push((change as { path: string }).path);
      }
    }
  }
  for (const path of paths) {
    try {
      safeJoin(root, path);
    } catch (err) {
      return (err as Error).message;
    }
  }
  return undefined;
}
