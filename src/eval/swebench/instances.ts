import path from "node:path";
import { readFile } from "node:fs/promises";
import type { HiddenTestFile, SwebenchInstance } from "./types.js";
import { readJsonl, ensureDir, safeJoin } from "../../utils/paths.js";
import { writeFile } from "node:fs/promises";

export async function loadSwebenchInstances(projectRoot: string, file: string): Promise<SwebenchInstance[]> {
  const absolute = path.isAbsolute(file) ? file : path.resolve(projectRoot, file);
  const instances = await readJsonl<SwebenchInstance>(absolute);
  for (const instance of instances) {
    validateInstance(instance, absolute);
  }
  return instances;
}

function validateInstance(instance: SwebenchInstance, file: string): void {
  const required: Array<keyof SwebenchInstance> = [
    "instance_id",
    "repo_template",
    "problem_statement",
    "hidden_tests",
    "test_command",
    "fail_to_pass",
    "pass_to_pass",
  ];
  for (const key of required) {
    if (instance[key] === undefined) throw new Error(`Instance in ${file} is missing ${key}`);
  }
  if (!Array.isArray(instance.hidden_tests) || instance.hidden_tests.length === 0) {
    throw new Error(`Instance ${instance.instance_id} must have hidden_tests`);
  }
}

export async function applyHiddenTests(
  projectRoot: string,
  workspace: string,
  hiddenTests: HiddenTestFile[],
): Promise<string[]> {
  const written: string[] = [];
  for (const test of hiddenTests) {
    const source = path.isAbsolute(test.source) ? test.source : path.resolve(projectRoot, test.source);
    const content = await readFile(source, "utf8");
    const dest = safeJoin(workspace, test.path);
    await ensureDir(path.dirname(dest));
    await writeFile(dest, content, "utf8");
    written.push(test.path);
  }
  return written;
}
