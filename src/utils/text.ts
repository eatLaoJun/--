import { createHash } from "node:crypto";

/** Rough token estimate: CJK characters count as 1 token, other text as chars/4. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1;
    } else {
      other += ch.length;
    }
  }
  return cjk + Math.ceil(other / 4);
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function shortHash(input: string, length = 10): string {
  return sha256(input).slice(0, length);
}

/** Deterministic JSON stringify (objects sorted by key). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function hashObject(value: unknown): string {
  return sha256(stableStringify(value));
}

export function truncate(text: string, maxChars: number, marker = "\n...[truncated]"): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - marker.length);
  return text.slice(0, keep) + marker;
}

export function oneLine(text: string, maxChars = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return truncate(flat, maxChars);
}

export function firstLines(text: string, count: number): string[] {
  return text.split(/\r?\n/).slice(0, count);
}

export function lastLines(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count));
}

export function jaccard(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let inter = 0;
  for (const t of left) if (right.has(t)) inter += 1;
  return inter / (left.size + right.size - inter);
}

function tokens(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
  return new Set(words);
}

/** Parse a possibly fenced JSON object from an LLM response. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object found in response");
  return JSON.parse(candidate.slice(start, end + 1));
}
