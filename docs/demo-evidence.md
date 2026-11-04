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

## 6. 重新生成

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
