import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ForgePilotHarness } from "../src/harness/orchestrator.js";
import { getIncident } from "../src/integrations/event-center.js";
import { resolveProjectBinding } from "../src/integrations/project-binding.js";

const projectRoot = process.cwd();

test("event-center incident creates an INGEST task without guessing a repo", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-event-center-"));
  try {
    const harness = new ForgePilotHarness({
      root: path.join(dir, "state"),
      projectRoot,
      autoApprove: false,
    });
    const { task } = await harness.createTaskFromIncident("INC-2026-001");
    assert.equal(task.stage, "INGEST");
    assert.equal(task.source, "event-center");
    assert.equal(task.incidentId, "INC-2026-001");
    assert.equal(task.service, "course-platform");
    assert.equal(task.workspacePath, undefined);
    assert.equal(task.baseCommit, undefined);

    const duplicate = await harness.createTaskFromIncident("INC-2026-001");
    assert.equal(duplicate.task.id, task.id, "same incident must not create duplicate tasks");

    const incident = await getIncident(projectRoot, "INC-2026-001");
    const binding = await resolveProjectBinding(projectRoot, incident);
    assert.equal(binding.repoName, "demo-course-service");
    assert.match(binding.repoTemplate.replaceAll("\\", "/"), /fixtures\/demo-repo$/);
    assert.ok(binding.commands.test);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
