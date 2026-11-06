# pi × ForgePilot 面试速通路线

> **目标：6–8 小时，能 3 分钟讲清项目，扛住 10 个追问。**
>
> 这不是完整 pi 课程，也不是“把 ForgePilot 全部读完”。
> 只学面试必须用到的执行链、取舍、失败处理和证据口径。

## 使用说明

- 按 **Block 0 → Block 4** 顺序走，不跳 Block。
- 每个 Block 有：目标、命令、阅读文件、必须回答的问题、产出、完成标准。
- 每完成一个 Block，更新 `PROGRESS.md`，并在 `NOTES.md` 写三行结论。
- 遇到当前 Block 之外的问题，先记到 `NOTES.md` 的 Parking Lot，不展开。
- 教材是 `docs/pi-study-guide.md`；完整大纲是 `docs/pi-learning-outline.md`；口述稿是 `docs/pi-interview-card.md`。
- 这个仓库里事件中心、PR、工单是本地适配器；不要把 demo 数字说成生产成绩。

---

## 总路线

| Block | 时间 | 目标 | 产出 |
|---|---:|---|---|
| 0 | 30 min | 跑通基线，知道项目怎么启动 | 能打开 Trajectory |
| 1 | 90 min | 看懂一次阶段执行链 | 一张调用链图 |
| 2 | 2 h | 看懂 pi 接入层 | 能解释 session / extension / tools |
| 3 | 2 h | 看懂平台层四条亮点 | 每条三句话 |
| 4 | 1–2 h | 面试口述和追问训练 | 3 分钟不卡壳 |

总计约 **6–8 小时**，可以拆成两个下午或一个晚上 + 一个上午。

---

## Block 0：跑通基线（30 分钟）

### 目标

先建立“这个项目能跑、页面在哪、日志在哪”的感觉，不读代码。

### 命令

```bash
cd D:/workfile/forgepilot
npm test
npm run build
npm run demo:incident
npm run ui
```

浏览器打开：

```text
http://127.0.0.1:4310
```

### 要做的事

1. 打开任意任务；
2. 进入 Trajectory 页；
3. 点一条 tool 记录；
4. 看 inspector 的「输入 / 输出 / 原始事件」；
5. 找到任务目录：

```text
.forgepilot/tasks/<taskId>/
  events.jsonl
  review-chat.jsonl
  verifications.jsonl
  checkpoints/latest.json
  operations/
  artifacts/
```

### 完成标准

- [ ] `npm test` 通过
- [ ] `npm run build` 通过
- [ ] `demo:incident` 跑完
- [ ] UI 能打开，Trajectory 能点开 tool 记录
- [ ] 知道 `events.jsonl` 在哪

> 不要求理解代码。

---

## Block 1：看懂一次阶段执行链（90 分钟）

### 目标

把“平台怎么调用 pi”串成一条线，而不是只看零散函数。

### 先看事件

```bash
TASK=<taskId>
grep -E '"type":"(agent_turn|tool_call|tool_result|agent_settled|context_metrics)"' \
  .forgepilot/tasks/$TASK/events.jsonl | tail -n 60
```

重点找：

- `agent_turn`：这一轮用了多少 token / 工具；
- `tool_call`：工具名 + 输入；
- `tool_result`：结果摘要；
- `agent_settled`：是否 `aborted`；
- `context_metrics`：压缩前后 token、摘要数、外置输出数。

### 读两个文件

1. `src/agent/session.ts`  
   只看 `runPiStageAgent` 的主流程。
2. `src/agent/extension.ts`  
   只看 5 个 `pi.on` 分别做什么。

### 必须回答

1. 一次阶段执行从哪个函数开始？
2. `loader.reload()` 不调用会怎样？
3. 为什么用 `SessionManager.inMemory()`？
4. `agent_settled` 和 `agent_end` 有什么区别？
5. 哪些事件 `session.subscribe` 收不到？

### 产出

画一张图，不用漂亮，能讲就行：

```text
orchestrator.runRepair
  → runPiStageAgent
    → loader.reload()
    → createAgentSession(...)
    → session.subscribe(...)
    → session.prompt(...)
      → pi.on("before_agent_start")
      → pi.on("context")
      → tool_call → pi.on("tool_call") → 工具执行
      → pi.on("tool_result")
    → agent_settled
    → session.dispose()
```

### 完成标准

- [ ] 能不看代码画出这条链
- [ ] 能说出 pi 与 ForgePilot 的分工
- [ ] 能解释为什么一个阶段一个 session

---

## Block 2：看懂 pi 接入层（2 小时）

### 目标

能回答“你到底怎么用 pi 的”，而不是只会说“集成了 SDK”。

### 只读四个文件

| 文件 | 重点 |
|---|---|
| `src/agent/session.ts` | `createModelContext`、`runPiStageAgent` |
| `src/agent/extension.ts` | 5 个 `pi.on` |
| `src/agent/tools/index.ts` | `defineTool`、TypeBox、`content/details` |
| `src/domain/stages.ts` | `STAGE_TOOLS`、`stagePrompt` |

### 必须弄懂

1. `createAgentSession` 的 `model / modelRuntime / resourceLoader / sessionManager / customTools / tools` 各自是什么。
2. 为什么 `DefaultResourceLoader` 传了之后必须 `await loader.reload()`。
3. `tools` 和 `customTools` 的关系：自定义工具不写进 `tools` 会怎样。
4. 为什么 `context/tool_call/tool_result/before_agent_start` 必须在扩展层，不在 subscribe。
5. `tool_call` 钩子除了白名单，还校验了什么。
6. 为什么永久禁用 `bash/edit/write`，改码只走 `apply_patch`。
7. `defineTool` 的 `content` 和 `details` 分别给谁看。

### 必须回答

- 如果去掉 `loader.reload()` 会发生什么？
- 如果 `tools` 少写一个自定义工具名，会发生什么？
- 如果只靠 `session.subscribe` 做权限拦截，会怎样？
- 为什么 `apply_patch` 要求 `oldText` 唯一？

### 完成标准

- [ ] 能解释 `createAgentSession` 的组装参数
- [ ] 能解释 extension vs subscribe
- [ ] 能解释工具白名单和硬禁用
- [ ] 能说出至少两个“静默失败”的坑

---

## Block 3：看懂平台层四条亮点（2 小时）

### 目标

面试时能把“四条亮点”讲成设计，而不是背功能名。

### 阅读范围

| 文件 | 只看 |
|---|---|
| `src/harness/orchestrator.ts` | `runPlan`、`runRepair` |
| `src/context/assembler.ts` | `assemble`、`renderStateBlock` |
| `src/harness/runtime.ts` | `applyChanges`、`recover` |
| `src/review/service.ts` | 只读工具、上下文组装 |

> 不要逐行读 `store/*`，也不要读 `eval/*` 细节。先理解机制。

### 四条亮点，每条写三句话

格式：

```text
解决什么问题：
关键机制：
失败会怎样：
```

#### 1. 上下文压缩

关键词：

```text
固定约束 → 结构化状态 → 历史摘要
→ 近期完整交互（保留 tool_call ↔ tool_result）
→ 按需 artifact
```

必须能解释：

- 为什么不能只生成一条摘要；
- 大输出外置后怎么重新读取；
- `context_metrics` 不是账单。

#### 2. 长任务可靠执行

关键词：

```text
Task / Checkpoint / Operation / Verification / Lease
语义幂等键：taskId + opType + target + inputHash + version
PR 已创建但响应丢失：先查，再重试
租约过期 ≠ 旧进程已停
```

必须能解释：

- 为什么不用 `tool_call_id` 做幂等键；
- 测试通过后又改一行，旧验证为什么失效；
- 恢复时为什么不能盲目重放副作用。

#### 3. PR Review 评估

关键词：

```text
发现规范化 → 同根因去重 → 文件+区间候选
→ 独立 Judge → 一对一匹配
→ TP/FP/FN → Precision/Recall
```

必须能解释：

- 行号匹配为什么不能直接算 TP；
- 未决项为什么不直接算 FP；
- demo 的 P/R 数字不是生产成绩。

#### 4. SWE-bench 评估

关键词：

```text
固定实例 → baseline / 检索增强双臂
→ 同一模型/环境/预算
→ Agent 结束后才应用隐藏测试
→ F2P 全过 + P2P 不退化 + patch 非空 = resolved
```

必须能解释：

- 为什么隐藏测试必须后置；
- 空补丁为什么不算 resolved；
- 本地 verifier 和官方排行榜的区别。

### 完成标准

- [ ] 四条亮点每条能讲 3 句话
- [ ] 每条都包含“为什么”和“失败会怎样”
- [ ] 能说出至少一个本地适配器/生产化限制

---

## Block 4：面试口述与追问（1–2 小时）

### 目标

不是“看过”，而是能不看稿讲出来，并且扛住追问。

### 使用材料

- `docs/pi-interview-card.md` 的 3 分钟口述稿；
- 同一文件的 10 个必答问题；
- `NOTES.md` 里你前三个 Block 的笔记。

### 训练顺序

1. 不看稿讲 3 分钟，录音；
2. 听录音，删掉“然后、就是、大概”；
3. 白板画调用链；
4. 让另一个人/自己随机抽 5 个问题；
5. 每个回答控制在 60–90 秒；
6. 最后讲一个失败恢复故事和一个“没做/下一步”。

### 必须能脱口而出

```text
pi 负责执行面：
模型—工具循环、事件、工具定义、会话生命周期。

ForgePilot 负责控制面：
阶段、权限、持久化、上下文、评估、交付。
```

### 不要说的话

- ❌ “pi 帮我做了状态机/持久化/评估。”
- ❌ “PR 创建了就等于上线。”
- ❌ “SWE-bench 2/2，所以效果很好。”
- ❌ “500+ 工程师 / 71 个 Bug 是这个项目跑出来的。”
- ❌ “所有东西都是生产级。”

### 完成标准

- [ ] 3 分钟不卡壳
- [ ] 能白板画链路
- [ ] 10 个问题至少 8 个能答
- [ ] 能主动说出三个生产化限制

---

## 最小阅读清单

只精读这 6 个文件：

```text
src/agent/session.ts
src/agent/extension.ts
src/agent/tools/index.ts
src/domain/stages.ts
src/harness/orchestrator.ts   # 只看 runPlan / runRepair
src/context/assembler.ts      # 只看 assemble / renderStateBlock
```

按需看：

```text
src/harness/runtime.ts        # applyChanges / recover
src/review/service.ts         # 只读工具 + 上下文
src/agent/ui-events.ts        # pi 事件 → UI
```

暂时不看：

```text
src/store/*                   # 知道概念即可
src/eval/*                    # 知道口径即可
web/*                         # 面试不考 UI 实现
```

---

## 最终验收

- [ ] 能讲清 pi 与平台的分工
- [ ] 能画一次阶段执行链
- [ ] 能解释 extension vs subscribe
- [ ] 能解释一个阶段一个 session
- [ ] 能解释上下文压缩的五个不变量
- [ ] 能讲一个恢复/幂等故事
- [ ] 能讲 Review Chat 只读边界
- [ ] 能区分 Review P/R 与 SWE-bench F2P/P2P
- [ ] 能主动说边界，不夸大

---

## 关联文档

```text
docs/pi-study-guide.md       教材：细节、实验、自测题
docs/pi-learning-outline.md  完整大纲：M0–M10
docs/pi-interview-card.md    面试口述稿、10 问、边界话术
```

---

## 学习协议

每次学习前说：

```text
今天只做 Block __。
```

每次学习后更新：

```text
PROGRESS.md  -> 勾选完成项
NOTES.md     -> 三行结论 + Parking Lot
```
