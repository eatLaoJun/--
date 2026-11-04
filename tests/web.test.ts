import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startWebServer } from "../src/web/server.js";

const projectRoot = process.cwd();

test("web workbench serves static UI and task APIs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-web-"));
  const web = await startWebServer({
    projectRoot,
    root: path.join(dir, "state"),
    port: 0,
  });
  try {
    const health = (await fetch(`${web.url}/api/health`).then((res) => res.json())) as { ok?: boolean };
    assert.equal(health.ok, true);

    const issues = (await fetch(`${web.url}/api/issues`).then((res) => res.json())) as Array<{ number?: number }>;
    assert.ok(Array.isArray(issues));
    assert.ok(issues.some((issue) => issue.number === 101));

    const tasks = (await fetch(`${web.url}/api/tasks`).then((res) => res.json())) as unknown[];
    assert.deepEqual(tasks, []);

    const html = await fetch(`${web.url}/`).then((res) => res.text());
    assert.match(html, /ForgePilot/);
    assert.match(html, /评审对话/);

    const js = await fetch(`${web.url}/app.js`).then((res) => res.text());
    assert.match(js, /request-changes/);
  } finally {
    await web.close();
    await rm(dir, { recursive: true, force: true });
  }
});
