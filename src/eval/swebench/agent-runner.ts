import type { ModelContext } from "../../agent/session.js";
import { runPiStageAgent } from "../../agent/session.js";
import { ContextAssembler } from "../../context/assembler.js";
import { STAGE_TOOLS } from "../../domain/stages.js";
import type { Stage } from "../../domain/types.js";
import type { AgentRunner, AgentRunOutput, SwebenchArm, SwebenchInstance } from "./types.js";

const BASE_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "apply_patch",
  "run_verification",
  "record_hypothesis",
  "record_evidence",
  "get_task_status",
];

const ENHANCED_TOOLS = [...BASE_TOOLS, "search_codebase"];

export class PiSweAgentRunner implements AgentRunner {
  readonly name = "pi-agent";

  constructor(
    private readonly models: ModelContext,
    private readonly onContextMetrics?: Parameters<typeof runPiStageAgent>[0]["onContextMetrics"],
  ) {}

  async run(input: { instance: SwebenchInstance; arm: SwebenchArm; runtime: import("../../harness/runtime.js").TaskRuntime }): Promise<AgentRunOutput> {
    const { instance, arm, runtime } = input;
    const allowedTools = arm === "enhanced" ? ENHANCED_TOOLS : BASE_TOOLS;
    const assembler = new ContextAssembler(runtime.stores.artifacts);
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCalls = 0;
    let wallClockMs = 0;
    let finalText = "";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = buildPrompt(instance, arm, attempt);
      const result = await runPiStageAgent({
        runtime,
        stage: "REPAIR" as Stage,
        prompt,
        allowedTools: allowedTools.length ? allowedTools : STAGE_TOOLS.REPAIR,
        assembler,
        models: this.models,
        onContextMetrics: this.onContextMetrics,
      });
      inputTokens += result.usage.input;
      outputTokens += result.usage.output;
      toolCalls += result.toolCalls;
      wallClockMs += result.wallClockMs;
      finalText = result.finalText || finalText;

      const diff = await runtime.currentDiff();
      if (diff.diff.trim()) break;
      if (attempt === 0) {
        await runtime.event("swebench_nudge", { reason: "no patch produced" });
      }
    }

    return { inputTokens, outputTokens, toolCalls, wallClockMs, finalText };
  }
}

function buildPrompt(instance: SwebenchInstance, arm: SwebenchArm, attempt: number): string {
  return [
    `<swebench_instance id="${instance.instance_id}" arm="${arm}">`,
    "You are solving a repository-level bug. The problem statement is the only task description you get.",
    "Hidden tests and the reference patch are NOT available and must not be searched for.",
    "",
    "<problem_statement>",
    instance.problem_statement,
    "</problem_statement>",
    "",
    "Rules:",
    "- Read the relevant code before changing it. Use apply_patch with exact unique oldText.",
    "- Never modify tests, hidden evaluation files or verification configuration.",
    "- You may run the configured visible test command with run_verification(kind=test).",
    "- Make the minimal root-cause fix; do not add unrelated refactors.",
    "- When you believe the patch is correct, end with a short summary. The harness will run hidden tests afterwards.",
    arm === "enhanced"
      ? "- A function-level code retrieval tool (search_codebase) is available. Use it when locating code, but still read the files before patching."
      : "- Search with grep/find/read; no function-level retrieval index is available in this arm.",
    attempt > 0
      ? "- Previous attempt produced no workspace diff. You must call apply_patch this time."
      : "",
    "</swebench_instance>",
  ]
    .filter(Boolean)
    .join("\n");
}

export class ScriptedAgentRunner implements AgentRunner {
  readonly name = "scripted-agent";

  constructor(private readonly script: (input: { instance: SwebenchInstance; arm: SwebenchArm; runtime: import("../../harness/runtime.js").TaskRuntime }) => Promise<void> | void) {}

  async run(input: { instance: SwebenchInstance; arm: SwebenchArm; runtime: import("../../harness/runtime.js").TaskRuntime }): Promise<AgentRunOutput> {
    await this.script(input);
    return {
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      wallClockMs: 0,
      finalText: "scripted",
    };
  }
}
