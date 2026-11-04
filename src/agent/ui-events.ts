import type { ToolExecutionEndEvent, ToolExecutionStartEvent, ToolExecutionUpdateEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

/**
 * UI transport contract. This is not a reimplementation of pi's stream layer:
 * pi exposes two different event families:
 *   - AssistantMessageEvent: provider-level thinking/text/toolcall deltas
 *   - AgentSessionEvent: tool_execution_* and agent_settled from the agent loop
 * The browser/CLI should not depend on those full payloads (they carry partial
 * messages, usage, provider details and duplicate text). These adapters keep a
 * small, stable event shape and summarize tool arguments/results for display.
 */
export type AgentStreamEvent =
  | { type: "thinking_start" }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; input: string }
  | { type: "tool_update"; toolCallId: string; toolName: string; text: string }
  | {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      durationMs?: number;
      summary: string;
    }
  | { type: "settled"; aborted: boolean };

export interface ToolTrace {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  durationMs?: number;
  summary: string;
}

export function fromAssistantStreamEvent(event: AssistantMessageEvent): AgentStreamEvent | undefined {
  switch (event.type) {
    case "thinking_start":
      return { type: "thinking_start" };
    case "thinking_delta":
      return { type: "thinking_delta", text: event.delta };
    case "thinking_end":
      return { type: "thinking_end", text: event.content };
    case "text_delta":
      return { type: "text_delta", text: event.delta };
    default:
      return undefined;
  }
}

export function fromToolStartEvent(event: ToolExecutionStartEvent): AgentStreamEvent {
  return {
    type: "tool_start",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: summarizeToolInput(event.args),
  };
}

export function fromToolUpdateEvent(event: ToolExecutionUpdateEvent): AgentStreamEvent {
  return {
    type: "tool_update",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    text: summarizeToolResult(event.partialResult, 160),
  };
}

export function fromToolEndEvent(event: ToolExecutionEndEvent): AgentStreamEvent {
  return {
    type: "tool_end",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    isError: event.isError,
    durationMs: event.durationMs,
    summary: summarizeToolResult(event.result),
  };
}

/** Extract a short, safe text summary from a tool result for live UI traces. */
export function summarizeToolResult(result: unknown, maxChars = 220): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}

export function summarizeToolInput(input: unknown, maxChars = 180): string {
  if (input === undefined || input === null) return "";
  try {
    const text = JSON.stringify(input).replace(/\s+/g, " ");
    return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
  } catch {
    return String(input).slice(0, maxChars);
  }
}
