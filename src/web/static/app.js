const $ = (selector) => document.querySelector(selector);
const state = {
  tasks: [],
  issues: [],
  selectedId: undefined,
  detail: undefined,
  tab: "overview",
  streaming: false,
  poll: undefined,
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function richText(value) {
  const parts = String(value ?? "").split("```");
  return parts
    .map((part, index) =>
      index % 2 === 1
        ? `<pre class="code-block">${escapeHtml(part.replace(/^\w+\n/, ""))}</pre>`
        : escapeHtml(part)
            .replace(/`([^`]+)`/g, "<code>$1</code>")
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/\n/g, "<br />"),
    )
    .join("");
}

function badge(value) {
  const cls = String(value).toLowerCase();
  return `<span class="badge ${cls}">${escapeHtml(value)}</span>`;
}

function shortHash(hash) {
  return hash ? String(hash).slice(0, 12) : "—";
}

function time(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function toast(message, kind = "info") {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast show ${kind}`;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => (node.className = "toast"), 3200);
}

async function loadIssues() {
  state.issues = await api("/api/issues");
  const select = $("#issue-select");
  select.innerHTML = state.issues
    .map(
      (issue) =>
        `<option value="${escapeHtml(issue.file)}">#${escapeHtml(issue.number ?? "")} ${escapeHtml(issue.title ?? issue.file)}</option>`,
    )
    .join("");
}

async function loadTasks() {
  state.tasks = await api("/api/tasks");
  renderTaskList();
}

function renderTaskList() {
  const list = $("#task-list");
  if (!state.tasks.length) {
    list.innerHTML = `<div class="task-empty">还没有任务。从上面的 Issue 开始。</div>`;
    return;
  }
  list.innerHTML = state.tasks
    .map(
      (task) => `
      <button class="task-item ${task.id === state.selectedId ? "selected" : ""}" data-id="${escapeHtml(task.id)}">
        <div class="task-item-top">
          <span class="ticket">${escapeHtml(task.ticketId)}</span>
          ${badge(task.lifecycle)}
        </div>
        <div class="task-item-title">${escapeHtml(task.title)}</div>
        <div class="task-item-bottom">
          <span>${escapeHtml(task.stage)}</span>
          <span>${task.running ? '<i class="dot live"></i> 执行中' : time(task.updatedAt)}</span>
        </div>
      </button>`,
    )
    .join("");
  for (const item of list.querySelectorAll(".task-item")) {
    item.addEventListener("click", () => selectTask(item.dataset.id));
  }
}

async function selectTask(taskId) {
  state.selectedId = taskId;
  state.tab = "overview";
  await loadDetail();
  renderTabs();
}

async function loadDetail() {
  if (!state.selectedId) return;
  state.detail = await api(`/api/tasks/${encodeURIComponent(state.selectedId)}`);
  renderDetail();
}

function renderDetail() {
  const detail = state.detail;
  if (!detail) return;
  $("#empty").hidden = true;
  $("#detail").hidden = false;
  const task = detail.task;

  $("#task-title").textContent = task.title;
  $("#issue-link").innerHTML = task.issueUrl
    ? `<a href="${escapeHtml(task.issueUrl)}" target="_blank" rel="noreferrer">${escapeHtml(task.issueUrl)}</a>`
    : `<span>本地工单 · ${escapeHtml(task.ticketId)}</span>`;
  $("#task-meta").innerHTML = [
    badge(`${task.stage} / ${task.lifecycle}`),
    `<span>base ${escapeHtml(shortHash(task.baseCommit))}</span>`,
    `<span>patch ${escapeHtml(shortHash(task.changePackage?.patchHash ?? task.patchHash))}</span>`,
    task.pr ? `<a href="${escapeHtml(task.pr.url)}" target="_blank" rel="noreferrer">${escapeHtml(task.pr.id)}</a>` : "",
  ]
    .filter(Boolean)
    .join("");

  const running = detail.running || state.streaming;
  const canReview = task.lifecycle === "WAITING_APPROVAL";
  $("#approve-btn").disabled = !canReview || running;
  $("#changes-btn").disabled = !canReview || running || state.streaming;
  $("#cancel-btn").disabled = ["DELIVERED", "CANCELLED", "FAILED"].includes(task.lifecycle) || state.streaming;

  $("#statusbar").innerHTML = `
    <div class="status-left">
      <span class="stage-pill">${escapeHtml(task.stage)}</span>
      <span class="${task.lifecycle === "WAITING_APPROVAL" ? "waiting" : ""}">${escapeHtml(task.lifecycle)}</span>
      ${running ? '<span class="spinner"></span><span>Agent 正在执行…</span>' : ""}
    </div>
    <div class="status-right">
      <span>${task.budget.tokensUsed.toLocaleString()} tokens</span>
      <span>${task.budget.toolCallsUsed} tools</span>
      <span>${task.budget.repairIterations}/${task.budget.maxRepairIterations} repair</span>
    </div>`;

  renderOverview(task, detail);
  renderDiff(detail.diff);
  renderEvidence(detail);
  renderChat(detail.chat);

  const chatCount = (detail.chat || []).filter((message) => message.role !== "system").length;
  $("#chat-count").textContent = chatCount ? String(chatCount) : "";
}

function card(title, content, extra = "") {
  return `<article class="card"><div class="card-head"><h3>${escapeHtml(title)}</h3>${extra}</div>${content}</article>`;
}

function renderOverview(task, detail) {
  const pkg = task.changePackage;
  const unresolved = (task.feedback || []).filter((item) => !item.resolvedAt);
  const verifications = (detail.verifications || []).slice(-4).reverse();
  const html = [
    card(
      "工单",
      `<p class="muted">${escapeHtml(task.description)}</p>
       <div class="kv"><span>预期</span><b>${escapeHtml(task.expected)}</b></div>
       <div class="kv"><span>Issue</span><b>${task.issueUrl ? `<a href="${escapeHtml(task.issueUrl)}" target="_blank" rel="noreferrer">${escapeHtml(task.issueUrl)}</a>` : "本地工单"}</b></div>`,
    ),
    card(
      "变更包",
      pkg
        ? `<div class="kv"><span>Patch</span><b class="mono">${escapeHtml(pkg.patchHash)}</b></div>
           <div class="kv"><span>文件</span><b>${pkg.changedFiles.map(escapeHtml).join("<br />") || "—"}</b></div>
           <div class="kv"><span>理由</span><b>${richText(pkg.rationale)}</b></div>
           <div class="kv"><span>验证</span><b class="mono">${escapeHtml(pkg.verificationId)}</b></div>
           <div class="kv"><span>风险</span><b>${pkg.riskNotes.map(escapeHtml).join("<br />")}</b></div>`
        : `<p class="muted">当前还没有可审批的变更包。</p>`,
      pkg ? badge(pkg.approvedAt ? "APPROVED" : "WAITING_APPROVAL") : "",
    ),
    card(
      "验证证据",
      verifications.length
        ? verifications
            .map(
              (item) =>
                `<div class="verify-row ${item.exitCode === 0 ? "ok" : "fail"}">
                  <div><b>${escapeHtml(item.kind)}</b> <span class="mono">${escapeHtml(item.command)}</span></div>
                  <div>exit ${item.exitCode} · ${escapeHtml(shortHash(item.patchHash))}</div>
                  <pre>${escapeHtml((item.keyOutput || "").slice(0, 1200))}</pre>
                </div>`,
            )
            .join("")
        : `<p class="muted">暂无验证记录。</p>`,
    ),
    card(
      "交付",
      task.pr
        ? `<div class="kv"><span>PR</span><b><a href="${escapeHtml(task.pr.url)}" target="_blank" rel="noreferrer">${escapeHtml(task.pr.id)}</a></b></div>
           <div class="kv"><span>分支</span><b class="mono">${escapeHtml(task.pr.branch)}</b></div>
           <div class="kv"><span>Head</span><b class="mono">${escapeHtml(task.pr.headCommit)}</b></div>
           <div class="kv"><span>状态</span><b>${escapeHtml(task.pr.status)}（人工评审/合并仍需完成）</b></div>`
        : `<p class="muted">通过审核后会推送分支并创建 PR。</p>`,
    ),
    unresolved.length
      ? card(
          "待处理的审核意见",
          unresolved
            .map(
              (item) =>
                `<div class="feedback-row"><b>${time(item.requestedAt)}</b><span>${richText(item.message)}</span></div>`,
            )
            .join(""),
          badge("ACTION REQUIRED"),
        )
      : "",
    task.summary ? card("交付摘要", `<p>${richText(task.summary)}</p>`) : "",
    task.lastError ? card("最近错误", `<pre class="error-box">${escapeHtml(task.lastError)}</pre>`) : "",
  ]
    .filter(Boolean)
    .join("");
  $("#tab-overview").innerHTML = html;
}

function renderDiff(diff) {
  const target = $("#tab-diff");
  if (!diff) {
    target.innerHTML = `<div class="empty-small">当前没有 diff。</div>`;
    return;
  }
  const lines = String(diff).split(/\r?\n/);
  target.innerHTML = `<div class="diff-head">${lines.length} lines</div><pre class="diff">${lines
    .map((line) => {
      const cls = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")
        ? "meta"
        : line.startsWith("@@")
          ? "hunk"
          : line.startsWith("+")
            ? "add"
            : line.startsWith("-")
              ? "del"
              : "";
      return `<span class="diff-line ${cls}">${escapeHtml(line) || " "}</span>`;
    })
    .join("")}</pre>`;
}

function renderEvidence(detail) {
  const items = (detail.verifications || []).slice().reverse();
  $("#tab-evidence").innerHTML = items.length
    ? items
        .map(
          (item) => `
      <article class="card">
        <div class="card-head">
          <h3>${escapeHtml(item.kind)} · exit ${item.exitCode}</h3>
          ${badge(item.envError ? "ENV_ERROR" : item.exitCode === 0 ? "PASS" : "FAIL")}
        </div>
        <div class="kv"><span>命令</span><b class="mono">${escapeHtml(item.command)}</b></div>
        <div class="kv"><span>Patch</span><b class="mono">${escapeHtml(item.patchHash)}</b></div>
        <div class="kv"><span>指纹</span><b class="mono">${escapeHtml(item.fingerprint)}</b></div>
        <div class="kv"><span>Artifact</span><b class="mono">${escapeHtml(item.artifactId)}</b></div>
        <pre>${escapeHtml(item.keyOutput || "(no key output)")}</pre>
      </article>`,
        )
        .join("")
    : `<div class="empty-small">暂无验证记录。</div>`;
}

function renderChat(history) {
  const box = $("#chat-messages");
  if (state.streaming && box.querySelector(".streaming")) {
    // Keep the streaming bubble while deltas arrive.
  }
  const messages = (history || []).filter((message) => message.role !== "system");
  const intro = `<div class="chat-intro">
      <b>评审对话</b>
      <span>可以问：为什么这样改？有没有边界情况？验证覆盖了什么？</span>
    </div>`;
  box.innerHTML =
    intro +
    messages
      .map(
        (message) => `
      <div class="msg ${message.role}">
        <div class="msg-meta">${message.role === "engineer" ? "工程师" : "ForgePilot"} · ${time(message.at)}</div>
        <div class="msg-body">${richText(message.content)}</div>
      </div>`,
      )
      .join("");
  if (!messages.length && !state.streaming) {
    box.insertAdjacentHTML(
      "beforeend",
      `<div class="chat-empty">还没有对话。审批前先问清楚，再点“通过并创建 PR”或“要求修改”。</div>`,
    );
  }
  box.scrollTop = box.scrollHeight;
}

function renderTabs() {
  for (const button of document.querySelectorAll(".tabs button")) {
    button.classList.toggle("active", button.dataset.tab === state.tab);
  }
  for (const name of ["overview", "diff", "evidence", "chat"]) {
    $(`#tab-${name}`).hidden = name !== state.tab;
  }
}

async function createTask() {
  const file = $("#issue-select").value;
  if (!file) return;
  try {
    $("#create-task").disabled = true;
    const data = await api("/api/tasks", { method: "POST", body: JSON.stringify({ issue: file }) });
    await loadTasks();
    await selectTask(data.task.id);
    toast("任务已创建，Agent 开始修复");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    $("#create-task").disabled = false;
  }
}

async function sendChat() {
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message || state.streaming || !state.selectedId) return;
  input.value = "";
  state.streaming = true;
  const box = $("#chat-messages");
  if (box.querySelector(".chat-empty")) box.querySelector(".chat-empty").remove();
  box.insertAdjacentHTML(
    "beforeend",
    `<div class="msg engineer"><div class="msg-meta">工程师 · 刚刚</div><div class="msg-body">${richText(message)}</div></div>`,
  );
  const bubble = document.createElement("div");
  bubble.className = "msg assistant streaming";
  bubble.innerHTML = `<div class="msg-meta">ForgePilot · 正在回答</div><div class="msg-body"></div>`;
  box.appendChild(bubble);
  box.scrollTop = box.scrollHeight;
  const body = bubble.querySelector(".msg-body");

  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(state.selectedId)}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        const line = event.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;
        const payload = JSON.parse(line.slice(6));
        if (payload.type === "delta") {
          body.innerHTML = richText(body.dataset.raw ? (body.dataset.raw += payload.text) : (body.dataset.raw = payload.text));
          box.scrollTop = box.scrollHeight;
        } else if (payload.type === "error") {
          body.innerHTML = `<span class="error">${escapeHtml(payload.error)}</span>`;
        }
      }
    }
  } catch (err) {
    body.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  } finally {
    state.streaming = false;
    await loadDetail();
    renderTabs();
  }
}

async function requestChanges() {
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message) {
    toast("先在对话框里写清楚要改什么，再点“要求修改”", "error");
    return;
  }
  if (!confirm("确认要求 Agent 按这条意见回到 REPAIR 并重新验证？")) return;
  try {
    $("#changes-btn").disabled = true;
    await api(`/api/tasks/${encodeURIComponent(state.selectedId)}/request-changes`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    input.value = "";
    toast("已退回 REPAIR，Agent 会按审核意见修改并重新验证");
    await poll();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    $("#changes-btn").disabled = false;
  }
}

async function approve() {
  if (!confirm("确认这个 patch 已通过审核？通过后会推送分支并创建 PR。")) return;
  try {
    $("#approve-btn").disabled = true;
    await api(`/api/tasks/${encodeURIComponent(state.selectedId)}/approve`, { method: "POST" });
    toast("已通过审核，正在创建 PR");
    await poll();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    $("#approve-btn").disabled = false;
  }
}

async function cancelTask() {
  if (!confirm("确认取消这个任务？已创建的分支/PR 会保留。")) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(state.selectedId)}/cancel`, { method: "POST" });
    toast("任务取消中");
    await poll();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function poll() {
  try {
    await loadTasks();
    if (state.selectedId && !state.streaming) await loadDetail();
  } catch {
    // transient polling errors are ignored
  }
}

function bind() {
  $("#create-task").addEventListener("click", createTask);
  $("#refresh").addEventListener("click", poll);
  $("#send-btn").addEventListener("click", sendChat);
  $("#approve-btn").addEventListener("click", approve);
  $("#changes-btn").addEventListener("click", requestChanges);
  $("#cancel-btn").addEventListener("click", cancelTask);
  $("#chat-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendChat();
    }
  });
  for (const button of document.querySelectorAll(".tabs button")) {
    button.addEventListener("click", () => {
      state.tab = button.dataset.tab;
      renderTabs();
      if (state.tab === "chat") $("#chat-input")?.focus();
    });
  }
}

async function boot() {
  bind();
  try {
    await loadIssues();
    await loadTasks();
    if (state.tasks[0]) await selectTask(state.tasks[0].id);
  } catch (err) {
    toast(err.message, "error");
  }
  state.poll = setInterval(poll, 2500);
}

boot();
