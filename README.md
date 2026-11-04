# ForgePilot

面向研发 Bug 修复与 PR Review 的可运行 Agent 参考实现。

这个仓库把简历里的四条技术亮点落成了代码：**状态驱动的修复—验证—交付闭环、预算驱动的分层上下文、可恢复的长任务执行、两套离线评估**。它不是一个只有 Prompt 的 Demo，也不是对 500+ 工程师生产部署的复刻；真实部署的工单/GitLab/沙箱在这里用可替换的本地适配器表示。

## 1. 快速开始

要求：Node.js ≥ 22，已配置 pi 的模型认证（本机默认 `dsh/deepseek-v4.1-flash`）。

```bash
cd D:/workfile/forgepilot
npm install
npm test              # 13 个确定性测试，不调用模型
npm run demo:fix      # 真实模型跑一次 Bug 修复 → 测试 → 审批 → 分支/PR
npm run demo:fault    # 故障注入：PR 已创建但响应丢失，恢复后不重复创建
npm run demo:review   # PR Review 离线评估（启发式 Judge）
npm run demo:review -- --llm   # 独立 LLM Judge
npm run demo:swebench -- --limit 2  # baseline / 检索增强双臂对照
```

指定模型：

```bash
FORGEPILOT_MODEL=dsh/deepseek-v4.1-pro npm run demo:fix
```

## 2. 它解决了什么

一个 Bug 从工单到交付，不只是“让模型改几行代码”：

```text
工单/权限/固定 base_commit
  → 隔离工作区
  → 复现（未修复版本必须先失败/出现目标现象）
  → 根因定位 + 最小补丁
  → 测试/构建验证（绑定代码指纹）
  → 变更包 + 人工审批
  → 推送分支 + 创建/核对 PR
  → 人工评审与合并
```

Harness 决定“当前允许进入哪个阶段、能调用什么工具”，模型只在当前阶段内做决策。改码、验证、发布都不靠模型自述成功。

主链路阶段：

```text
PREPARE → REPRODUCE → REPAIR → VERIFY → PACKAGE → PUBLISH → DONE
```

生命周期单独管理：

```text
QUEUED / RUNNING / WAITING_INPUT / WAITING_APPROVAL /
PAUSED / CANCELLING / CANCELLED / FAILED / DELIVERED
```

## 3. 四条亮点的代码落点

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

## 4. 目录

```text
src/
  agent/           pi SDK 会话、系统提示词、扩展钩子、业务工具
  context/         分层上下文组装
  domain/          阶段/生命周期/预算/数据模型
  harness/         编排器、运行时、恢复/幂等/发布
  integrations/    Git、PR、工单、验证命令
  store/           Task/Artifact/Operation/Checkpoint/Verification/Lease/Event
  eval/review/     Review 评估
  eval/swebench/   SWE-bench 双臂评估
  cli.ts
fixtures/          示例仓库、工单、Review 标签、SWE-bench 实例
scripts/           demo 脚本
tests/             确定性测试
docs/design.md     详细设计
docs/demo-evidence.md  本地真实运行证据与口径
```

## 5. 与 pi-agent SDK 的关系

- 运行时固定 `@earendil-works/pi-coding-agent@1.4.0`（skill 基线版本）。
- 系统提示词完全替换 pi 默认人设；`noSkills/noContextFiles` 关闭无关注入。
- 扩展层 `pi.on` 使用 `context` / `before_agent_start` / `tool_call` / `tool_result` / `agent_settled`。这些事件 `session.subscribe` 收不到。
- 工具白名单按阶段设置；`bash/powershell/edit/write` 永久禁用，改码只走 `apply_patch`。
- 业务持久化用 `SessionManager.inMemory()` + 自己的 TaskStore/Checkpoint，不依赖 pi 的会话目录。
- 结束信号使用 `agent_settled`，不是 `agent_end`。
- 一个阶段一个 session；跨阶段恢复靠结构化状态与制品，不靠聊天记录。

## 6. 真实与模拟边界

**真实执行**

- 真实 Git 仓库/提交/分支/工作区；
- 真实测试、构建、复现命令；
- 真实模型调用与 Token 统计；
- 真实 LLM Judge（`--llm`）；
- 真实本地 SWE-bench 风格的隐藏测试判定。

**本地适配器（面试时可替换为生产实现）**

- 工单系统：本地 JSON（`fixtures/tickets/`），可替换为 Jira/云效适配器；
- 代码托管：本地 PR 记录（`local://pr/...`），可替换为 GitLab/Codeup API；
- 工作区：模板复制 + git init，可替换为 `git worktree` / 容器沙箱（已保留 `prepareExistingRepoWorktree`）；
- 存储：文件 + 原子写 + sha256 制品，可替换为 Postgres + 对象存储；
- 评估：本地 verifier，可替换为官方 SWE-bench Docker Harness。

## 7. 已知限制

- 没有 React 工作台，当前是 CLI + JSON/Markdown 报告。
- 没有 Docker/容器级隔离；真实部署应把执行面放进一次性沙箱。
- 文件存储在单机并发下可用，跨节点需要数据库 CAS/租约。
- 隐藏测试的本地 verifier 是简化版；官方 SWE-bench 需要 Docker harness 与数据集 revision 固定。
- 代码是 TS 运行时。简历里的 Python/React 控制面可以作为后续包装层；本仓库不声称它是生产控制面。
- 简历中的 500+ 工程师、71 个 Bug、178→53 分钟是业务口径；本仓库只产出机制与可回放证据，不复现这些业务数字。

## 8. 测试

```bash
npm test
```

覆盖：

- Task CAS、租约 epoch、操作幂等；
- 上下文预算压缩、约束保留、工具配对完整、制品回读；
- Review 一对一匹配、P/R、未决项、回放对比；
- 补丁落盘后崩溃恢复、PR 响应丢失恢复、验证指纹失效；
- `git diff` 指纹跨 commit 稳定、changedFiles 路径正确；
- SWE-bench 双臂执行、隐藏测试后置、空补丁不判 resolved。

## 9. 面试一句话

> ForgePilot 不是让模型直接接管研发流程，而是把 Bug 修复放进可控闭环：固定代码版本，由 Agent 定位和改码，由 Harness 验证、绑定证据、等待人工审批，再交付带验证记录的 PR。技术上重点解决长上下文不丢约束、任务中断不重复副作用，以及用两套离线评估分别检验 Review 质量和修复效果。
