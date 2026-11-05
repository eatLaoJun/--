# ForgePilot

面向研发 Bug 修复与 PR Review 的可运行 Agent 参考实现。

这个仓库把简历里的四条技术亮点落成了代码：**状态驱动的修复—验证—交付闭环、预算驱动的分层上下文、可恢复的长任务执行、两套离线评估**。它不是一个只有 Prompt 的 Demo，也不是对 500+ 工程师生产部署的复刻；真实部署的工单/GitLab/沙箱在这里用可替换的本地适配器表示。

## 1. 快速开始

要求：Node.js ≥ 22，已配置 pi 的模型认证（本机默认 `dsh/deepseek-v4.1-flash`）。

```bash
cd D:/workfile/forgepilot
npm install
npm test              # 22 个确定性测试，不调用模型
npm run ui            # Web 工作台：http://127.0.0.1:4310
npm run demo:incident # 事件中心 Bug → 仓库定位 → 方案 → 改码 → 验证 → PR
npm run demo:fix      # 真实模型跑一次 Bug 修复 → 测试 → 审批 → 分支/PR
npm run demo:fault    # 故障注入：PR 已创建但响应丢失，恢复后不重复创建
npm run demo:review-chat    # GitHub issue → 修复 → 审核对话 → 通过 → PR
npm run demo:review-changes # 审核时要求修改 → 回到 REPAIR → 重新验证 → 再审批
npm run demo:review   # PR Review 离线评估（启发式 Judge）
npm run demo:review -- --llm   # 独立 LLM Judge
npm run demo:swebench -- --limit 2  # baseline / 检索增强双臂对照
```

指定模型：

```bash
FORGEPILOT_MODEL=dsh/deepseek-v4.1-pro npm run demo:fix
```

## 2. 它解决了什么

一个 Bug 从事件中心到交付，不只是“让模型改几行代码”：

```text
事件中心 Bug / 工单
  → INGEST      读取事件、来源校验、去重
  → RESOLVE     service → 授权仓库 → base branch → 可信命令
  → PLAN        读代码，产出根因假设、方案、测试计划、风险
  → REPAIR      按方案做最小 patch
  → VERIFY      复现/测试/构建，证据绑定代码指纹
  → PACKAGE     变更包 + 人工审批
  → PUBLISH     推送分支 + 创建/核对 PR
  → 人工审核与合并
```

Harness 决定“当前允许进入哪个阶段、能调用什么工具”，模型只在当前阶段内做决策。改码、验证、发布都不靠模型自述成功。

当前 M1 主链路：

```text
INGEST → RESOLVE → PLAN → REPAIR → VERIFY → PACKAGE → PUBLISH → DONE
```

旧的 ticket 流程 `PREPARE → REPRODUCE → REPAIR ...` 仍保留用于兼容历史任务。事件中心入口不会让模型猜仓库：仓库映射来自 `fixtures/event-center/projects.json` 的可信配置。

生命周期单独管理：

```text
QUEUED / RUNNING / WAITING_INPUT / WAITING_APPROVAL /
PAUSED / CANCELLING / CANCELLED / FAILED / DELIVERED
```

## 3. 审核对话与 Web 工作台

修复完成后任务进入 `PACKAGE / WAITING_APPROVAL`。工程师可以在工作台里直接和 Agent 对话，问：

- 为什么用 `Math.ceil` 而不是保留 `floor + 1`？
- 非整除、`total=0`、非法入参会不会受影响？
- 你验证了什么？给出测试证据和代码位置。
- 这个改动还有哪些残留风险？

实现是**只读 Review Chat**：

- 工具白名单只有 `read/grep/find/ls/read_artifact/get_change_summary/get_task_status/get_pr_status`；
- 不能改码、改测试、推分支或创建 PR；
- 回答必须引用当前 diff、验证记录、`file:line` 或 artifact；
- **固定上下文**：完整任务时间线、任务概览、方案、变更包、diff、全部验证证据、PR、未解决 feedback、最近对话；
- **一个全局“评审对话”按钮**，不再为每个阶段单独放问 AI；仓库代码按需只读检索；
- **Runtime log 内嵌在阶段卡片里**：展开某个阶段即可看到该阶段的 `task_created`/`incident_ingested`/`repository_resolved`/`plan_recorded`/工具调用/验证事件；完整全局视图仍在“完整审计”页；
- **仓库不整仓注入**：需要时用 `read/grep/find/ls` 只读检索，避免 token 浪费、陈旧代码和无关文件干扰；没有读过的代码不能当作事实；
- 对话历史和 patch 指纹一起持久化在 `tasks/<id>/review-chat.jsonl`；
- 对话是弹窗形式，可随时打开/关闭；关闭不会中断正在生成回答，完成后可重新打开查看；
- **展示 pi 的思考与工具事件**：`thinking_start/delta/end` 流式显示“思考过程”，`tool_execution_start/update/end` 显示工具名、参数摘要、耗时和结果；每轮回答保存工具 trace 摘要；
- 思考过程是否出现取决于模型/Provider 是否返回 reasoning 事件；没有 reasoning 的模型只显示文本和工具；
- 审核对话的 Token 计入 metrics，但不消耗修复阶段的 Token/工具调用预算，避免“问几个问题就没预算改码”。

工作台还支持：

- **通过并创建 PR**：人工审批后 Harness 推送分支、创建/核对 PR；
- **要求修改**：把对话输入作为审核意见写回任务，清空旧变更包，回到 `REPAIR`，重新验证、重新打包；未解决意见会阻止审批；
- **取消任务**：进入 `CANCELLING`，abort 当前执行并核对在途操作。

启动：

```bash
npm run ui
# 浏览器打开 http://127.0.0.1:4310
```

左侧从事件中心 / GitHub issue 创建任务，任意阶段都可以点击右上角“评审对话”打开弹窗提问；对话上下文是整条任务时间线 + 验证证据，仓库代码按需只读读取。弹窗支持关闭、Esc、点击遮罩关闭，也可以直接在里面“要求修改”或“通过”。

当前是多页面 React 工作台（Vite + React Router + SSE），不是单页 tab：

| 路由 | 页面 |
| --- | --- |
| `/` | Task Console 任务台：阶段/生命周期/失败筛选、搜索、统计 |
| `/tasks/:id` | 任务详情：概览、sticky 操作栏、评审对话弹窗 |
| `/tasks/:id/diff` | Diff / 变更证据：patch、文件、验证记录、artifact |
| `/tasks/:id/timeline` | Runtime log / 审计时间线：整体阶段时间线（可收放）+ 每阶段内嵌日志 + 完整事件流筛选/原始事件 |

开发模式：后端 `npm run dev -- serve --port 4310`，前端 `npm run web:dev`（Vite 5173 代理 `/api`）。

### GitHub issue 输入

本地演示：

```bash
npm run dev -- fix --issue fixtures/github/issue-101.json
```

真实 URL（需要 `GITHUB_TOKEN`，并在 `fixtures/github/projects.json` 配置仓库到授权模板/可信命令的映射）：

```bash
npm run dev -- fix --issue https://github.com/example/course-service/issues/101
```

Issue 文本只作为任务资料，不能决定仓库、命令或权限；仓库映射和验证命令来自可信项目配置。

## 4. 四条亮点的代码落点

| 简历亮点 | 实现位置 | 关键机制 |
| --- | --- | --- |
| 上下文管理与压缩 | `src/context/assembler.ts`、`src/agent/extension.ts` | 每次 LLM 调用前在扩展 `context` 钩子重组消息：固定约束 → 结构化状态 → 近期完整交互 → 历史摘要 → 按需制品。工具输出超限外置为 sha256 制品，保留 `artifact:<id>` 引用；tool_call/tool_result 配对不被切断；stage 边界重建 session。 |
| PR Review 效果评估 | `src/eval/review/` | 发现规范化/同根因去重 → 文件+区间生成候选 → 独立 Judge（启发式或真实 LLM）→ 一对一匹配 → 争议项仲裁 → Precision/Recall/误报漏报归因/策略回放。 |
| 长任务可靠执行 | `src/store/`、`src/harness/runtime.ts` | 持久化 Task/Checkpoint/ToolOperation/Verification/Lease；语义幂等键（任务+操作+目标+输入+版本）；租约 epoch；重试预算；未知结果先查外部资源；测试指纹绑定补丁；取消后收敛。 |
| SWE-bench 修复评估 | `src/eval/swebench/` | 固定实例、固定模型/环境/预算；baseline 与函数级检索增强双臂；答案 patch 与隐藏测试只在评估端；按 FAIL_TO_PASS / PASS_TO_PASS 判定，输出解决率、Token、工具调用、耗时和失败分类。 |

### 上下文分层

```text
<forgepilot_state>  ← 目标/约束/阶段/base_commit/已确认事实+引用/假设/尝试/预算
<forgepilot_history_digest> ← 较早交互的结论与证据引用（不是事实本身）
近期完整消息（含 tool_call ↔ tool_result）
按需 artifact（完整日志/补丁，用 read_artifact 读取）
```

触发条件是预算，不是固定轮次。压缩只改发给模型的请求，不改持久化会话；原始工具输出不会因为摘要而丢失。

### 可靠执行

| 记录 | 作用 |
| --- | --- |
| `Task` | 阶段、生命周期、版本、预算、取消标记、租约 |
| `Checkpoint` | 阶段边界、工作区 HEAD、patchHash、已完成/在途操作、上下文状态 |
| `ToolOperation` | 语义操作键、输入指纹、尝试次数、状态、结果/制品 |
| `Verification` | 补丁指纹、环境指纹、命令、退出码、日志制品 |
| `Lease` | owner + 单调 epoch + 过期时间；锁过期≠旧进程已停 |

故障注入覆盖三个关键位置：

- `afterPatch`：补丁已落盘、结果未记录；
- `afterTestRecord`：测试已记录、阶段未推进；
- `afterPrCreate`：PR 已创建、响应丢失。

恢复逻辑先核对工作区 diff / 测试记录 / PR 外部记录，再决定完成或重试，不会盲目重放副作用。

### Review 评估口径

- `TP`：经 Judge/人工确认且唯一匹配的发现；
- `FP`：不成立、超出范围或错误诊断的发现；
- `FN`：标签集中存在但未正确报告的缺陷；
- `Precision = TP/(TP+FP)`，`Recall = TP/(TP+FN)`；分母为 0 输出 `N/A`；
- 未决项单独报告，不直接算 FP；
- 一到多、多到一均被一对一匹配阻断；
- 同一位置但根因不同（例如“缺 tenant 隔离” vs “缺 TTL”）不会被行号匹配强行判为 TP。

Demo 中 `run-a` 得到 `TP=3, FP=1, FN=1, Undecided=1, P=0.750, R=0.750`；`run-b` 得到 `P=1.000, R=1.000`。这是固定 fixture 的演示结果，不是生产评测成绩。

### SWE-bench 评估口径

- 生成阶段只给 problem statement 和固定 base commit，不给参考 patch / 隐藏测试 / F2P/P2P 字段；
- 隐藏测试在 Agent 结束后才应用到工作区；
- 只有 F2P 全过且 P2P 不退化且补丁非空才算 resolved；
- 空补丁、无法应用、环境错误、测试失败、P2P 退化分别计数；
- 成本包含成功与失败尝试，报告平均输入/输出 Token、工具调用、墙钟时间；
- 本地 verifier 与官方 SWE-bench Docker Harness 接口兼容，但本仓库跑出的数字不是官方排行榜结果。

## 5. 学习路线

第一次接触这个项目，建议按 [docs/pi-study-guide.md](docs/pi-study-guide.md) 学习：先跑通 demo，再按依赖顺序读 8 个核心文件，最后做故障注入、上下文压缩、Review 评估和要求修改实验。相比直接顺序读代码，这条路线把「读代码 → 跑实验 → 回答问题」串起来了。

后续计划见 [docs/roadmap-m2-m5.md](docs/roadmap-m2-m5.md)：M1 已完成，M2–M5 只保存方案，不代表已实现。

## 6. 目录

```text
src/
  agent/           pi SDK 会话、系统提示词、扩展钩子、业务工具
  context/         分层上下文组装
  domain/          阶段/生命周期/预算/数据模型
  harness/         编排器、运行时、恢复/幂等/发布
  integrations/    Git、PR、GitHub issue、事件中心、项目绑定、验证命令
  review/          只读审核对话（prompt + service）
  store/           Task/Artifact/Operation/Checkpoint/Verification/Lease/Event/ReviewChat
  eval/review/     Review 评估
  eval/swebench/   SWE-bench 双臂评估
  web/             React 工作台（Vite + React Router + SSE）
  cli.ts
fixtures/          示例仓库、事件中心 incident、项目绑定、GitHub issue、工单、Review 标签、SWE-bench 实例
scripts/           demo 脚本
tests/             确定性测试
docs/design.md     详细设计
docs/demo-evidence.md  本地真实运行证据与口径
docs/pi-study-guide.md  pi × ForgePilot 学习手册（阅读路线 + 实验 + 自测）
docs/roadmap-m2-m5.md    M2–M5 路线图（审核/合并、事件中心、生产化、评估）
```

## 7. 与 pi-agent SDK 的关系

- 运行时固定 `@earendil-works/pi-coding-agent@1.4.0`（skill 基线版本）。
- 系统提示词完全替换 pi 默认人设；`noSkills/noContextFiles` 关闭无关注入。
- 扩展层 `pi.on` 使用 `context` / `before_agent_start` / `tool_call` / `tool_result` / `agent_settled`。这些事件 `session.subscribe` 收不到。
- 工具白名单按阶段设置；`bash/powershell/edit/write` 永久禁用，改码只走 `apply_patch`。
- 业务持久化用 `SessionManager.inMemory()` + 自己的 TaskStore/Checkpoint，不依赖 pi 的会话目录。
- 结束信号使用 `agent_settled`，不是 `agent_end`。
- 事件类型直接复用 pi 的 `AssistantMessageEvent`、`ToolExecutionStart/Update/EndEvent`、`AgentSessionEvent`；`src/agent/ui-events.ts` 只是 UI/SSE 传输适配器（裁剪字段、序列化参数、摘要工具结果），不是重写 pi 的 stream。
- Review Chat 使用独立 180s wall clock；不会因为任务本身的旧 `elapsed` 已耗尽而在 10s 后 abort。
- 一个阶段一个 session；跨阶段恢复靠结构化状态与制品，不靠聊天记录。

## 8. 真实与模拟边界

**真实执行**

- 真实 Git 仓库/提交/分支/工作区；
- 真实测试、构建、复现命令；
- 真实模型调用与 Token 统计；
- 真实 LLM Judge（`--llm`）；
- 真实审核对话（Review Chat，只读工具 + SSE 流式）；
- 真实本地 SWE-bench 风格的隐藏测试判定。

**本地适配器（面试时可替换为生产实现）**

- 工单/事件中心：本地 JSON（`fixtures/event-center/`、`fixtures/tickets/`、`fixtures/github/`），可替换为内部事件中心/Jira/云效/GitHub API 适配器；
- 代码托管：本地 PR 记录（`local://pr/...`），可替换为 GitLab/Codeup API；
- 工作区：模板复制 + git init，可替换为 `git worktree` / 容器沙箱（已保留 `prepareExistingRepoWorktree`）；
- 存储：文件 + 原子写 + sha256 制品，可替换为 Postgres + 对象存储；
- 评估：本地 verifier，可替换为官方 SWE-bench Docker Harness。

## 9. 已知限制

- Web 工作台是 React + Vite + SSE；旧的 `src/web/static` 仅作为未构建时的 fallback。
- 思考过程来自 Provider 的 reasoning 事件；不同模型可能只返回工具/文本，或对思考内容做脱敏。
- 审核对话是只读的；要求改码必须走“要求修改”回退 REPAIR，不能在对话里直接 patch。
- 没有 Docker/容器级隔离；真实部署应把执行面放进一次性沙箱。
- 文件存储在单机并发下可用，跨节点需要数据库 CAS/租约。
- 隐藏测试的本地 verifier 是简化版；官方 SWE-bench 需要 Docker harness 与数据集 revision 固定。
- 代码是 TS 运行时。简历里的 Python/React 控制面可以作为后续包装层；本仓库不声称它是生产控制面。
- 简历中的 500+ 工程师、71 个 Bug、178→53 分钟是业务口径；本仓库只产出机制与可回放证据，不复现这些业务数字。

## 10. 测试

```bash
npm test
```

覆盖：

- Task CAS、租约 epoch、操作幂等；
- 审核对话持久化、只读 prompt 上下文、要求修改回退、审批门禁、Review 预算隔离；
- pi thinking/tool 事件摘要与 SSE 事件协议；
- 上下文预算压缩、约束保留、工具配对完整、制品回读；
- Review 一对一匹配、P/R、未决项、回放对比；
- 补丁落盘后崩溃恢复、PR 响应丢失恢复、验证指纹失效；
- `git diff` 指纹跨 commit 稳定、changedFiles 路径正确；
- SWE-bench 双臂执行、隐藏测试后置、空补丁不判 resolved；
- 事件中心 incident → INGEST/RESOLVE/PLAN 任务、项目绑定、整体流程时间线、全局评审对话（整条时间线上下文 + 仓库按需读取）、React 路由、任务筛选、事件时间线 API、SPA fallback。

## 11. 面试一句话

> ForgePilot 不是让模型直接接管研发流程，而是把 Bug 修复放进可控闭环：固定代码版本，由 Agent 定位和改码，由 Harness 验证、绑定证据、等待人工审批，再交付带验证记录的 PR。技术上重点解决长上下文不丢约束、任务中断不重复副作用，以及用两套离线评估分别检验 Review 质量和修复效果。
