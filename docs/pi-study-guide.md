# ForgePilot × pi-agent 学习手册

> 目标：不是“看完”，而是能独立回答“pi 在这一层负责什么、为什么这样接、出了问题去哪查”。
> 适合按「读一小节 → 跑一个实验 → 用自己的话回答」的节奏使用。

---

## 0. 怎么用这份文档

### 0.1 三遍法

| 遍数 | 目标 | 做什么 | 预计 |
| --- | --- | --- | --- |
| 第一遍 | 建立地图 | 跑通 demo、看 UI、看日志，不深究代码 | 30–45 分钟 |
| 第二遍 | 读懂主链路 | 按第 4 节顺序读 8 个核心文件 | 2–3 小时 |
| 第三遍 | 能改能讲 | 做第 6 节实验，回答第 8 节自测题 | 3–5 小时 |

不要从 `src/` 第一个文件开始顺序读。先跑，再读，最后改。

### 0.2 每一节的学习产出

每读完一个模块，至少要能回答三件事：

1. 这个模块解决什么问题？
2. 它依赖 pi 的哪个 API/事件？
3. 如果去掉它，系统会坏在哪？

### 0.3 学习时始终打开的两个目录

```text
D:\workfile\forgepilot\                 # 项目代码
C:\Users\EDY\.pi\agent\skills\dg-piagent\   # pi SDK skill 文档
```

pi 包本体：

```text
C:\Users\EDY\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent
```

项目使用的版本是 **1.4.0**，不要直接升 latest。

---

## 1. 先建立心智模型

### 1.1 一张图

```text
┌────────────────────────── 控制面（平台层，自己写） ──────────────────────────┐
│ CLI / Web API / 任务列表 / 审批 / 取消                                      │
│ Task 状态机：PREPARE → REPRODUCE → REPAIR → VERIFY → PACKAGE → PUBLISH → DONE │
│ 持久化：Task / Checkpoint / ToolOperation / Verification / Lease / Artifact   │
│ 评估：Review Precision/Recall、SWE-bench 双臂对照                            │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ 一个阶段 = 一个 pi session
┌──────────────────────────────────▼───────────────────────────────────────────┐
│ 执行面（pi Agent Runtime）                                                   │
│ createAgentSession → 模型/工具循环 → 事件流 → session 生命周期               │
│ 工具：read/grep/find/ls + apply_patch/run_verification/...                   │
│ 扩展：before_agent_start / context / tool_call / tool_result / agent_settled │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 一句话分工

> **pi 负责“模型 → 工具 → 模型”的执行循环、流式事件、工具定义和会话生命周期；ForgePilot 负责阶段状态机、权限门禁、上下文策略、持久化恢复、PR 交付和评估。**

### 1.3 最重要的边界

| 问题 | 谁回答 |
| --- | --- |
| 当前在哪个阶段？允许调用什么工具？ | Harness |
| 下一步读哪个文件、怎么改？ | Agent（pi loop） |
| 测试是否通过？ | 可信命令 + Harness |
| 是否允许交付？ | 人工审批 |
| PR 是否已创建？ | 外部查询 + 幂等键 |
| 会话历史是否等于任务状态？ | 不等于；任务状态在 Task/Checkpoint |

---

## 2. 环境与基线

```bash
cd D:/workfile/forgepilot
npm install
npm test
npm run build
```

预期：

- `npm test`：22 个测试通过；
- `npm run build`：通过；
- 本机已配置 pi 模型（默认 `dsh/deepseek-v4.1-flash`）。

先跑一遍主流程：

```bash
npm run demo:review-chat
```

观察输出里的：

- issue 信息；
- `PACKAGE / WAITING_APPROVAL`；
- 两轮审核问答；
- patchHash；
- 最终 PR 和 `DONE / DELIVERED`。

再打开 UI：

```bash
npm run ui
# http://127.0.0.1:4310
```

---

## 3. pi 功能地图

| pi 能力 | 项目落点 | 你要理解什么 | 对应实验 |
| --- | --- | --- | --- |
| `createAgentSession` | `src/agent/session.ts` | 组装 model / tools / resourceLoader / sessionManager | Lab 1 |
| `DefaultResourceLoader` | `src/agent/session.ts` | 替换 system prompt、关闭默认资源、注入 extension | Lab 1 |
| `SessionManager.inMemory` | `src/agent/session.ts` | pi 会话不负责业务持久化 | Lab 4 |
| `session.prompt` | `src/agent/session.ts` | 一个阶段如何驱动 Agent | Lab 1 |
| `session.subscribe` | `src/agent/session.ts` | text/thinking/tool/usage/结束事件 | Lab 2 |
| `session.abort` | `src/agent/session.ts` | 超时/取消如何收敛 | Lab 4 |
| `defineTool` + `typebox` | `src/agent/tools/index.ts` | 自定义工具的参数校验与结果契约 | Lab 3 |
| `tool_call` 扩展钩子 | `src/agent/extension.ts` | 阶段/路径/预算门禁 | Lab 3 |
| `context` 扩展钩子 | `src/agent/extension.ts` + `src/context/assembler.ts` | 每次 LLM 调用前重写上下文 | Lab 5 |
| `tool_result` 扩展钩子 | `src/agent/extension.ts` | 大输出外置为 artifact | Lab 5 |
| `agent_settled` | `src/agent/session.ts` + `extension.ts` | 可靠结束信号 | Lab 2 |
| `ModelRuntime` | `src/agent/session.ts`、`src/eval/review/judge.ts` | 模型/认证/独立 Judge | Lab 6 |
| `AssistantMessageEvent` | `src/agent/ui-events.ts` | thinking/text delta 的 UI 传输 | Lab 2 |
| `ToolExecution*Event` | `src/agent/ui-events.ts` | 工具开始/更新/结束的 UI trace | Lab 2 |

---

## 4. 阅读路线（按依赖顺序）

### 4.1 第一遍：跑通并看事件（30–45 分钟）

1. `npm run demo:review-chat`
2. `npm run ui`，打开任务，点“评审对话”，问两个问题
3. 看事件日志：

```bash
TASK=<taskId>
tail -n 100 .forgepilot/tasks/$TASK/events.jsonl
cat .forgepilot/tasks/$TASK/review-chat.jsonl
```

重点找：

- `agent_settled` 的 `aborted` 是 true 还是 false；
- `tool_call` / `verification` / `changes_requested` / `approved` / `pr_created`；
- 对话消息里的 `meta.tools` 和 `thinkingChars`。

### 4.2 第二遍：精读 8 个文件

按顺序：

| 顺序 | 文件 | 先找什么 |
| --- | --- | --- |
| 1 | `src/agent/session.ts` | `createModelContext`、`runPiStageAgent` |
| 2 | `src/agent/extension.ts` | 5 个 `pi.on` 钩子 |
| 3 | `src/agent/tools/index.ts` | 14 个 `defineTool` 工具 |
| 4 | `src/harness/orchestrator.ts` | `run`、`runRepair`、`requestChanges` |
| 5 | `src/harness/runtime.ts` | `applyChanges`、`runVerification`、`createPr`、`recover` |
| 6 | `src/context/assembler.ts` | `assemble` 的裁剪顺序 |
| 7 | `src/store/*` | Task/Operation/Lease/Verification/Checkpoint |
| 8 | `src/review/service.ts` + `src/web/server.ts` | Review Chat 和 SSE |

### 4.3 第三遍：改一处并做实验

至少完成第 6 节的 Lab 1、2、4、5。每做完一个，写一句话：

> 我改了 ____，pi 的事件/工具/状态因此 ____，从日志里看到 ____。

---

## 5. 逐模块精读

## 5.1 Session 组装

**文件**：`src/agent/session.ts`

**先看函数**：

- `createModelContext`
- `runPiStageAgent`

**关键代码路径**：

```text
ModelRuntime.create
  → getAvailable
  → DefaultResourceLoader({ systemPromptOverride, noContextFiles, noSkills, extensionFactories })
  → loader.reload()
  → createAgentSession({ cwd, model, modelRuntime, resourceLoader, sessionManager, customTools, tools })
  → session.subscribe(...)
  → session.prompt(...)
  → session.dispose()
```

**必须理解**：

1. 为什么不复用 pi 的会话文件？
   - 业务状态需要 Task/Checkpoint/Artifact，聊天记录不足以恢复工作区、租约和在途操作。
2. 为什么一个阶段一个 session？
   - 阶段边界可以重建上下文，避免历史无限增长。
3. `modelFallbackMessage` 为什么要处理？
   - 创建成功不等于模型可用，回退/缺 key 要提前暴露。
4. `tools` 白名单和 `customTools` 的关系？
   - `tools` 是最终激活名单；自定义工具名也必须列入，否则静默失效。

**自测**：

- 如果去掉 `loader.reload()` 会怎样？
- 如果传了 `resourceLoader` 但不传 `extensionFactories`，`context` 钩子还会执行吗？

---

## 5.2 工具系统

**文件**：`src/agent/tools/index.ts`

**分三类**：

1. 内置只读：`read / grep / find / ls`
2. 永久禁用：`bash / powershell / edit / write`
3. 自定义：`apply_patch / run_verification / create_pr / get_change_summary / ...`

**为什么不用 bash？**

- bash 能绕过阶段权限、验证命令和路径保护；
- 自定义工具可以做结构化参数、路径校验、制品记录和幂等键。

**必须理解**：

- `defineTool` 是 no-op 包装，但保留 TypeBox 类型推断；
- `content` 给模型看，`details` 给程序/UI 看；
- 工具 `throw` 会被 pi 转成 `isError` 结果，不会让进程崩；
- `apply_patch` 为什么要求 `oldText` 唯一？
  - 避免错改；失败信息要让模型能自我修复；
- `run_verification` 为什么只接受 `kind`，不接受任意命令？
  - 命令来自可信项目配置，模型不能自己拼 shell。

**自测**：

- 为什么 `tools: ["read"]` 会禁用所有未列出的 customTools？
- 如果 `apply_patch` 的 `oldText` 出现两次，应该怎么改提示词/工具行为？

---

## 5.3 扩展钩子 vs subscribe 事件

**文件**：`src/agent/extension.ts`、`src/agent/session.ts`

这是最容易混的一层。记住：

| 事件 | `pi.on` 扩展层 | `session.subscribe` |
| --- | --- | --- |
| `context` | ✅ | ❌ |
| `tool_call` | ✅ | ❌ |
| `tool_result` | ✅ | ❌ |
| `before_agent_start` | ✅ | ❌ |
| `message_update` | ✅ | ✅ |
| `tool_execution_*` | ✅ | ✅ |
| `agent_settled` | ✅ | ✅ |

**项目里的用法**：

- `before_agent_start`：按阶段注入 system prompt；
- `context`：每次 LLM 调用前做分层压缩；
- `tool_call`：阶段白名单、生命周期、取消、路径、预算；
- `tool_result`：大输出外置；
- `agent_settled`：可靠结束信号；
- `session.subscribe`：转发 text/thinking/tool/usage 到 CLI/SSE。

**自测**：

- 为什么 `session.subscribe("tool_call")` 收不到？——它是扩展独有事件。
- 为什么 `context` 里返回的 messages 不包括 system？——pi 在 handler 后自行恢复 prompt 和工具声明。

---

## 5.4 分层上下文

**文件**：`src/context/assembler.ts`

**组装顺序**：

```text
固定约束 → 结构化状态 <forgepilot_state> → 历史摘要
→ 近期完整交互（tool_call ↔ tool_result 配对）
→ 按需 artifact 引用
```

**关键不变量**：

1. 目标/验收/约束是结构化字段，不经过摘要模型；
2. 事实必须有引用，假设不能写成事实；
3. 不切断工具调用与结果；
4. 大输出外置，原文可重新读取；
5. 压缩只改请求，不改持久化历史；
6. 超预算才裁剪，短上下文不强行摘要。

**看代码顺序**：

1. `assemble()` 的预算计算；
2. `findRecentWindow` 如何避免从 toolResult 中间开始；
3. `maybeOffload` 如何写 artifact；
4. `renderDigest` 如何保留证据引用；
5. `sanitizeToolPairs` 如何去掉孤儿结果。

**context_metrics 不是账单**：

- `beforeTokens / afterTokens` 是请求上下文的估算大小；
- `after > before` 可能只是状态块开销，不代表新增计费；
- 实际计费看 `message_end.usage` / `Task.metrics`；
- `summarizedMessages / offloadedToolOutputs / droppedMessages` 才表示本轮做了压缩动作。

**自测**：

- 为什么“只有摘要”不够？
- 如果 recent window 起点是 toolResult，会发生什么？
- 压缩后如何重新读取完整测试日志？

---

## 5.5 可靠执行

**文件**：`src/harness/runtime.ts`、`src/store/*`

**四张核心记录**：

| 记录 | 作用 |
| --- | --- |
| Task | 阶段、生命周期、版本、预算、取消、租约 |
| Checkpoint | 阶段边界、HEAD、patchHash、在途操作、上下文状态 |
| ToolOperation | 语义操作键、输入指纹、状态、结果 |
| Verification | patchHash + 环境指纹 + 命令 + 退出码 + artifact |

**幂等键**：

```text
sha256(taskId | opType | target | inputHash | version)
```

不要用 `tool_call_id`：模型重新生成请求时 id 会变。

**恢复顺序**：

```text
取租约 → 核对工作区 → 处理 pending/unknown 操作
→ 校验 patch 指纹 → 从下一安全动作继续
```

**故障注入**：

- `afterPatch`：补丁已写、操作未完成；
- `afterTestRecord`：测试已记录、阶段未推进；
- `afterPrCreate`：PR 已创建、响应丢失。

**自测**：

- 锁过期能否立即接管？为什么不能？
- PR 创建超时后应该先做什么？
- 测试通过后又改了一行，验证还算数吗？

---

## 5.6 Review Chat

**文件**：`src/review/service.ts`、`src/review/prompt.ts`

**只读工具**：

```text
read / grep / find / ls / read_artifact / get_change_summary / get_task_status / get_pr_status
```

**固定上下文**：

```text
ticket / expected / issue
patchHash / changed files / diffStat / rationale
diff 摘录
verification 命令、exitCode、keyOutput、artifact
PR 状态
未解决 feedback
最近 16 条对话
```

**仓库上下文策略**：

- 不整仓注入；
- 需要时用 `read/grep/find/ls` 只读检索；
- 没读过的代码不能当事实；
- 全量日志用 `read_artifact`。

**“要求修改”流程**：

```text
写 feedback → 清空旧 changePackage → stage=REPAIR
→ Agent 必须产生新 patchHash → 重新 VERIFY → 重新 PACKAGE
→ 未解决 feedback 阻止 approve/publish
```

**超时**：

- Review Chat 使用独立 180s wall clock；
- 不继承任务剩余的 `maxWallClockMs`，否则旧任务会在 10s 后 abort；
- 空回答时先查 `agent_settled.aborted`。

**自测**：

- 为什么审核对话不能直接用 `apply_patch`？
- 为什么“要求修改”必须换 patchHash 才算回应？
- 为什么聊天 token 不计入修复预算？

---

## 5.7 Web / SSE / 弹窗

**文件**：`src/web/server.ts`、`web/src/*`

**接口**：

| 路由 | 作用 |
| --- | --- |
| `GET /api/issues` | issue fixture |
| `POST /api/tasks` | 创建任务并后台执行 |
| `GET /api/tasks/:id` | task + diff + verification + events + chat |
| `POST /api/tasks/:id/chat` | SSE 流式回答 |
| `POST /api/tasks/:id/approve` | 审批并发布 |
| `POST /api/tasks/:id/request-changes` | 退回 REPAIR |
| `POST /api/tasks/:id/cancel` | 取消并收敛 |

**SSE 事件**：

```text
start / thinking_start / thinking_delta / thinking_end
tool_start / tool_update / tool_end
delta / done / error
```

**UI 细节**：

- 多路由 React 工作台：Task Console、任务详情、Diff/证据、完整审计；阶段卡片内嵌该阶段 Runtime log；
- 评审对话是弹窗，可关闭/打开、Esc、点遮罩关闭；
- 顶部操作栏 sticky；
- 聊天向上阅读时不被轮询/流式 token 拉回底部；
- 靠近底部才自动跟随，另有“↓ 最新消息”。

**自测**：

- 为什么 `session.subscribe` 能收到 `tool_execution_*`，却收不到 `tool_call`？
- SSE 为什么要过滤 `text_delta`，避免和 `delta` 重复？

---

## 5.8 两套评估

### Review 评估

**文件**：`src/eval/review/*`

```text
发现规范化 → 同根因去重 → 文件+区间候选
→ 独立 Judge（启发式/LLM）→ 一对一匹配
→ TP/FP/FN/未决 → Precision/Recall/归因
```

要点：

- 行号只生成候选，不证明语义；
- 一条泛化发现不能命中多个缺陷；
- 同位置不同根因判不同；
- 新发现先仲裁，不直接算 FP；
- 未决数量单独报告。

### SWE-bench 评估

**文件**：`src/eval/swebench/*`

```text
固定实例 → baseline / 检索增强双臂
→ 同一模型/环境/预算
→ Agent 结束后才应用隐藏测试
→ F2P 全过 + P2P 不退化 + patch 非空 = resolved
→ 成本/Token/工具调用/失败分类
```

要点：

- 答案 patch、隐藏测试、F2P/P2P 不进入生成输入；
- 空补丁/环境错误/测试失败/P2P 退化分别计数；
- 本地 verifier 不是官方排行榜。

---

## 6. 动手实验

### Lab 1：改系统提示词与工具白名单

1. 在 `src/agent/prompt.ts` 加一条规则：“回答必须带文件路径”；
2. 运行 `npm run demo:review-chat`，观察回答是否引用路径；
3. 在 `src/domain/stages.ts` 把 `read` 从某阶段移除；
4. 观察 `tool_call` 如何 block。

**学到**：system prompt 与工具白名单是两层控制，不是一回事。

### Lab 2：观察 thinking / tool 事件

```bash
npm run dev -- chat <taskId> --message "请读取 src/pagination.js 并解释第 16 行"
```

- 思考/工具 trace 在 stderr；
- 加 `--no-trace` 关闭；
- 打开 `FORGEPILOT_DEBUG_EVENTS=1` 看 pi 原始事件类型。

**学到**：`message_update.assistantMessageEvent` 与 `tool_execution_*` 的区别。

### Lab 3：新增一个只读工具

在 `src/agent/tools/index.ts` 加：

```text
list_changed_files → 返回当前 changedFiles
```

把它加入 Review Chat 的 `REVIEW_TOOLS`，在 UI 里问“这次改了哪些文件”。

**学到**：`defineTool`、TypeBox schema、工具白名单、`details` 与 `content` 的区别。

### Lab 3.5：事件中心 → 仓库定位 → 方案

```bash
npm run demo:incident
```

观察：

- `INGEST` 只读取 incident，不猜仓库；
- `RESOLVE` 从 `fixtures/event-center/projects.json` 取授权映射；
- `PLAN` 只读，调用 `record_plan` 产出结构化方案；
- `REPAIR` 读取 Plan 后改码。

**学到**：流程控制是 Harness，pi 只执行 PLAN/REPAIR 阶段的 Agent 循环。

### Lab 4：故障注入与恢复

```bash
npm run demo:fault
```

然后看：

```bash
TASK=<taskId>
tail -n 100 .forgepilot/tasks/$TASK/events.jsonl
ls .forgepilot/tasks/$TASK/operations
cat .forgepilot/tasks/$TASK/operations/*.json
```

**学到**：PR 已创建但响应丢失时，如何按 task marker 查询而不是重复创建。

### Lab 5：上下文压缩

1. 把 `ContextAssembler` 的 `budgetTokens` 临时调小；
2. 跑一个长对话；
3. 看 `context_metrics` 的 `summarizedMessages / offloadedToolOutputs / preservedToolPairs`；
4. 确认 `tests/context.test.ts` 的不变量仍然成立。

**学到**：预算驱动、工具配对、artifact 回读。

### Lab 6：Review 评估

```bash
npm run demo:review
npm run demo:review -- --llm
```

对比 `run-a` / `run-b` 的 Precision/Recall 和 FP/FN 归因。

**学到**：候选匹配与语义 Judge 是两层，不是“行号相同就算命中”。

### Lab 7：SWE-bench 双臂

```bash
npm run demo:swebench -- --limit 1
```

看报告里的：

- baseline / enhanced 的 resolved；
- 平均 Token、工具调用、耗时；
- 失败分类。

**学到**：固定预算、隐藏测试后置、F2P/P2P 判定。

### Lab 8：要求修改闭环

```bash
npm run demo:review-changes
```

观察：

- feedback 写入；
- 旧 changePackage 清空；
- 新 patchHash；
- 重新 VERIFY/PACKAGE；
- 未解决 feedback 阻止 approve。

---

## 7. 调试手册

| 现象 | 优先检查 | 常见原因 |
| --- | --- | --- |
| `No model selected` | `~/.pi/agent/auth.json`、`models.json` | 没配 key / 模型不可用 |
| 有回答但没 thinking | 模型是否 return reasoning | Provider/模型不支持 thinking |
| 工具没显示 | `tool_execution_start` 是否触发 | 工具被 block / 未列入白名单 |
| `Tool ... is not available` | `STAGE_TOOLS` / `tools` | 阶段白名单没包含 |
| 空回答 | `events.jsonl` 的 `agent_settled.aborted` | session 被 timeout abort |
| 一直重复创建 PR | operations 状态 / PR 查询 | 幂等键或恢复逻辑问题 |
| `Executor no longer holds a valid lease` | `leaseEpoch` / heartbeat | 租约过期或被接管 |
| 测试通过但 package 失败 | patchHash / verification fingerprint | 验证结果不是当前 patch |
| 聊天滚回底部 | 轮询是否重渲染 | 已修复；检查是否旧静态文件缓存 |
| UI 操作栏消失 | `.action-bar` sticky | 浏览器缓存旧 CSS |

常用命令：

```bash
TASK=<taskId>

tail -n 100 .forgepilot/tasks/$TASK/events.jsonl
cat .forgepilot/tasks/$TASK/review-chat.jsonl
cat .forgepilot/tasks/$TASK/verifications.jsonl
cat .forgepilot/tasks/$TASK/checkpoints/latest.json
ls .forgepilot/tasks/$TASK/operations
```

调试开关：

```bash
FORGEPILOT_DEBUG_EVENTS=1 npm run dev -- chat $TASK --message "..."
FORGEPILOT_DEBUG_LEASE=1 npm run demo:fault
```

---

## 8. 自测题

先自己回答，再看括号里的关键词。

1. pi 在这个项目里负责哪四件事？
   （模型工具循环、流式事件、工具定义、会话生命周期）
2. 为什么不用 pi 的会话文件做业务持久化？
   （聊天记录 ≠ 工作区/阶段/预算/在途操作）
3. `context` 和 `message_update` 分别属于哪一层？
   （扩展独有 vs 双层订阅）
4. 为什么 `tool_call` 的权限检查不能只依赖工具白名单？
   （状态、取消、路径、预算、参数都要重新校验）
5. 为什么 `apply_patch` 要求 oldText 唯一？
   （防止错改；错误信息可自我修复）
6. 上下文压缩为什么不能只生成一条摘要？
   （约束/状态/证据引用/工具配对会丢）
7. 压缩后完整测试日志去哪了？
   （artifact，按 id 读取）
8. 为什么 Review Chat 不能直接改码？
   （审核角色只读；改码要走“要求修改”回 REPAIR）
9. 为什么“要求修改”必须产生新 patchHash？
   （防止口头答应但代码没改；旧验证不能复用）
10. 为什么 Review Chat 有独立 180s 超时？
    （旧任务 elapsed 会把 session 在 10s 后 abort）
11. 为什么 PR 创建超时不能直接重试？
    （先按 task marker 查询，避免重复创建）
12. 租约过期能否立即接管？
    （不能；要核对旧进程与在途外部操作）
13. 测试通过后又改一行，验证还有效吗？
    （无效；patchHash/指纹变化）
14. Review 评估中行号匹配能直接算 TP 吗？
    （不能；行号只生成候选，语义由 Judge/人工确认）
15. SWE-bench 为什么不用 Judge 判补丁？
    （用独立可执行测试判定）
16. 为什么 SWE-bench 隐藏测试要后置？
    （防止 Agent 看到答案/测试）
17. 为什么工具结果要放 `details` 而不是 `content`？
    （`content` 进模型上下文，`details` 给程序/UI）
18. 为什么阶段切换要新建 session？
    （避免历史无限增长；结构化状态恢复）
19. 取消任务后已创建的 PR 要不要删除？
    （不自动删除；保留并展示，人工处理）
20. 如果换掉 pi，平台层哪些协议仍然成立？
    （Task/阶段/权限/幂等/验证/评估/审批）

---

## 9. 面试口述模板

### 9.1 一分钟版本

> ForgePilot 不是让模型直接接管研发流程，而是把 Bug 修复放进可控闭环。底层用 pi 的 Agent Runtime 做模型—工具循环和流式事件；平台层自己实现阶段状态机、工具权限、上下文分层压缩、检查点/幂等键/租约、PR 交付和两套评估。修复完成后工程师可以在工作台里和 Agent 对话，问它为什么这样改；要求修改会回到 REPAIR 并重新验证，未解决意见不能审批。

### 9.2 三分钟版本（按这条线讲）

1. 问题：Bug 从工单到 PR，不只是改代码；
2. 分工：pi 只做执行循环，平台做状态/权限/证据；
3. 上下文：预算驱动、结构化状态、artifact 回读；
4. 可靠：检查点、幂等键、租约、外部结果核对；
5. 审核：只读对话 + 要求修改 + 审批门禁；
6. 评估：Review P/R + SWE-bench 双臂；
7. 边界：本地适配器/生产化清单，不夸大规模数字。

### 9.3 不要说的话

- “pi 帮我做了状态机/持久化/评估”——这些是平台层。
- “SWE-bench 分数代表公司 Bug 效率”——不能跨结论。
- “对话可以改代码”——审核对话只读。
- “PR 创建等于合并/上线”——不等于。
- “500+ / 71 / 178→53 是代码跑出来的”——这是业务口径。

---

## 10. 术语表

| 术语 | 含义 |
| --- | --- |
| Harness | 平台层编排器：阶段、权限、预算、验证、审批 |
| Agent Loop | pi 的模型—工具循环 |
| Extension | `pi.on` 钩子，能拦截/改写 Agent 行为 |
| Subscribe | `session.subscribe` 外部只读事件流 |
| Artifact | 内容寻址的完整日志/补丁/工具输出 |
| Checkpoint | 阶段边界的安全恢复点 |
| Operation | 带语义幂等键的副作用记录 |
| Lease | 执行权：owner + epoch + 过期时间 |
| Fingerprint | patchHash + baseCommit + env + command 的组合 |
| TP/FP/FN | Review 评估的真阳性/假阳性/假阴性 |
| F2P/P2P | SWE-bench 的失败转通过 / 保持通过测试 |

---

## 11. 学习进度表

```text
[ ] 跑通 npm test / npm run build
[ ] 跑通 demo:review-chat
[ ] 打开 UI，完成一次弹窗对话
[ ] 看懂 events.jsonl 的 agent_settled / tool_call / verification
[ ] 读完 session.ts
[ ] 读完 extension.ts
[ ] 读完 tools/index.ts
[ ] 读完 orchestrator.ts 的 runRepair
[ ] 读完 runtime.ts 的 applyChanges / recover
[ ] 读完 context/assembler.ts
[ ] 做完 Lab 1（prompt/白名单）
[ ] 做完 Lab 2（thinking/tool 事件）
[ ] 做完 Lab 3（新增工具）
[ ] 做完 Lab 4（故障注入）
[ ] 做完 Lab 5（上下文预算）
[ ] 做完 Lab 6（Review 评估）
[ ] 做完 Lab 7（SWE-bench）
[ ] 做完 Lab 8（要求修改）
[ ] 能不看文档回答第 8 节 20 题
[ ] 能三分钟口述项目
```

---

## 12. 下一步建议

按性价比排序：

1. 先把 Lab 1–5 做完，理解执行链路；
2. 再读 `src/eval/review` 和 `src/eval/swebench`，理解评估口径；
3. 最后再考虑 React 工作台、真实 GitHub/GitLab 适配器、Docker 沙箱。

不要一开始就改 UI 或接真实外部系统；先把“状态、工具、上下文、证据”四件事跑通。
