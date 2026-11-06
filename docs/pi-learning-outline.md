# ForgePilot × pi-agent 学习大纲

> 这是 **syllabus（大纲）**，不是教材。
>
> - 教材：`docs/pi-study-guide.md`
> - 大纲：本文件，只定义「学什么、按什么顺序、做到什么程度算学会」
> - 版本基线：`@earendil-works/pi-coding-agent@1.4.0`
>
> 目标不是背 API，而是能独立回答：
>
> **pi 在这一层负责什么、为什么这样接、出了问题去哪查、换一个场景能不能自己写。**

> **面试目标默认走「速通版」：6–8 小时，不要求 M10 Capstone。**
> 详细口述稿、追问和边界话术见 `docs/pi-interview-card.md`。

---

## 0. 两条路线（先选）

| 路线 | 目标 | 时间 | 覆盖 |
|---|---|---|---|
| 面试速通（默认） | 3 分钟讲清 + 10 个追问不崩 | 6–8 小时 | M0–M4 精读，M5/M7/M8 概念，M9 口径 |
| 深入版 | 能独立改 ForgePilot | 8–10 天 | M0–M10 |

> 下面的 M0–M10 是完整地图；面试速通只走核心模块，M10 不是必需。

---

## 1. 最终验收

完成本大纲后，应能做到：

1. 画出一次阶段执行的完整调用链：
   `orchestrator → runPiStageAgent → createAgentSession → prompt → tool → settled → dispose`。
2. 解释 pi 与 ForgePilot 的边界：
   pi 负责模型—工具循环、事件、工具定义、会话生命周期；
   ForgePilot 负责阶段、权限、持久化、上下文策略、评估、交付。
3. 不依赖 ForgePilot，写一个最小 pi Agent：
   `createAgentSession + defineTool + subscribe + extension + prompt + dispose`。
4. 在 ForgePilot 中独立完成至少一个改动：
   新增工具、修改 extension 钩子、调整上下文预算，或增加一个阶段门禁。
5. 能定位五类常见问题：
   - 没有模型 / key 不可用
   - 工具未列入白名单
   - `tool_call` 在 subscribe 收不到
   - 空回答 / `agent_settled.aborted`
   - 上下文压缩后工具配对断裂
6. 能用三分钟讲清楚：
   「为什么 pi 只做执行面，平台层必须自己做什么」。

---

## 2. 学习边界

### 本次要学

- pi-agent SDK 的会话组装
- 工具系统与权限门禁
- 扩展事件 vs subscribe 事件
- 上下文注入与压缩
- 会话生命周期、abort、dispose
- ForgePilot 如何把 pi 嵌进阶段状态机
- 第二个 Agent 用例：只读 Review Chat
- 最小可运行的 pi 程序

### 本次不学 / 后置

- pi 的 TUI / 主题 / 键位
- RPC 模式、Sandbox、子 Agent 调度
- pi 内部源码逐行阅读
- 升级 pi 到 latest
- M2–M5 产品路线图实现
- 真实 GitLab / GitHub / 事件中心生产适配
- 完整 SWE-bench 官方 Docker Harness

> 遇到后置问题，记录到「Parking Lot」，不打断当前模块。

---

## 3. 三层能力模型

学习时始终判断当前内容属于哪一层：

| 层 | 能力 | pi 提供 | ForgePilot 负责 |
|---|---|---|---|
| L1 用 pi | 创建会话、prompt、收流、dispose | `createAgentSession`、`AgentSession` | 调用入口、CLI/Web |
| L2 控 pi | 工具、权限、上下文、结束信号 | `defineTool`、`pi.on`、`ResourceLoader` | 阶段白名单、门禁、压缩策略 |
| L3 替 pi | 模型运行时、UI、持久化 | `ModelRuntime`、`SessionManager` | Task/Checkpoint/SSE/审批 |

本课程重点：**L2 为主，L1 必须会写，L3 理解边界即可。**

---

## 4. 模块总览

| 模块 | 核心问题 | 主要文件 | 实验 | 产出 | 时间 |
|---|---|---|---|---|---|
| M0 | 这个系统怎么跑起来？ | `README.md`、`docs/design.md` | 跑 demo、看 Trajectory | 一张架构/调用链图 | 0.5 天 |
| M1 | pi session 怎么组装？ | `src/agent/session.ts` | 最小 session、去掉 reload、换 inMemory | session 生命周期图 | 1 天 |
| M2 | 事件为什么分两层？ | `src/agent/extension.ts`、`ui-events.ts` | 同时打 subscribe 和 pi.on 日志 | 事件矩阵表 | 1 天 |
| M3 | 工具如何被定义和拦住？ | `src/agent/tools/index.ts`、`stages.ts` | 新增工具、移除 read、尝试 bash | 工具契约 + 门禁清单 | 1 天 |
| M4 | 阶段如何驱动 pi？ | `orchestrator.ts`、`prompt.ts` | 改阶段 prompt、去掉 record_plan | 阶段时序图 | 1 天 |
| M5 | 上下文如何压缩？ | `context/assembler.ts` | 调小预算、打断工具配对、读 artifact | 压缩不变量 + metrics 解释 | 1.5 天 |
| M6 | 会话如何结束/取消？ | `session.ts`、`review/service.ts` | 强制超时、取消任务、看 aborted | 生命周期状态表 | 0.5 天 |
| M7 | 长任务为什么能恢复？ | `harness/runtime.ts`、`store/*` | `demo:fault`、看 operations | 恢复决策表 | 1 天 |
| M8 | 第二个 Agent 怎么做？ | `review/*`、`web/server.ts`、`ReviewModal.tsx` | 看 SSE、加只读工具、验证只读边界 | SSE 事件流图 | 1 天 |
| M9 | 评估口径是什么？ | `eval/review/*`、`eval/swebench/*` | `demo:review`、`demo:swebench` | P/R + F2P/P2P 口径卡 | 可选 1 天 |
| M10 | 能否独立写一个 pi Agent？ | 新建 `labs/` | 最小 Agent + ForgePilot 小改动 | 可运行代码 + 三分钟口述 | 1–2 天 |

---

## 5. 分阶段路线

### Phase A：执行面（M0–M4）

目标：看懂「平台如何把 pi 跑起来」，并能改工具和门禁。

- M0 建立地图
- M1 session 组装
- M2 事件层
- M3 工具与权限
- M4 阶段编排

阶段验收：

- 能画出调用链；
- 能解释 `loader.reload()`、`SessionManager.inMemory()`、`tools` 白名单；
- 能证明 `tool_call` 在 `session.subscribe` 收不到；
- 能新增一个自定义工具并让它出现在 Review Chat。

### Phase B：上下文与可靠性（M5–M7）

目标：理解「长任务为什么不会失控」。

- M5 上下文压缩
- M6 生命周期 / abort
- M7 持久化、幂等、恢复

阶段验收：

- 能解释一次 `context_metrics`；
- 能说明工具配对为什么不能断；
- 能解释 `agent_settled` 为什么比 `agent_end` 可靠；
- 能走一遍 `demo:fault` 的恢复路径。

### Phase C：第二个 Agent 与评估（M8–M9）

目标：理解「同一套 pi 能力如何复用到审核场景」。

- M8 Review Chat + SSE
- M9 Review / SWE-bench 评估（可选）

阶段验收：

- 能画出 SSE 事件顺序；
- 能解释只读工具白名单和「要求修改」回 REPAIR 的边界；
- 能解释 Precision/Recall 与 F2P/P2P 不是同一个东西。

### Phase D：Capstone（M10）

目标：脱离项目也能写 pi，回到项目也能改 pi。

- 写 `labs/01-minimal-pi.ts`
- 在 ForgePilot 完成一个真实小改动
- 回答第 8 节 20 题
- 做三分钟口述

---

## 6. 每日节奏

每天建议 5–6 小时，按固定节奏走：

| 时间 | 内容 |
|---|---|
| 30 min | 回顾昨天：不看笔记复述 3 个结论 |
| 90 min | 读教材对应章节 + 项目代码 |
| 30 min | 写三行笔记 / 更新进度 |
| 120 min | 做实验，记录日志和失败 |
| 30 min | 调试、查类型定义或 pi 文档 |
| 30 min | 出口检查：今天能回答哪三个问题？ |

每天结束前必须写：

```text
模块：M__
我改/看了：____
pi 的 API/事件：____
如果去掉它，会坏在：____
明天的问题：____
```

---

## 7. 防止聊散的五条规则

1. **每次学习先报模块编号**：例如「今天只做 M2，不碰 M5」。
2. **问题超出当前模块，先记 Parking Lot**：不立刻展开，避免主线断掉。
3. **每个模块只回答三个问题**：
   - 它解决什么问题？
   - 它用了 pi 的哪个 API/事件？
   - 去掉它，系统会坏在哪？
4. **未通过 checkpoint 不进入下一模块**：宁可重复实验，不跳章。
5. **教材与大纲分工**：
   - 教材负责「细节和代码解释」；
   - 大纲负责「顺序、边界、验收」；
   - 不把教材再抄一遍。

---

## 8. 模块检查点

### M0

- [ ] `npm test` / `npm run build` 通过
- [ ] 跑过 `npm run demo:incident`
- [ ] 打开过 Trajectory，点开过 tool inspector
- [ ] 能画出 `orchestrator → pi → tool → settled` 的链
- [ ] 能说出 pi 与 Harness 的分工

### M1

- [ ] 能解释 `createModelContext` 和 `runPiStageAgent`
- [ ] 能解释 `loader.reload()` 不调用会怎样
- [ ] 能解释为什么用 `SessionManager.inMemory()`
- [ ] 能解释 `tools` 与 `customTools` 的关系
- [ ] 能写一个最小 `createAgentSession + prompt + dispose`

### M2

- [ ] 能列出 `pi.on` 独有事件
- [ ] 能证明 `subscribe` 收不到 `tool_call`
- [ ] 能解释 `message_update` 与 `tool_execution_*`
- [ ] 能解释 `agent_settled` 的用途
- [ ] 完成事件矩阵表

### M3

- [ ] 能写一个 `defineTool` 工具
- [ ] 能解释 `content` 与 `details`
- [ ] 能解释为什么 `bash/edit/write` 永久禁用
- [ ] 能解释 `tool_call` 为什么要二次校验阶段/生命周期/路径/预算
- [ ] 完成「移除 read 后会被 block」实验

### M4

- [ ] 能跟踪一次 `runPlan` / `runRepair`
- [ ] 能解释一个阶段一个 session
- [ ] 能解释 `record_plan` 为什么是工具而不是普通文本
- [ ] 能解释 Harness 如何验证阶段产出
- [ ] 完成阶段 prompt 修改实验

### M5

- [ ] 能解释 `assemble()` 的裁剪顺序
- [ ] 能解释 `findRecentWindow` 为什么不能从 toolResult 开始
- [ ] 能解释 artifact 外置和回读
- [ ] 能读懂 `context_metrics`
- [ ] 完成调小预算实验，且 `tests/context.test.ts` 仍通过

### M6

- [ ] 能解释 `prompt` / `abort` / `dispose`
- [ ] 能解释墙钟超时如何触发
- [ ] 能解释 Review Chat 为什么用独立 180s
- [ ] 能解释取消后为什么不能继续产生副作用
- [ ] 完成一次超时/取消观察

### M7

- [ ] 能解释幂等键为什么不用 `tool_call_id`
- [ ] 能解释 Checkpoint / Operation / Verification 各存什么
- [ ] 能解释 PR 已创建但响应丢失时先查再重试
- [ ] 能解释租约过期为什么不能立即接管
- [ ] 完成 `demo:fault` 恢复路径

### M8

- [ ] 能画出 SSE 事件顺序
- [ ] 能解释 Review Chat 的只读工具白名单
- [ ] 能解释「要求修改」必须产生新 patchHash
- [ ] 能解释聊天 token 为什么不计入修复预算
- [ ] 完成一次全局评审对话

### M9（可选）

- [ ] 能解释 Review 的 TP/FP/FN 和 P/R
- [ ] 能解释 SWE-bench 的 F2P/P2P
- [ ] 能解释为什么行号匹配不能直接算 TP
- [ ] 能跑 `demo:review` 和 `demo:swebench -- --limit 1`

### M10

- [ ] `labs/01-minimal-pi.ts` 可运行
- [ ] 能在 ForgePilot 完成一个独立小改动
- [ ] 能回答 `docs/pi-study-guide.md` 第 8 节 20 题
- [ ] 能三分钟口述项目
- [ ] 能把改动写进 commit，并跑通测试/构建

---

## 9. 进度记录模板

建议每次学习后在 `docs/pi-learning-progress.md` 追加：

```markdown
## 2026-__-__ / M__

- 今天读了：
- 今天跑了：
- 今天改/验证了：
- 三行结论：
  1.
  2.
  3.
- 仍不懂：
- Parking Lot：
- 下一个模块：
```

---

## 10. 教材章节映射

| 大纲模块 | 教材章节 |
|---|---|
| M0 | `pi-study-guide.md` 0–4 |
| M1 | 5.1 + Lab 1 |
| M2 | 5.3 + Lab 2 |
| M3 | 5.2 + Lab 3 |
| M4 | 5.1 / 5.7 + Lab 3.5 |
| M5 | 5.4 + Lab 5 |
| M6 | 5.6 + Lab 8 |
| M7 | 5.5 + Lab 4 |
| M8 | 5.6 / 5.7 + Lab 3 |
| M9 | 5.8 + Lab 6/7 |
| M10 | 6 + 8 + 9 |

---

## 11. 建议节奏

> 面试目标不需要走这一节；直接按第 0 节的 6–8 小时速通版。
> 下面只是「能独立改 ForgePilot」的深入版节奏。

### 全职版：8–10 个学习日

```text
Day 1      M0 + M1
Day 2      M2
Day 3      M3
Day 4      M4
Day 5      M5
Day 6      M6 + M7
Day 7      M8
Day 8      M9（可选）
Day 9–10   M10 Capstone
```

### 每天 4 小时版：12–14 天

按 Phase A → B → C → D 顺序推进，不跳模块。

---

## 12. 下一步

先确认三件事：

1. 目标是「面试能讲清楚」还是「能独立改 ForgePilot」？两者比例不同。
2. 每天实际可投入几小时？
3. 是否要建立 `labs/` 和 `docs/pi-learning-progress.md`？

确认后从 **M0** 开始，不提前进入 M1。
