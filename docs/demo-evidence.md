# 本地 Demo 证据

以下都是本仓库 fixture 上真实跑出的本地结果，用来说明机制可运行；**不是生产环境成绩，也不是简历里 500+ 工程师 / 71 Bug / 178→53 分钟的口径**。`.forgepilot/` 下的完整任务、事件、检查点、制品和报告默认被 gitignore，可用对应命令重新生成。

## 1. Bug 修复闭环

命令：

```bash
npm run demo:fix
```

一次实际运行：

| 字段 | 结果 |
| --- | --- |
| Ticket | `T-1001`（课程列表整除时多出一页） |
| Base commit | 固定生成 |
| 变更文件 | `src/pagination.js` |
| Patch | `fcdb21ebc2d1...` |
| 测试 | `node --test tests/pagination.test.js` → exit 0 |
| 构建 | `node -e "import('./src/pagination.js')..."` → exit 0 |
| 验证记录 | `V-1793780843957-2b230e`（绑定 patchHash + 环境指纹） |
| 人工审批 | 变更包审批后进入 PUBLISH |
| PR | `PR-9698ce8db4`（本地适配器 `local://pr/...`） |
| Token | 约 46k |
| 工具调用 | 15 |
| 最终状态 | `DONE / DELIVERED` |

模型实际使用的补丁核心：

```diff
- return Math.floor(total / pageSize) + 1;
+ return Math.ceil(total / pageSize);
```

注意：Harness 自动执行测试/构建，不依赖模型自述“已通过”；测试失败会回到 REPAIR，预算耗尽则进入 `WAITING_INPUT`。

## 2. 故障注入：PR 已创建但响应丢失

命令：

```bash
npm run demo:fault
```

实际行为：

```text
1. 正常执行到 PUBLISH，create_pr 在外部系统创建 PR
2. 注入崩溃：响应未返回、操作记录保持 unknown
3. 任务状态停在 PUBLISH / RUNNING，进程退出
4. 再次运行同一 task：租约 epoch 递增，recover 按 task marker 查询 PR
5. 找到已有 PR → 操作标记 done → 关联 PR → 收敛到 DONE / DELIVERED
6. PR 记录数不变（noDuplicatePr = true）
```

关键恢复日志：

```text
recoveryNotes:
- PR exists; task reconciled to DONE/DELIVERED
noDuplicatePr: true
```

同样支持：

- `afterPatch`：补丁已落盘、操作记录未完成 → 按工作区 diff 核对，不重复应用；
- `afterTestRecord`：测试记录已写、阶段未推进 → 复用同一 patch fingerprint 的验证结果。

## 3. PR Review 离线评估

命令：

```bash
npm run demo:review
npm run demo:review -- --llm
```

固定标签集 `labels-v1`：

| 策略 | TP | FP | FN | Undecided | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| `run-a` | 3 | 1 | 1 | 1 | 0.750 | 0.750 |
| `run-b` | 4 | 0 | 0 | 0 | 1.000 | 1.000 |

`run-a` 的典型问题：

- FP：`parser.js` 的泛化建议“补充测试”，没有对应缺陷；
- FN：`auth.js` 的角色判断反转没有被报告；
- Undecided：`cache.js` 同位置但不同根因（tenant 隔离 vs TTL），进入人工仲裁。

真实 LLM Judge 运行结果与启发式一致（模型 `dsh/deepseek-v4.1-flash`），说明 Judge 调用链可用；生产上仍需人工抽检和标签版本管理。

## 4. SWE-bench 本地双臂对照

命令：

```bash
npm run demo:swebench -- --limit 2
```

一次实际运行（`swe-20261104081322-32bd`）：

| arm | resolved | avg input tokens | avg tool calls | avg wall time |
| --- | --- | --- | --- | --- |
| baseline | 2/2 | 45,048 | 12.5 | 54.2s |
| enhanced | 2/2 | 15,213 | 8.5 | 24.6s |

两个本地实例：

- `local-pagination-1`：整除分页 off-by-one；
- `local-slugify-1`：slug 标点/连续横线处理。

协议约束：

- 生成阶段只给 problem statement，不给隐藏测试和参考 patch；
- 隐藏测试在 Agent 结束后才写入；
- baseline 先验证 F2P 失败、P2P 通过；
- 只有 F2P 全过、P2P 不退化且补丁非空才记 resolved；
- 本地 verifier 与官方 Docker Harness 接口兼容，但结果不是官方排行榜成绩。

## 5. 上下文指标

`npm run demo:fix` 会输出每次 LLM 调用的上下文样本：

```json
{"before": 5265, "after": 4905, "summarized": 0, "offloaded": 2, "pairs": 15}
```

- 短上下文不会强行摘要；状态块本身有固定开销，超过预算才裁剪；
- 大工具输出被外置为 artifact，`after < before`；
- `pairs` 表示保留下来的 tool_call ↔ tool_result 配对数量；
- 压缩不变量由 `tests/context.test.ts` 覆盖：约束不丢、状态块不重复、无孤儿 toolResult、制品可回读。

## 6. 审核对话与“要求修改”闭环

命令：

```bash
npm run demo:review-chat
npm run demo:review-changes
```

一次真实运行（`demo:review-chat`）：

| 字段 | 结果 |
| --- | --- |
| GitHub issue | `https://github.com/example/course-service/issues/101`（本地 fixture，真实 URL 走 GitHub API） |
| 修复完成 | `PACKAGE / WAITING_APPROVAL` |
| 审核对话 | 2 轮工程师提问 + 2 轮 Agent 回答 |
| 回答依据 | 当前 diff、`src/pagination.js:14-15`、验证记录、artifact 测试日志 |
| 通过审批 | patch `fcdb21ebc2d1` |
| 最终交付 | `DONE / DELIVERED`，PR `PR-21ca371a1f` |
| 对话条数 | 4 |

一次“要求修改”运行（`demo:review-changes`）：

```text
1. 修复完成，进入 WAITING_APPROVAL
2. 工程师提问后，在对话框提交“请把顶部旧 bug 注释一起更新”
3. Harness 清空旧变更包，写回 unresolved feedback，退回 REPAIR
4. Agent 产生新 patch 75afe5a2b391，重新 VERIFY、重新 PACKAGE
5. 工程师再次对话确认
6. 审批通过 → 推送分支/创建 PR PR-d2051abda6
7. 最终 DONE / DELIVERED，对话 7 条
```

关键约束：

- 审核对话工具是只读的，不能 `apply_patch`；
- 对话 Token 计入 metrics，但不消耗修复预算（否则“问几个问题就没预算改码”）；
- 未解决的 feedback 会阻止 `package/approve/publish`；
- 审核对话历史持久化在 `tasks/<id>/review-chat.jsonl`，页面刷新后可继续。
- 流式事件包含 `thinking_start/delta/end` 与 `tool_start/tool_end`：CLI 默认把思考/工具打印到 stderr（`--no-trace` 关闭），Web 在回答气泡中显示“思考过程”和工具 chip；
- 回答结束后，assistant message 的 `meta.tools` 保存工具名、耗时、是否失败和结果摘要，刷新页面仍能看到本轮用过哪些工具。

## 7. Web 工作台

命令：

```bash
npm run ui
# http://127.0.0.1:4310
```

本地验证：

```text
GET /api/health      -> {"ok":true,"version":"0.1.0"}
GET /api/issues      -> fixture issue #101
GET /api/tasks       -> 任务列表（stage/lifecycle/patch/PR/running）
GET /api/tasks/:id   -> task + diff + verification + events + review chat
POST /api/tasks/:id/chat             -> SSE 流式回答
POST /api/tasks/:id/approve          -> 审批并通过后台任务创建 PR
POST /api/tasks/:id/request-changes  -> 退回 REPAIR
POST /api/tasks/:id/cancel           -> 取消并收敛
```

页面包含：Issue 创建任务、任务列表、概览、diff、验证证据、评审对话、通过/要求修改/取消按钮。当前是原生 HTML/JS + SSE，React 工作台可后续替换。

## 8. 重新生成


```bash
npm test
npm run demo:fix
npm run demo:fault
npm run demo:review -- --llm
npm run demo:swebench -- --limit 2
```

报告位置：

```text
.forgepilot/tasks/<taskId>.json
.forgepilot/tasks/<taskId>/events.jsonl
.forgepilot/tasks/<taskId>/checkpoints/latest.json
.forgepilot/tasks/<taskId>/verifications.jsonl
.forgepilot/artifacts/<sha256>
.forgepilot/review/*.md|json
.forgepilot/swebench/reports/*.md|json
```
