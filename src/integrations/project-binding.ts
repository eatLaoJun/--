import path from "node:path";
import type { Budget, TaskConstraints } from "../domain/types.js";
import { createBudget } from "../domain/types.js";
import { readJson } from "../utils/paths.js";
import type { Incident } from "./event-center.js";

export interface ProjectBinding {
  service: string;
  repoName: string;
  repoTemplate: string;
  baseBranch: string;
  commands: Record<string, string>;
  constraints: TaskConstraints;
  owners: string[];
  budget?: Budget;
}

export async function resolveProjectBinding(
  projectRoot: string,
  incident: Incident,
): Promise<ProjectBinding> {
  const file = path.join(projectRoot, "fixtures", "event-center", "projects.json");
  const mappings = await readJson<Record<string, Omit<ProjectBinding, "service">>>(file);
  if (!mappings) throw new Error(`Project binding fixture not found: ${file}`);
  const mapping = mappings[incident.service];
  if (!mapping) {
    throw new Error(
      `No authorized project binding for service "${incident.service}". ` +
        `Add it to fixtures/event-center/projects.json before starting the task.`,
    );
  }
  const repoTemplate = path.isAbsolute(mapping.repoTemplate)
    ? mapping.repoTemplate
    : path.resolve(projectRoot, mapping.repoTemplate);
  return {
    ...mapping,
    service: incident.service,
    repoTemplate,
    baseBranch: mapping.baseBranch ?? "main",
    constraints: {
      protectedPaths: mapping.constraints?.protectedPaths ?? ["tests/**", "scripts/**", ".eval/**"],
      allowedPaths: mapping.constraints?.allowedPaths ?? ["**"],
      notes: mapping.constraints?.notes ?? [],
      acceptance: mapping.constraints?.acceptance ?? [],
    },
    budget: createBudget({ ...(mapping.budget ?? {}) }),
  };
}
