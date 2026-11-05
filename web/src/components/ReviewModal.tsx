import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ReviewMessage, TaskDetail } from "../types";
import { shortHash } from "../format";
import { Badge } from "./Badge";
import { RichText } from "./RichText";

interface ToolTrace {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  durationMs?: number;
  summary: string;
}

interface Props {
  open: boolean;
  detail: TaskDetail;
  onClose: () => void;
  onChanged: () => void;
  onOpenDiff: () => void;
}

const CHAT_LIFECYCLES = ["WAITING_APPROVAL", "WAITING_INPUT", "PAUSED", "FAILED", "DELIVERED"];

export function ReviewModal({ open, detail, onClose, onChanged, onOpenDiff }: Props) {
  const task = detail.task;
  const [messages, setMessages] = useState<ReviewMessage[]>(detail.chat);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingId, setStreamingId] = useState<string>();
  const [showScroll, setShowScroll] = useState(false);
  const [thinking, setThinking] = useState("");
  const [tools, setTools] = useState<ToolTrace[]>([]);
  const [error, setError] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const abortRef = useRef<AbortController>();

  const canChat = CHAT_LIFECYCLES.includes(task.lifecycle);
  const canReview = task.lifecycle === "WAITING_APPROVAL";
  const latestTest = [...detail.verifications].reverse().find((item) => item.kind === "test");

  function handleClose() {
    abortRef.current?.abort();
    onClose();
  }

  useEffect(() => {
    if (!open) return;
    setMessages(detail.chat);
    setInput("");
    setError(undefined);
    setThinking("");
    setTools([]);
    setStreamingId(undefined);
    autoScroll.current = true;
    setShowScroll(false);
    window.setTimeout(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }), 20);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    if (autoScroll.current) node.scrollTop = node.scrollHeight;
    setShowScroll(node.scrollHeight - node.scrollTop - node.clientHeight >= 64);
  }, [messages, thinking, tools]);

  function handleScroll() {
    const node = listRef.current;
    if (!node) return;
    autoScroll.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
    setShowScroll(!autoScroll.current);
  }

  function updateAssistant(id: string, updater: (message: ReviewMessage) => ReviewMessage) {
    setMessages((prev) => prev.map((message) => (message.id === id ? updater(message) : message)));
  }

  async function send() {
    const question = input.trim();
    if (!question || streaming || !canChat) return;
    setInput("");
    setError(undefined);
    setThinking("");
    setTools([]);
    autoScroll.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const assistantId = `local-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: `engineer-${Date.now()}`, taskId: task.id, role: "engineer", content: question, at: Date.now() },
      { id: assistantId, taskId: task.id, role: "assistant", content: "", at: Date.now() },
    ]);
    setStreaming(true);
    setStreamingId(assistantId);
    let answer = "";
    let localTools: ToolTrace[] = [];
    let thinkingText = "";

    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: question }),
        signal: controller.signal,
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
          const payload = JSON.parse(line.slice(6)) as {
            type: string;
            text?: string;
            answer?: string;
            error?: string;
            toolCallId?: string;
            toolName?: string;
            isError?: boolean;
            durationMs?: number;
            summary?: string;
          };
          if (payload.type === "delta" && payload.text) {
            answer += payload.text;
            updateAssistant(assistantId, (message) => ({ ...message, content: answer }));
          } else if (payload.type === "thinking_delta" && payload.text) {
            thinkingText += payload.text;
            setThinking(thinkingText);
          } else if (payload.type === "tool_start" && payload.toolCallId && payload.toolName) {
            const trace: ToolTrace = {
              toolCallId: payload.toolCallId,
              toolName: payload.toolName,
              isError: false,
              summary: "",
            };
            localTools = [...localTools, trace];
            setTools(localTools);
          } else if (payload.type === "tool_end" && payload.toolCallId) {
            localTools = localTools.map((tool) =>
              tool.toolCallId === payload.toolCallId
                ? {
                    ...tool,
                    isError: Boolean(payload.isError),
                    durationMs: payload.durationMs,
                    summary: payload.summary ?? "",
                  }
                : tool,
            );
            setTools(localTools);
          } else if (payload.type === "done" && payload.answer) {
            answer = payload.answer;
            updateAssistant(assistantId, (message) => ({ ...message, content: answer }));
          } else if (payload.type === "error") {
            setError(payload.error ?? "回答失败");
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      if (answer) {
        updateAssistant(assistantId, (message) => ({
          ...message,
          content: answer,
          meta: { tools: localTools, thinkingChars: thinkingText.length },
        }));
      }
      setStreaming(false);
      setStreamingId(undefined);
      abortRef.current = undefined;
      onChanged();
    }
  }

  async function requestChanges() {
    const message = input.trim();
    if (!message) {
      alert("先在对话框里写清楚要改什么，再点“要求修改”");
      return;
    }
    if (!confirm("确认要求 Agent 按这条意见回到 REPAIR 并重新验证？")) return;
    try {
      await api.requestChanges(task.id, message);
      setMessages((prev) => [
        ...prev,
        { id: `engineer-${Date.now()}`, taskId: task.id, role: "engineer", content: message, at: Date.now() },
      ]);
      setInput("");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function approve() {
    if (!confirm("确认这个 patch 已通过审核？通过后会推送分支并创建 PR。")) return;
    try {
      await api.approve(task.id);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!open) return null;

  return (
    <div className="modal">
      <div className="modal-backdrop" onClick={handleClose} />
      <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="review-title">
        <header className="modal-head">
          <div>
            <h3 id="review-title">评审对话</h3>
            <p className="hint">
              {task.ticketId} · {task.stage}/{task.lifecycle} · patch{" "}
              {shortHash(task.changePackage?.patchHash ?? task.patchHash)}
            </p>
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={handleClose}>×</button>
        </header>

        <div className="context-strip">
          <span className="context-chip">patch {shortHash(task.changePackage?.patchHash ?? task.patchHash)}</span>
          <span className="context-chip">{task.changePackage?.changedFiles.length || 1} file</span>
          <span className="context-chip">{latestTest ? `${latestTest.id} · exit ${latestTest.exitCode}` : "no verification"}</span>
          <span className="context-chip">repo: on-demand read-only</span>
        </div>

        <div className="chat-panel">
          <div className="chat-messages modal-chat" ref={listRef} onScroll={handleScroll}>
            <div className="chat-intro">
              <b>评审对话</b>
              <span>可以问：为什么这样改？有没有边界情况？验证覆盖了什么？</span>
            </div>
            {messages.filter((message) => message.role !== "system").map((message) => (
              <div className={`msg ${message.role}`} key={message.id}>
                <div className="msg-meta">
                  {message.role === "engineer" ? "工程师" : "ForgePilot"} · {new Date(message.at).toLocaleString("zh-CN", { hour12: false })}
                  {message.meta?.thinkingChars ? ` · 思考 ${message.meta.thinkingChars} 字` : ""}
                </div>
                <div className="msg-body"><RichText text={message.content} /></div>
                {message.meta?.tools?.length ? (
                  <div className="trace-tools">
                    {message.meta.tools.map((tool) => (
                      <span className={`tool-chip ${tool.isError ? "fail" : "ok"}`} title={tool.summary} key={tool.toolCallId}>
                        {tool.isError ? "✗" : "✓"} {tool.toolName}
                        {tool.durationMs !== undefined ? ` · ${tool.durationMs}ms` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            {streaming ? (
              <div className="msg assistant streaming">
                <div className="msg-meta">ForgePilot · 正在回答</div>
                {thinking ? (
                  <div className="thinking-box">
                    <div className="trace-label">思考过程</div>
                    <pre className="thinking-text">{thinking}</pre>
                  </div>
                ) : null}
                {tools.length ? (
                  <div className="tool-traces">
                    {tools.map((tool) => (
                      <span className={`tool-chip ${tool.durationMs !== undefined ? (tool.isError ? "fail" : "ok") : "running"}`} title={tool.summary} key={tool.toolCallId}>
                        {tool.durationMs === undefined ? "◌" : tool.isError ? "✗" : "✓"} {tool.toolName}
                        {tool.durationMs !== undefined ? ` · ${tool.durationMs}ms` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="msg-body"><RichText text={messages.find((message) => message.id === streamingId)?.content ?? ""} /></div>
              </div>
            ) : null}
            {error ? <div className="empty-small error">{error}</div> : null}
          </div>

          <button
            className="scroll-bottom"
            hidden={!showScroll}
            onClick={() => {
              autoScroll.current = true;
              listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
            }}
          >
            ↓ 最新消息
          </button>

          <div className="composer">
            <textarea
              rows={3}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="问点具体的：为什么用 Math.ceil？这个改动会影响非整除场景吗？"
              disabled={!canChat || streaming}
            />
            <div className="composer-actions">
              <span className="hint">固定上下文：任务概览 + diff + 验证证据；仓库代码按需只读检索</span>
              <div className="composer-buttons">
                <button className="warn" disabled={!canReview || streaming} onClick={() => void requestChanges()}>要求修改</button>
                <button className="ghost" disabled={!canReview || streaming} onClick={() => void approve()}>通过</button>
                <button className="ghost" onClick={onOpenDiff}>查看 Diff</button>
                <button className="primary" disabled={!canChat || streaming || !input.trim()} onClick={() => void send()}>
                  {streaming ? "回答中…" : "发送"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
