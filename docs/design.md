# ForgePilot 设计说明

本文说明代码里的真实实现，不重复简历文案。重点是：为什么这样分层、每个阶段由谁决策、哪些证据落盘、哪些地方仍然需要生产化。

## 1. 控制面 / 执行面

当前仓库是单进程可运行实现，但模块边界按控制面/执行面拆开：

```text
控制面（可替换为 Python 服务）
  CLI / API / 队列 / 阶段状态机 / 预算 / 审批 / 任务查询
        │  任务 id + 租约
执行面（本仓库）
  TaskRuntime + pi AgentSession + 工具 + 工作区 + 制品
        │
  .forgepilot/
    tasks/<id>.json                  Task + TaskState + 预算 + PR
    tasks/<id>/checkpoints/          阶段边界检查点
    tasks/<id>/operations/           语义操作记录
    tasks/<id>/verifications.jsonl   验证记录（指纹绑定）
    tasks/<id>/events.jsonl          事件轨迹
    artifacts/<sha256>               完整日志/补丁/工具输出
    workspaces/<taskId>/             独立 git 工作区
    prs/                             本地 PR 适配器
```

真实部署时，控制面不跑 Node；执行面一个任务一个沙箱，Agent 运行时只在沙箱里。当前代码把两者放在同一进程，是为了可运行和可测试，不改变数据契约。

## 2. 阶段状态机

```text
PREPARE → REPRODUCE → REPAIR → VERIFY → PACKAGE → PUBLISH → DONE
             ↑______________________|
                  验证失败回到 REPAIR
```

生命周期与阶段正交：

```text
QUEUED → RUNNING → WAITING_APPROVAL → RUNNING → DELIVERED
                 ↘ WAITING_INPUT / PAUSED / CANCELLING → CANCELLED / FAILED
```

关键约束：

| 约束 | 实现 |
| --- | --- |
| 分类/意图不是写权限 | 阶段工具白名单 + 每次 `tool_call` 重新校验状态/权限 |
| 验证绑定代码 | `Verification.patchHash + baseCommit + envFingerprint + command` |
| 审批绑定变更包 | `ChangePackage.patchHash + verificationId` |
| 发布前重新核对 | `publishBranch` 检查当前 patchHash == 已审批 patchHash |
| 取消收敛 | `CANCELLING` → abort 当前 session → reconcile 在途操作 → `CANCELLED` |
| 过期执行器不能覆盖新状态 | Task 版本 CAS + 租约 epoch + 每次工具调用 reload 取消标记 |

## 3. Harness 与 Agent 的分工

| 决策 | 谁做 | 为什么 |
| --- | --- | --- |
| 当前阶段 | Harness | 确定性状态机，不让模型自选阶段 |
| 当前可调用工具 | Harness | 阶段白名单，改码/发布分开授权 |
| 根因假设、读哪些文件、怎么改 | Agent | 需要语义推理 |
| 补丁是否可应用 | Tool + Harness | 精确字符串匹配、唯一性、保护路径 |
| 测试是否通过 | 可信命令 + Harness | 不让模型自述成功 |
| 是否允许交付 | 人工审批 | 变更包 + 代码指纹 |
| PR 是否已存在 | 外部查询 + 幂等键 | 响应丢失时先核对，不重复创建 |

只有 REPAIR 阶段需要模型做主要决策。PREPARE/REPRODUCE/VERIFY/PACKAGE/PUBLISH 的通过条件由 Harness 确定性判定；模型可以在这些阶段被调用来解释/检查，但不能绕过门禁。

## 4. 分层上下文

### 4.1 组装顺序

每次 LLM 调用前，扩展 `context` 钩子拿到 `AgentMessage[]`，返回重写后的请求：

```text
1. 固定约束（system prompt）：人设、阶段目标、工具、禁止事项
2. 结构化状态 <forgepilot_state>：
   - 目标/验收/约束/base_commit/branch
   - 已确认事实（必须带 file:line / test id / artifact id）
   - 假设（open/confirmed/rejected，不与事实混写）
   - 最近尝试、剩余预算、patchHash
3. 历史摘要 <forgepilot_history_digest>：
   - 较早 user/assistant/toolResult 的结论、失败原因、证据引用
4. 近期完整交互：
   - 保留 assistant toolCall 与 toolResult 的配对
5. 按需制品：
   - 完整日志/补丁外置，模型用 read_artifact 读取
```

### 4.2 预算与裁剪

- 预算 = `contextWindow - maxTokens - reserve`；
- 状态块最多 25%（上限 6000 token），历史摘要最多 20%（上限 5000 token），其余给近期交互；
- 超预算时：先缩摘要 → 再把近期窗口前移（按完整工具调用组）→ 最后压缩最大工具结果；
- 不按消息时间硬截断；不从 toolResult 中间开始窗口；
- 压缩只影响本次请求，不修改持久化历史；
- 内置 compaction 只作为 overflow 兜底，不承担结构化状态保存。

### 4.3 为什么摘要不够

摘要是有损的自然语言，容易把“假设”写成“事实”、丢掉验收条件。代码里的做法是：

- 目标/约束/验收是**结构化字段**，每次重新渲染，不经过摘要模型；
- 事实必须有引用，假设单独存储；
- 原始证据在制品里，按 id 重新读取；
- 同一任务换阶段时新建 session，避免历史无限增长。

## 5. 可靠执行

### 5.1 语义幂等键

```text
opKey = sha256(
  taskId | opType | target | inputHash | version
)
```

- 不使用 `tool_call_id`：模型重新生成请求时 id 会变；
- `apply_patch` 的 inputHash 是 changes 的稳定哈希；
- `publish_branch` 的 input 是 patchHash + baseCommit + branch；
- `create_pr` 的 input 是 patchHash + headCommit + branch；
- 输入变化就产生新操作版本，不能复用旧结果。

### 5.2 操作状态机

```text
pending → done
        ↘ unknown（结果不确定，先核对）
        ↘ failed（可重试，受尝试次数约束）
```

`begin()` 遇到 `pending/unknown` 会抛 `OperationInFlightError`，要求先 reconcile；遇到 `done` 直接 replay。

### 5.3 恢复顺序

```text
1. 加载 Task、取消标记、预算、最后检查点
2. 取得租约（epoch 递增）
3. 核对工作区 HEAD / patchHash / 环境
4. 处理 pending/unknown 操作：
   - apply_patch：工作区 diff 与记录一致 → done；不一致 → failed
   - publish_branch：仓库干净且 HEAD 可读 → done
   - create_pr：按 task marker 查询外部 PR → 关联；查不到 → failed
5. 校验验证指纹：patch 变了 → 变更包失效，回到 VERIFY
6. 从下一安全动作继续
```

### 5.4 租约与取消

- 租约记录 `owner + epoch + expiresAt`；
- epoch 单调递增，release 不清零；
- 锁过期不等于旧进程已停：接管前仍要核对在途外部操作；
- 取消先进入 `CANCELLING`，abort 当前 session，再 reconcile，最后 `CANCELLED`；
- 已创建的分支/PR 保留，不自动回滚外部效果。

## 6. PR Review 评估

```text
评审发现
  → 规范化（文件、old/new 侧、区间）
  → 同根因去重
  → 候选生成（同文件 + 区间重叠/邻近）
  → 独立 Judge（语义：同一错误行为/条件/根因）
  → 一对一贪心匹配
  → 未决项进入人工仲裁
  → TP/FP/FN、Precision/Recall、FP 占比、根因归类
```

Judge 接口：

- `HeuristicJudge`：文本 Jaccard + 区间重叠 + 根因匹配，用于确定性测试；
- `LlmJudge`：通过 `ModelRuntime.complete` 独立调用，固定提示词、`temperature=0`，失败时回退启发式并标注。

关键防作弊点：

- 行号只用于生成候选，不作为语义证据；
- 一条泛化发现不能命中多个缺陷；
- 同一位置不同根因（tenant scope vs TTL）判为不同；
- 新发现先仲裁，不直接算 FP；
- 未决数量单独报告；
- 标签集版本固定，策略回放用同一版本重算。

## 7. SWE-bench 本地评估

### 7.1 数据与隔离

实例字段：

```json
{
  "instance_id": "...",
  "repo_template": "...",
  "problem_statement": "...",
  "hidden_tests": [{"path": ".eval/hidden.mjs", "source": "fixtures/.../hidden.mjs"}],
  "test_command": "node .eval/hidden.mjs",
  "fail_to_pass": ["..."],
  "pass_to_pass": ["..."],
  "commands": {"test": "node --test"},
  "max_tokens": 60000,
  "max_tool_calls": 20,
  "max_wall_clock_ms": 300000
}
```

隔离规则：

- 生成阶段只给 `problem_statement`；
- hidden tests 在 Agent 结束后才写入工作区；
- baseline 验证在独立副本上跑，避免 Agent 看到 `.eval`；
- F2P 必须在 baseline 失败，P2P 必须在 baseline 通过，否则实例判为 harness_error；
- 参考 patch 永远不进入生成上下文。

### 7.2 双臂对照

| 组 | 工具 |
| --- | --- |
| baseline | read / grep / find / ls / apply_patch / run_verification |
| enhanced | baseline + `search_codebase`（函数/类级检索） |

固定：模型、环境、实例清单、每实例 Token/工具调用/时间预算。增强组不获得额外答案或人工定位提示。

### 7.3 判定与成本

- `resolved = patch 非空 && F2P 全过 && P2P 不退化`；
- 空补丁、环境错误、测试失败、P2P 退化、预算超限分别计数；
- 报告 `resolved/N`、平均输入/输出 Token、工具调用、墙钟时间；
- 本地 verifier 与官方 Docker Harness 接口兼容，但结果不是官方排行榜。

## 8. 审核对话与 Web 工作台

### 8.1 对话发生在哪个阶段

```text
REPAIR → VERIFY → PACKAGE / WAITING_APPROVAL
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
   审核对话（只读）                 要求修改
          │                             │
          ▼                             ▼
   通过 → PUBLISH → DONE          REPAIR → VERIFY → PACKAGE
```

对话不是自由聊天，而是“对已打包 patch 的评审问答”。任务必须处于 `WAITING_APPROVAL`、`WAITING_INPUT`、`PAUSED`、`FAILED` 或 `DELIVERED` 才允许提问，避免和正在执行的 REPAIR 竞争同一工作区。

### 8.2 只读 Review Chat

| 约束 | 实现 |
| --- | --- |
| 不能改码 | 工具白名单只有 `read/grep/find/ls/read_artifact/get_change_summary/get_task_status/get_pr_status` |
| 必须引用证据 | 系统提示词要求从 diff、验证记录、`file:line`、artifact 回答 |
| 不碰外部状态 | 没有 `apply_patch/publish_branch/create_pr` |
| 上下文可追溯 | 每轮注入 ticket、patchHash、changed files、verification key output、diff 摘录、PR、未解决 feedback、最近 16 条对话 |
| 仓库上下文 | 不整仓注入；通过 `read/grep/find/ls` 按需只读检索，未读代码不能当事实 |
| 可审计 | 对话追加到 `tasks/<id>/review-chat.jsonl`，带角色、时间、模型、patchHash |
| 过程可见 | `thinking_start/delta/end` 与 `tool_execution_start/update/end` 通过 SSE 推给工作台；回答结束后持久化工具 trace 摘要 |
| 预算隔离 | 对话 usage 进入 metrics，但不增加 `budget.tokensUsed/toolCallsUsed`，避免耗尽修复预算 |
| 独立超时 | Review Chat 用 180s wall clock，不复用任务的剩余执行时间；避免旧任务 elapsed 让 session 在 10s 后 abort |

`get_change_summary` 是可复用的只读工具：返回当前 patch、diffStat、验证记录、PR 和未解决 feedback，保证回答不是靠模型记忆。

事件层：pi 提供 `AssistantMessageEvent`（provider 级 thinking/text/toolcall delta）和 `AgentSessionEvent`（`tool_execution_*` 等 loop 事件），两者形状不同且包含 partial/usage 等大字段。`src/agent/ui-events.ts` 用 pi 类型做输入，映射成稳定的 UI/SSE 契约，不重新实现流式解析。

### 8.3 “要求修改”闭环

1. 工程师在对话框输入意见并点“要求修改”；
2. 写入 `HumanFeedback { message, priorPatchHash, requestedAt }`；
3. 清空 `changePackage`，阶段回到 `REPAIR`，生命周期 `RUNNING`；
4. REPAIR Agent 的提示词与结构化状态都包含未解决 feedback；
5. 只有产生**新的 patchHash** 才算回应了意见；patch 未变会 nudge，超预算进入 `WAITING_INPUT`；
6. 新 patch 重新 VERIFY、重新 PACKAGE；
7. `package/approve/publish` 都会拒绝未解决 feedback。

这条规则避免“口头答应但代码没改”，也避免把旧验证结果套到新 patch 上。

### 8.4 Web 工作台

`src/web/server.ts` 用 Node HTTP 提供 API 和 SPA fallback；`web/` 是 Vite + React Router 工作台，SSE 用于流式回答。

| 路由 | 作用 |
| --- | --- |
| `GET /api/issues` | 列出 GitHub issue fixture |
| `GET /api/tasks` | 任务列表（状态、patch、PR、是否执行中） |
| `POST /api/tasks` | 从 issue/ticket 创建任务并后台执行 |
| `GET /api/tasks/:id` | task + diff + verifications + events + review chat |
| `POST /api/tasks/:id/chat` | SSE 流式审核对话 |
| `POST /api/tasks/:id/approve` | 审批并后台发布 |
| `POST /api/tasks/:id/request-changes` | 写回意见并回到 REPAIR |
| `POST /api/tasks/:id/cancel` | 取消并收敛 |

页面结构（多路由，不是单页 tab）：`/` Task Console（阶段/生命周期/失败筛选、搜索）、`/tasks/:id` 概览与审批、`/tasks/:id/diff` 变更与验证证据、`/tasks/:id/timeline` Runtime log/审计时间线。点击“评审对话”打开可关闭弹窗（Esc/遮罩/×），显示固定上下文 chips、聊天记录、thinking/tool trace、输入框和“要求修改/通过/发送”。轮询只刷新状态，SSE 只负责流式回答。

### 8.5 GitHub issue 适配器

- 本地 fixture：`fixtures/github/issue-101.json`，包含 issue 元数据和 ticket 配置；
- 真实 URL：`GITHUB_TOKEN` + GitHub REST API；仓库到授权模板/命令的映射来自 `fixtures/github/projects.json`；
- issue 文本只作为任务资料，不能扩大权限、选择仓库或改验证命令；
- 没有 token 时明确报错并提示使用本地 fixture，不静默降级成伪造 issue。

### 8.6 仍然保留的人工边界

- 对话不能替代审批：approve 是独立动作；
- 对话不能直接改码：要求改码必须走“要求修改”；
- 交付后仍保留人工评审/合并，PR 创建不等于合并；
- 当前工作台绑定 `127.0.0.1`，没有鉴权/多租户；生产需接企业 SSO、权限与审计。

## 9. pi-agent SDK 使用要点

| 点 | 代码 |
| --- | --- |
| 创建会话 | `createAgentSession({ cwd, model, modelRuntime, resourceLoader, sessionManager, customTools, tools })` |
| 系统提示词 | `DefaultResourceLoader.systemPromptOverride` + 扩展 `before_agent_start` |
| 资源隔离 | `noContextFiles: true`、`noSkills: true`、`noPromptTemplates: true` |
| 扩展注入 | `extensionFactories: [createHarnessExtension(...)]`，然后 `await loader.reload()` |
| 上下文重写 | `pi.on("context", ...)`（subscribe 收不到） |
| 工具门禁 | `pi.on("tool_call", ...)` 返回 `{ block, reason }` |
| 工具输出外置 | `pi.on("tool_result", ...)` |
| 结束信号 | `pi.on("agent_settled", ...)`，不用 `agent_end` |
| 业务持久化 | `SessionManager.inMemory()` + 自己的 store |
| Token 统计 | `message_end.usage` |
| 工具耗时 | `tool_execution_end.durationMs` |

## 10. 取舍与生产化清单

| 当前 | 生产建议 |
| --- | --- |
| 文件存储 + 原子写 | Postgres 存 Task/Operation/Checkpoint；对象存储存制品 |
| 同进程执行 | 一任务一沙箱；控制面/执行面分离 |
| 本地 PR 适配器 | GitLab/Codeup API + webhook + 去重/核对 |
| 模板复制工作区 | `git worktree` + 容器 + 受限网络/凭据 |
| 本地隐藏测试 verifier | 官方 SWE-bench Docker Harness + 数据集 revision 固定 |
| 启发式 Judge 默认 | LLM Judge + 人工抽检/仲裁 + 标签版本管理 |
| CLI 报告 | React 工作台 + 实时事件流（`session.subscribe` → SSE） |

## 11. 面试追问的落点

- **为什么不用通用 Coding Agent 就结束？** 复用改码能力，补项目配置、权限、验证、可审核交付和可回放评估。
- **只有摘要为什么不够？** 摘要会丢约束/状态；结构化字段 + 证据引用 + 原始制品才能恢复。
- **保存会话能不能恢复任务？** 不能；还要恢复工作区、阶段、预算、在途操作和外部资源状态。
- **PR 超时怎么办？** 先按 task marker/分支查询，确认已创建就关联，不重复创建。
- **锁过期能不能立即接管？** 不能；接管前核对旧进程与在途外部操作。
- **测试通过后又改了一行？** 指纹失效，回 VERIFY，重新验证/审批。
- **为什么 SWE-bench 不用 Judge 判补丁？** 用独立可执行测试判定，Judge 只做语义辅助。
