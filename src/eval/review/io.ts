import path from "node:path";
import { readJson, atomicWriteJson, ensureDir } from "../../utils/paths.js";
import { writeFile } from "node:fs/promises";
import type { LabelSet, ReviewRun } from "./types.js";

export async function loadReviewRun(projectRoot: string, file: string): Promise<ReviewRun> {
  const run = await readJson<ReviewRun>(path.isAbsolute(file) ? file : path.resolve(projectRoot, file));
  if (!run) throw new Error(`Review run not found: ${file}`);
  if (!Array.isArray(run.findings)) throw new Error(`Invalid review run: ${file}`);
  return run;
}

export async function loadLabelSet(projectRoot: string, file: string): Promise<LabelSet> {
  const labels = await readJson<LabelSet>(path.isAbsolute(file) ? file : path.resolve(projectRoot, file));
  if (!labels) throw new Error(`Label set not found: ${file}`);
  if (!Array.isArray(labels.defects) || !labels.version) throw new Error(`Invalid label set: ${file}`);
  return labels;
}

export async function writeReviewReport(
  outDir: string,
  runId: string,
  result: unknown,
  markdown: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await ensureDir(outDir);
  const jsonPath = path.join(outDir, `${runId}.json`);
  const markdownPath = path.join(outDir, `${runId}.md`);
  await atomicWriteJson(jsonPath, result);
  await writeFile(markdownPath, markdown + "\n", "utf8");
  return { jsonPath, markdownPath };
}
