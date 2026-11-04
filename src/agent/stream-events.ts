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
