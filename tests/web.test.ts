import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ForgePilotHarness } from "../src/harness/orchestrator.js";
import { startWebServer } from "../src/web/server.js";

const projectRoot = process.cwd();

test("web workbench serves the console, filters and event timeline APIs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-web-"));
  const root = path.join(dir, "state");
  const harness = new ForgePilotHarness({ root, projectRoot, autoApprove: false });
  const { task } = await harness.createTaskFromTicket("fixtures/tickets/T-1001.json");

  const web = await startWebServer({ projectRoot, root, port: 0 });
  try {
    const health = (await fetch(`${web.url}/api/health`).then((res) => res.json())) as { ok?: boolean };
    assert.equal(health.ok, true);

    const issues = (await fetch(`${web.url}/api/issues`).then((res) => res.json())) as Array<{ number?: number }>;
    assert.ok(issues.some((issue) => issue.number === 101));

    const tasks = (await fetch(`${web.url}/api/tasks?stage=PREPARE`).then((res) => res.json())) as Array<{ id: string }>;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, task.id);

    const failed = (await fetch(`${web.url}/api/tasks?failed=1`).then((res) => res.json())) as unknown[];
    assert.deepEqual(failed, []);

    const events = (await fetch(`${web.url}/api/tasks/${task.id}/events?limit=10`).then((res) => res.json())) as {
      events: Array<{ type: string }>;
    };
    assert.ok(events.events.some((event) => event.type === "task_created"));

    const html = await fetch(`${web.url}/`).then((res) => res.text());
    assert.match(html, /ForgePilot/);

    const spa = await fetch(`${web.url}/tasks/${task.id}/timeline`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /ForgePilot/);
  } finally {
    await web.close();
    await rm(dir, { recursive: true, force: true });
  }
});
