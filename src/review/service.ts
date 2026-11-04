import type { ModelContext } from "../agent/session.js";
import { runPiStageAgent } from "../agent/session.js";
import { ContextAssembler } from "../context/assembler.js";
import { TaskRuntime } from "../harness/runtime.js";
import type { HarnessStores } from "../harness/stores.js";
import type { ReviewMessage } from "../store/review-chat-store.js";
import { GitWorkspace } from "../integrations/git.js";
import { buildReviewPrompt, buildReviewSystemPrompt } from "./prompt.js";
import { truncate } from "../utils/text.js";

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
  ): Promise<{ answer: string; history: ReviewMessage[] }> {
    const task = await this.stores.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!task.workspacePath) throw new Error(`Task ${taskId} has no workspace`);
    if (task.cancelRequested || task.lifecycle === "CANCELLED") {
      throw new Error(`Task ${taskId} is cancelled`);
    }
    if (!["WAITING_APPROVAL", "WAITING_INPUT", "PAUSED", "FAILED", "DELIVERED"].includes(task.lifecycle)) {
      throw new Error(
        "Review chat is available after the patch is packaged (WAITING_APPROVAL) or delivered. " +
          "The task is currently " + task.lifecycle + ".",
      );
    }
    const trimmed = question.trim();
    if (!trimmed) throw new Error("Question must not be empty");

    const history = await this.stores.reviewChat.list(taskId);
    await this.stores.reviewChat.append({ taskId, role: "engineer", content: trimmed });

    const diff = await this.loadDiff(task);
    const verification = (await this.stores.verifications.list(taskId))
      .slice()
      .reverse()
      .find((record) => record.kind === "test");
    const prompt = buildReviewPrompt({ task, history, question: trimmed, diff, verification });
    const runtime = new TaskRuntime({
      stores: this.stores,
      task,
      workspace: new GitWorkspace(task.workspacePath),
    });
    const assembler = new ContextAssembler(this.stores.artifacts);

    try {
      const result = await runPiStageAgent({
        runtime,
        stage: "PACKAGE",
        prompt,
        allowedTools: REVIEW_TOOLS,
        assembler,
        models: this.models,
        systemPromptText: buildReviewSystemPrompt(task),
        allowWaiting: true,
        countAgainstBudget: false,
        recordAttempt: false,
        onText: onDelta,
      });
      const answer = result.finalText.trim() || "（Agent 未返回内容，请重试或查看任务事件。）";
      await this.stores.reviewChat.append({
        taskId,
        role: "assistant",
        content: answer,
        meta: { model: this.models.name, patchHash: task.changePackage?.patchHash ?? task.patchHash },
      });
      return { answer, history: await this.stores.reviewChat.list(taskId) };
    } catch (err) {
      const message = `（回答失败：${(err as Error).message}）`;
      await this.stores.reviewChat.append({ taskId, role: "system", content: message });
      throw err;
    }
  }

  private async loadDiff(task: NonNullable<Awaited<ReturnType<HarnessStores["tasks"]["get"]>>>): Promise<string> {
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
