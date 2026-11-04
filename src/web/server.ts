import http from "node:http";
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ForgePilotHarness } from "../harness/orchestrator.js";
import { GitWorkspace } from "../integrations/git.js";
import { readJson, readJsonl } from "../utils/paths.js";

export interface WebServerOptions {
  projectRoot: string;
  root: string;
  port?: number;
  host?: string;
  model?: string;
}

export interface WebServer {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}

export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const harness = new ForgePilotHarness({
    root: options.root,
    projectRoot: options.projectRoot,
    autoApprove: false,
    model: options.model,
  });
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4310;
  const staticDir = await resolveStaticDir();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      if (url.pathname === "/api/health") {
        return sendJson(res, 200, { ok: true, version: "0.1.0" });
      }
      if (url.pathname === "/api/issues" && req.method === "GET") {
        return sendJson(res, 200, await listIssueFixtures(options.projectRoot));
      }
      if (url.pathname === "/api/tasks" && req.method === "GET") {
        const tasks = await harness.listTasks();
        return sendJson(
          res,
          200,
          tasks.map((task) => ({
            id: task.id,
            ticketId: task.ticketId,
            title: task.title,
            stage: task.stage,
            lifecycle: task.lifecycle,
            issueUrl: task.issueUrl,
            patchHash: task.changePackage?.patchHash ?? task.patchHash,
            changedFiles: task.changePackage?.changedFiles ?? [],
            pr: task.pr,
            updatedAt: task.updatedAt,
            running: harness.isTaskRunning(task.id),
          })),
        );
      }
      if (url.pathname === "/api/tasks" && req.method === "POST") {
        const body = await readBody(req);
        const issue = typeof body.issue === "string" ? body.issue : undefined;
        const ticket = typeof body.ticket === "string" ? body.ticket : undefined;
        const created = issue
          ? await harness.createTaskFromIssue(issue)
          : await harness.createTaskFromTicket(ticket ?? "fixtures/tickets/T-1001.json");
        harness.startInBackground(created.task.id);
        return sendJson(res, 201, { task: created.task });
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/([^/]+))?$/);
      if (taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1]);
        const action = taskMatch[2];
        const task = await harness.getTask(taskId);
        if (!task) return sendJson(res, 404, { error: "task not found" });

        if (!action && req.method === "GET") {
          return sendJson(res, 200, await taskDetail(harness, taskId));
        }
        if (action === "chat" && req.method === "POST") {
          const body = await readBody(req);
          const message = typeof body.message === "string" ? body.message : "";
          if (!message.trim()) return sendJson(res, 400, { error: "message required" });
          return streamReviewChat(req, res, harness, taskId, message);
        }
        if (action === "approve" && req.method === "POST") {
          await harness.approve(taskId);
          harness.startInBackground(taskId);
          return sendJson(res, 202, { task: await harness.getTask(taskId) });
        }
        if (action === "request-changes" && req.method === "POST") {
          const body = await readBody(req);
          const message = typeof body.message === "string" ? body.message : "";
          const updated = await harness.requestChanges(taskId, message, { start: true });
          return sendJson(res, 202, { task: updated });
        }
        if (action === "cancel" && req.method === "POST") {
          const updated = await harness.cancel(taskId);
          if (!harness.isTaskRunning(taskId)) harness.startInBackground(taskId);
          return sendJson(res, 202, { task: updated });
        }
      }

      if (req.method === "GET") {
        return serveStatic(res, staticDir, url.pathname);
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
        res.end();
        return;
      }
      return sendJson(res, 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    url: `http://${host}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function taskDetail(harness: ForgePilotHarness, taskId: string) {
  const task = await harness.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const root = harness.config.root;
  const chat = await harness.reviewHistory(taskId);
  const verifications = await harness.stores.verifications.list(taskId);
  const events = (await readJsonl<Record<string, unknown>>(path.join(root, "tasks", taskId, "events.jsonl"))).slice(-100);
  let diff = "";
  if (task.changePackage?.patchArtifactId) {
    try {
      diff = await harness.stores.artifacts.get(task.changePackage.patchArtifactId);
    } catch {
      diff = "";
    }
  }
  if (!diff && task.workspacePath) {
    const workspace = new GitWorkspace(task.workspacePath);
    if (task.baseCommit) workspace.setBase(task.baseCommit);
    diff = await workspace.diff().catch(() => "");
  }
  return {
    task,
    chat,
    verifications,
    events,
    diff,
    running: harness.isTaskRunning(taskId),
    reviewTools: ["read", "grep", "find", "ls", "read_artifact", "get_change_summary", "get_task_status", "get_pr_status"],
  };
}

async function streamReviewChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  harness: ForgePilotHarness,
  taskId: string,
  message: string,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let closed = false;
  req.on("close", () => {
    closed = true;
  });
  const write = (payload: unknown) => {
    if (closed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  write({ type: "start", taskId });
  try {
    const result = await harness.askReview(taskId, message, (delta) => write({ type: "delta", text: delta }));
    write({ type: "done", answer: result.answer, history: result.history });
  } catch (err) {
    write({ type: "error", error: (err as Error).message });
  } finally {
    res.end();
  }
}

async function listIssueFixtures(projectRoot: string) {
  const dir = path.join(projectRoot, "fixtures", "github");
  const files = await readdir(dir).catch(() => []);
  const issues: Array<Record<string, unknown>> = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file === "projects.json") continue;
    const data = await readJson<Record<string, any>>(path.join(dir, file));
    if (!data) continue;
    const issue = data.issue ?? {};
    issues.push({
      file: path.relative(projectRoot, path.join(dir, file)).replaceAll("\\", "/"),
      number: issue.number ?? data.ticket?.issueNumber,
      title: issue.title ?? data.ticket?.title,
      url: issue.html_url ?? data.ticket?.issueUrl,
      labels: issue.labels ?? [],
    });
  }
  return issues;
}

async function resolveStaticDir(): Promise<string> {
  const local = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(local, "static"), path.join(process.cwd(), "src", "web", "static")];
  for (const candidate of candidates) {
    try {
      await readFile(path.join(candidate, "index.html"), "utf8");
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error("Web static directory not found");
}

async function serveStatic(res: http.ServerResponse, dir: string, pathname: string): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const safe = path.resolve(dir, relative);
  if (!safe.startsWith(path.resolve(dir))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const content = await readFile(safe);
    const type =
      safe.endsWith(".html")
        ? "text/html; charset=utf-8"
        : safe.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : safe.endsWith(".css")
            ? "text/css; charset=utf-8"
            : safe.endsWith(".svg")
              ? "image/svg+xml"
              : "application/octet-stream";
    res.writeHead(200, { "content-type": type }).end(content);
  } catch {
    res.writeHead(404).end("not found");
  }
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(data));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON body");
  }
}
