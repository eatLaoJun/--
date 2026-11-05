import type { ModelContext } from "../agent/session.js";
import { runPiStageAgent } from "../agent/session.js";
import { ContextAssembler } from "../context/assembler.js";
import { TaskRuntime } from "../harness/runtime.js";
import type { HarnessStores } from "../harness/stores.js";
import type { ReviewMessage } from "../store/review-chat-store.js";
import { GitWorkspace } from "../integrations/git.js";
import { buildReviewPrompt, buildReviewSystemPrompt } from "./prompt.js";
import { truncate } from "../utils/text.js";
import type { Stage } from "../domain/types.js";
import type { AgentStreamEvent, ToolTrace } from "../agent/ui-events.js";

export const REVIEW_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "read_artifact",
  "get_change_summary",
  "get_task_status",
  "get_pr_status",
];

export class ReviewChatService {
  constructor(
    private readonly stores: HarnessStores,
    private readonly models: ModelContext,
  ) {}

  async history(taskId: string): Promise<ReviewMessage[]> {
    return this.stores.reviewChat.list(taskId);
  }

  async ask(
    taskId: string,
    question: string,
    onDelta?: (delta: string) => void,
    onStreamEvent?: (event: AgentStreamEvent) => void,
    stage?: string,
  ): Promise<{ answer: string; history: ReviewMessage[] }> {
    const task = await this.stores.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.cancelRequested || task.lifecycle === "CANCELLED") {
      throw new Error(`Task ${taskId} is cancelled`);
    }
    if (!stage && !["WAITING_APPROVAL", "WAITING_INPUT", "PAUSED", "FAILED", "DELIVERED"].includes(task.lifecycle)) {
      throw new Error(
        "Review chat is available after the patch is packaged (WAITING_APPROVAL) or delivered. " +
          "The task is currently " + task.lifecycle + ".",
      );
    }
    const trimmed = question.trim();
    if (!trimmed) throw new Error("Question must not be empty");

    const history = await this.stores.reviewChat.list(taskId);
    await this.stores.reviewChat.append({ taskId, role: "engineer", content: trimmed, meta: { stage } });

    const diff = await this.loadDiff(task);
    const verification = (await this.stores.verifications.list(taskId))
      .slice()
      .reverse()
      .find((record) => record.kind === "test");
    const prompt = buildReviewPrompt({ task, history, question: trimmed, diff, verification, stage });
    const runtime = new TaskRuntime({
      stores: this.stores,
      task,
      workspace: new GitWorkspace(task.workspacePath ?? process.cwd()),
    });
    const assembler = new ContextAssembler(this.stores.artifacts);
    const tools: ToolTrace[] = [];
    let thinkingChars = 0;

    try {
      const result = await runPiStageAgent({
        runtime,
        stage: (stage ?? task.stage) as Stage,
        prompt,
        allowedTools: REVIEW_TOOLS,
        assembler,
        models: this.models,
        systemPromptText: buildReviewSystemPrompt(task, stage),
        allowWaiting: true,
        countAgainstBudget: false,
        // Review chat is not part of the execution budget; give it a separate timeout
        // so an old task's elapsed time cannot abort a long review answer.
        wallClockMs: 180_000,
        recordAttempt: false,
        onText: onDelta,
        onStreamEvent: (event) => {
          if (event.type === "tool_end") {
            tools.push({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              isError: event.isError,
              durationMs: event.durationMs,
              summary: event.summary,
            });
          }
          if (event.type === "thinking_delta") thinkingChars += event.text.length;
          onStreamEvent?.(event);
        },
      });
      const answer = result.finalText.trim() || "（Agent 未返回内容，请重试或查看任务事件。）";
      await this.stores.reviewChat.append({
        taskId,
        role: "assistant",
        content: answer,
        meta: {
          model: this.models.name,
          patchHash: task.changePackage?.patchHash ?? task.patchHash,
          stage,
          tools,
          thinkingChars,
        },
      });
      return { answer, history: await this.stores.reviewChat.list(taskId) };
    } catch (err) {
      const message = `（回答失败：${(err as Error).message}）`;
      await this.stores.reviewChat.append({ taskId, role: "system", content: message });
      throw err;
    }
  }

  private async loadDiff(task: NonNullable<Awaited<ReturnType<HarnessStores["tasks"]["get"]>>>): Promise<string> {
    if (!task.workspacePath) return "";
    if (task.changePackage?.patchArtifactId) {
      try {
        return await this.stores.artifacts.get(task.changePackage.patchArtifactId);
      } catch {
        // fall through to workspace diff
      }
    }
    const workspace = new GitWorkspace(task.workspacePath!);
    if (task.baseCommit) workspace.setBase(task.baseCommit);
    return truncate(await workspace.diff(), 20_000);
  }
}
