import test from "node:test";
import assert from "node:assert/strict";
import { summarizeToolInput, summarizeToolResult } from "../src/agent/ui-events.js";

test("tool result summaries are flattened and bounded", () => {
  assert.equal(
    summarizeToolResult({ content: [{ type: "text", text: "  hello\n\nworld  " }] }),
    "hello world",
  );
  assert.equal(summarizeToolResult({ content: [{ type: "image" }] }), "");
  const long = summarizeToolResult({ content: [{ type: "text", text: "x".repeat(500) }] }, 40);
  assert.equal(long.length, 41);
  assert.ok(long.endsWith("…"));
});

test("tool input summaries are compact JSON", () => {
  assert.equal(summarizeToolInput({ path: "src/pagination.js" }), '{"path":"src/pagination.js"}');
  assert.equal(summarizeToolInput(undefined), "");
  assert.ok(summarizeToolInput({ text: "x".repeat(500) }, 30).endsWith("…"));
});
