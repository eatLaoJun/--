# ForgePilot × pi 面试作战卡

> 目标：**6–8 小时准备，3 分钟讲清，10 个追问不崩。**
>
> 原则：不背功能清单，讲边界、取舍、失败和证据。
> 不把 demo 说成生产，不把 PR 创建说成上线，不把业务数字说成代码跑出来的。

---

## 1. 一句话定位

> ForgePilot 不是让模型直接接管研发流程，而是把 Bug 修复放进可控闭环：**pi 负责执行面的模型—工具循环，平台负责阶段、权限、持久化、上下文、评估和交付。**

这句话要能脱口而出。

---

## 2. 三分钟口述模板

### 0:00–0:30 问题与定位

> 我做的不是“让 AI 自动改代码”的 Demo，而是一个从事件中心 Bug 到 PR 的可控修复闭环。核心问题是：模型可以参与决策，但不能自己宣布成功。所以我把系统拆成执行面和控制面：执行面用 pi 跑模型—工具循环，控制面由平台自己实现阶段状态机、工具权限、证据和审批。

### 0:30–1:30 主链路

> 入口是事件中心 incident 或 GitHub issue。INGEST 只读事件、做来源校验；RESOLVE 从可信配置把 service 映射到授权仓库，不让模型猜仓库；PLAN 只读代码，产出结构化的根因假设、方案、测试计划和风险；REPAIR 只允许 `apply_patch` 做最小改动；VERIFY 用可信命令跑复现/测试/构建，并把结果绑定到当前 patchHash；PACKAGE 生成变更包等待人工审批；PUBLISH 推送分支并创建或核对 PR。底层 pi 负责每个阶段的模型—工具循环和流式事件。

### 1:30–2:20 三个关键设计

> 第一，**一个阶段一个 in-memory session**。pi 的聊天记录不作为业务状态，跨阶段靠 Task、Checkpoint、Artifact 恢复，避免历史无限增长。
>
> 第二，**工具不是建议，是硬门禁**。每个阶段有工具白名单，`bash/edit/write` 永久禁用，改码只走 `apply_patch`；`tool_call` 扩展里还会二次校验生命周期、取消、路径和预算。
>
> 第三，**上下文按预算重组，不是固定截断**。固定约束和结构化状态优先，近期完整交互保留 `tool_call ↔ tool_result` 配对，大输出外置成 artifact，摘要只做引用，不把假设写成事实。

### 2:20–3:00 证据与边界

> 可靠性上，我用语义幂等键、Checkpoint、Operation、租约和验证指纹，处理“补丁已写但结果没记录”“PR 已创建但响应丢失”这类故障。评估上，Review 用独立 Judge 做一对一匹配，算 Precision/Recall；SWE-bench 用隐藏测试后置，按 F2P/P2P 判定。这个仓库里事件中心、PR、工单是本地适配器，SWE-bench 是本地 verifier，不是官方榜单；我没有复现简历里的业务规模数字。这些边界是刻意保留的，用来验证机制，不是包装成生产成绩。

---

## 3. 三根“深度钉子”

面试官最容易记住的不是功能列表，而是这三个点。

### 钉子一：pi 的边界

```text
pi：
  createAgentSession / prompt / tool loop
  tool definition / extension hooks / event stream
  session lifecycle / abort / dispose

ForgePilot：
  阶段状态机、生命周期、预算
  工具权限、路径校验、取消收敛
  Task/Checkpoint/Operation/Lease
  上下文压缩策略
  验证、证据、审批、PR、评估
```

可主动补一句：

> `context`、`tool_call`、`tool_result`、`before_agent_start` 这些是扩展独有事件，`session.subscribe` 收不到；所以权限和上下文改写在 `pi.on`，UI 流式转发才走 subscribe。

### 钉子二：失败与恢复

讲一个具体故障，不要只说“支持恢复”：

> `afterPrCreate`：PR 已经创建，但响应丢失。恢复时不能直接再创建一次，而是先按 task marker 查询外部 PR，确认不存在才重试。幂等键用 `taskId + opType + target + inputHash + version`，不用 `tool_call_id`，因为模型重新生成请求时 id 会变。

再补：

> 租约过期不等于旧进程已经停，所以不能立即接管；要先核对旧 owner 和在途外部操作。

### 钉子三：证据绑定

> 测试通过不算数，必须绑定当前代码指纹。Verification 记录 patchHash、baseCommit、环境、命令、退出码和日志 artifact；补丁变了，旧验证自动失效。模型自述成功不进入交付依据。

---

## 4. 十个必答问题

### Q1：为什么用 pi，不用 LangChain / OpenHands / 自研循环？

> 我需要的是执行面 SDK，不是一整套平台。pi 提供 session、工具、扩展钩子、流式事件和模型运行时；阶段状态机、权限、持久化和评估仍然由平台控制。OpenHands 是完整平台，深 fork 会把底座换成 Python/FastAPI，成本高，也会模糊控制面边界。

### Q2：为什么一个阶段一个 session？

> 阶段边界可以重建上下文，避免历史无限增长；业务状态不依赖聊天记录，而在 Task/Checkpoint/Artifact。一个阶段一个 session，也让超时、取消和恢复的边界更清楚。

### Q3：`pi.on` 和 `session.subscribe` 有什么区别？

> 扩展层能拦截/改写行为，subscribe 是外部观察流。`context/tool_call/tool_result/before_agent_start` 是扩展独有；`message_update/tool_execution_*/agent_settled` 可以 subscribe。用 subscribe 监听 `tool_call` 会静默收不到。

### Q4：为什么禁用 bash/edit/write？

> 它们能绕过阶段权限、路径校验和验证命令。改码只走 `apply_patch`，参数结构化、可记录、可做唯一性校验；执行命令只接受可信配置里的 verification kind，不让模型自己拼 shell。

### Q5：上下文压缩怎么保证不丢关键信息？

> 固定约束和结构化状态不进摘要；近期窗口保留完整工具配对；大输出外置 artifact，摘要只保留结论和引用；只有超预算才压缩。压缩只改请求，不改持久化历史。

### Q6：长任务中断后怎么恢复？

> Checkpoint 记录阶段边界、HEAD、patchHash 和在途操作；Operation 用语义幂等键；恢复时先核对工作区和外部结果，再决定完成还是重试，不盲目重放副作用。

### Q7：Review Chat 为什么只读？

> 审核角色不能既当运动员又当裁判。它只有 `read/grep/find/ls/read_artifact/get_change_summary/...`；要改码必须走“要求修改”，清空旧变更包回 REPAIR，必须产生新 patchHash 才能重新验证和审批。

### Q8：Review 评估和 SWE-bench 有什么区别？

> Review 评估的是“发现质量”，用 Judge 做一对一匹配，算 TP/FP/FN 和 P/R；SWE-bench 评估的是“补丁是否真的修复”，用隐藏测试后置，F2P 全过且 P2P 不退化才算 resolved。两者不能互相替代。

### Q9：这个项目最大的生产化风险是什么？

> 执行面还没有容器级隔离；文件存储和租约是单机语义，跨节点需要数据库 CAS/对象存储；事件中心、PR、工单目前是本地适配器。这些是下一步要补的，不是已经解决。

### Q10：哪些是你做的，哪些是模拟的？

> 平台闭环、pi 接入、阶段状态机、工具门禁、上下文压缩、恢复逻辑、Review Chat、两套评估和 Web 工作台是代码实现的；事件中心、PR、工单、工作区模板是本地适配器；业务规模数字没有复现。这个边界我会主动说清楚。

---

## 5. 主动暴露边界，反而加分

面试时主动说：

> “这个项目里事件中心、PR、工单是本地适配器，SWE-bench 是本地 verifier，不是官方榜单；我没有把简历里的 500+ 工程师、71 个 Bug 说成这个仓库跑出来的。这个仓库证明的是机制和可回放证据，不是生产规模。”

这比硬撑“都能上生产”更可信。

---

## 6. 不要说的话

- ❌ “pi 帮我做了状态机/持久化/评估。”  
  这些是平台层，pi 只做执行循环。
- ❌ “PR 创建了就等于交付/上线。”  
  PR 创建不等于 review、merge、deploy。
- ❌ “SWE-bench 2/2，所以效果很好。”  
  这是本地 fixture，不是官方排行榜。
- ❌ “500+ 工程师 / 71 个 Bug / 178→53 分钟是这个项目跑出来的。”  
  这是业务口径，不是仓库证据。
- ❌ “所有东西都是生产级。”  
  主动说沙箱、跨节点存储、真实集成的限制。

---

## 7. 6–8 小时准备路线

### Block 1：跑通 + 画链路（90 分钟）

- `npm test`
- `npm run demo:incident`
- `npm run ui`，打开 Trajectory，点一条 tool 记录看输入/输出
- 看 `events.jsonl` 里的 `agent_turn / tool_call / tool_result / agent_settled / context_metrics`
- 产出：一张调用链图

```text
orchestrator → runPiStageAgent → createAgentSession
→ prompt → tool_call → tool_result → agent_settled → dispose
```

### Block 2：pi 接入深度（2 小时）

只读四个文件：

1. `src/agent/session.ts`
2. `src/agent/extension.ts`
3. `src/agent/tools/index.ts`
4. `src/domain/stages.ts`

必须能答：

- 为什么 `loader.reload()` 不能省？
- 为什么用 `SessionManager.inMemory()`？
- `tools` 和 `customTools` 什么关系？
- 哪些事件 subscribe 收不到？
- 为什么 `apply_patch` 而不是 `edit`？

### Block 3：平台深度（2 小时）

读：

- `src/harness/orchestrator.ts` 的 `runPlan` / `runRepair`
- `src/context/assembler.ts` 的 `assemble`
- `src/harness/runtime.ts` 的 `applyChanges` / `recover`
- `src/review/service.ts` 的上下文和只读工具

产出：四条亮点各写三句话，必须包含“为什么”和“失败会怎样”。

### Block 4：模拟面试（1–2 小时）

- 不看稿讲 3 分钟；
- 白板画链路；
- 回答上面 10 个问题；
- 讲一个失败恢复故事；
- 讲一个“没做/下一步”。

---

## 8. 最后检查

- [ ] 能不看稿讲 3 分钟
- [ ] 能画出 `orchestrator → pi → tool → settled`
- [ ] 能解释 extension vs subscribe
- [ ] 能解释一个阶段一个 session
- [ ] 能讲清 `afterPrCreate` 恢复
- [ ] 能讲清 Review Chat 只读边界
- [ ] 能区分 Review P/R 与 SWE-bench F2P/P2P
- [ ] 能主动说出三个生产化限制
- [ ] 没有把 demo 数字说成生产成绩

---

## 9. 面试收尾句

> “这个项目我最想展示的不是功能数量，而是边界感：哪些交给模型，哪些必须由平台控制；哪些已经用代码验证，哪些还是本地适配器。面试官如果继续问，我可以从任意一个阶段下钻到事件、工具、上下文或恢复逻辑。”
