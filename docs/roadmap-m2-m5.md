# ForgePilot Roadmap M2–M5

> 当前状态：**M1 已完成**（事件中心 → 仓库定位 → 方案 → 改码 → 验证 → PR + Runtime log 页内的整体时间线 + 全局评审对话）。
> 本文只保存后续计划，不代表已实现。每个里程碑都按「目标 / 交付物 / 验收 / 依赖 / 风险」定义，避免后续开发漂移。

---

## M2：审核与合并闭环

### 目标

把当前 `PUBLISH → DONE` 拆成真正的：

```text
PUBLISH → REVIEW → MERGE → DONE
```

当前 `DONE / DELIVERED` 表示“PR 已创建”，但业务上 Bug 只有在 **PR 合并/关闭并回填事件中心** 后才算交付。M2 解决这个口径问题。

### 交付物

1. **阶段拆分**
   - 新增 `REVIEW`、`MERGE` 阶段；
   - 生命周期新增 `WAITING_REVIEW`、`WAITING_MERGE`；
   - `PUBLISH` 只负责推送分支和创建/核对 PR；
   - `REVIEW` 等待工程师审核；
   - `MERGE` 等待合并；
   - `DONE` 只在 merge webhook/API 核对成功后进入。

2. **审批语义拆分**
   - `approvePatch`：审批变更包 → 允许 PUBLISH；
   - `approveMerge`：审核通过 → 允许 MERGE；
   - 未解决 feedback 时不能 approveMerge；
   - 审批绑定 patchHash + PR headSha，PR 更新后旧审批失效。

3. **PR 合并与 webhook**
   - PR adapter 增加 `getStatus`、`merge`、`findByTaskMarker`；
   - `POST /api/webhooks/gitlab` 或 GitHub webhook：
     - 验签；
     - 处理 `merge_request.merged` / `pull_request.closed`；
     - 按 task marker 关联；
     - 更新 `mergeCommit`、`mergedAt`；
   - 不把“创建 PR”当成“已合并”。

4. **事件中心回填**
   - PR 创建后：`postComment` 回填 PR 链接和验证证据；
   - merge 后：`closeIncident` 回填修复说明/commit；
   - 失败/取消：回填原因，不自动关闭。

5. **审核对话增强**
   - 审核意见绑定 PR headSha；
   - 要求修改 → 新 patch → 新 PR 版本；
   - 对话历史按 `PR revision` 分组；
   - 审核通过后禁止继续要求修改，除非重新打开。

### 验收场景

- PR 创建后任务停在 `REVIEW / WAITING_REVIEW`，不会直接 `DELIVERED`；
- 工程师要求修改 → 回到 REPAIR → 新 patch/PR → 旧审批失效；
- merge webhook 到达 → `MERGE` 核对 headSha → `DONE`；
- 伪造/重复 webhook 不会重复推进；
- PR 被关闭但未合并 → 任务进入 `CANCELLED` 或 `WAITING_INPUT`，不标记已交付；
- 事件中心收到 PR 链接和最终 commit。

### 依赖 / 风险

- 需要真实 GitLab/GitHub 测试仓库或本地 webhook 模拟器；
- 需要明确“平台是否有合并权限”：默认只允许人工合并，平台只核对状态；
- PR 被 force-push / 重新打开时审批失效规则容易漏，需要测试。

---

## M3：真实事件中心与项目绑定

### 目标

把 M1 的本地 fixture 换成真实事件中心接入，并让 service → repo 的映射可管理、可审计。

### 交付物

1. **事件中心适配器**
   - 内部事件中心 / Jira / GitHub Issues / Sentry 至少两种；
   - `listOpenIncidents`、`getIncident`、`postComment`、`closeIncident`；
   - webhook + 轮询兜底；
   - 验签、幂等、快速 202、后台队列。

2. **去重与权限**
   - 去重键：`source + externalId`（或事件中心 event id）；
   - 同一事件重复通知不创建多个任务；
   - 事件来源、项目、service 权限校验；
   - 事件文本不能决定仓库/命令/权限。

3. **项目绑定管理**
   - `ProjectBinding` 持久化：service、repo、base branch、commands、owners、protected paths、预算；
   - 管理页面或 CLI：新增/编辑/禁用绑定；
   - 多候选/缺失 → `WAITING_INPUT`，不猜仓库；
   - 绑定变更写入审计事件。

4. **事件中心状态回填**
   - INGEST 后在事件中心标记“处理中”；
   - PLAN 后回填方案摘要（可选）；
   - PR 创建/合并后回填链接与 commit；
   - 失败时回填失败阶段和原因。

### 验收场景

- 真实事件中心发一条 Bug → 平台创建 INGEST 任务；
- 同一事件重复通知 → 只创建一个任务；
- 无绑定 service → 任务停在 `WAITING_INPUT`，不选择最相近仓库；
- 修改绑定后新任务使用新 base/commands，旧任务不受影响；
- webhook 验签失败被拒绝并记录审计。

### 依赖 / 风险

- 需要事件中心 sandbox 账号与签名密钥；
- 多租户/权限模型要与 M4 的 RBAC 对齐；
- 轮询与 webhook 可能同时到达，必须幂等。

---

## M4：执行安全与生产化

### 目标

从“本地 Node 进程执行”升级为“一任务一沙箱”的企业执行面，并补齐多租户、存储和成本治理。

### 交付物

1. **沙箱执行面**
   - 一任务一容器（Docker/K8s Job）；
   - 工作区挂载、资源限制、超时、OOM 回收；
   - 网络策略：只放行模型 API + 代码托管 + 必要依赖源；
   - 只注入 scoped 短期凭据，不进入 Prompt/日志；
   - 禁止宿主机 bash，工具执行在容器内完成。

2. **持久化升级**
   - Postgres：Task、Operation、Checkpoint、Verification、Lease、Audit；
   - 对象存储：artifact、patch、测试日志；
   - 跨节点租约与 CAS；
   - 任务/制品保留策略与清理。

3. **多租户与 RBAC**
   - TeamSpace / owner/admin/member/viewer；
   - 项目、任务、审计、事件按 space 隔离；
   - 审批/合并权限矩阵；
   - 敏感操作二次确认。

4. **成本与配额**
   - 每任务/每 teamspace 的 token、工具、墙钟、并发预算；
   - 超预算暂停/降级/人工审批；
   - 成本看板与账单口径（含失败重试和 review chat）。

5. **审计与运维**
   - 审计 JSONL/CSV 导出；
   - trace_id 贯穿 webhook → task → agent → PR；
   - 健康检查、指标、告警、日志保留；
   - 版本灰度与回滚。

### 验收场景

- 任务容器内执行，宿主机无残留进程/临时凭据；
- 容器被杀 → 任务进入恢复流程，不重复 PR；
- 两个执行器并发接管 → 租约 epoch 阻止旧执行器写入；
- viewer 无法审批/合并；
- 超预算任务暂停，恢复后预算不重置；
- 审计导出能还原完整链路。

### 依赖 / 风险

- 容器镜像、依赖缓存、网络策略需要基础设施配合；
- 迁移存储时不能破坏现有 task/artifact 兼容性；
- 沙箱内工具权限与 pi 进程权限必须重新核对。

---

## M5：质量评估与运营闭环

### 目标

把“能跑”变成“可持续验证效果”：官方 SWE-bench、Review 评估、回归门禁和线上反馈闭环。

### 交付物

1. **SWE-bench 官方 Harness**
   - Docker 化官方评估；
   - 数据集 revision、instance_id 清单、镜像固定；
   - baseline / 检索增强双臂；
   - F2P/P2P 判定、失败分类、Token/工具/墙钟成本；
   - 预测补丁与报告归档。

2. **Review 评估进入 CI**
   - 固定标签集版本；
   - 每次策略改动跑 Precision/Recall/未决项；
   - 误报/漏报根因归类；
   - 人工仲裁队列；
   - 回归门槛：P/R 下降超过阈值阻止合并。

3. **线上反馈闭环**
   - 工程师审核结果（通过/要求修改/拒绝）回写；
   - PR 合并率、返工率、平均处理时间；
   - 模型/工具/检索策略的 A/B 或灰度；
   - 失败样本进入评测集候选；
   - 不把线上业务指标和 SWE-bench 分数混为一谈。

4. **模型路由与成本**
   - 按阶段选择模型（PLAN/REPAIR/REVIEW chat/Judge）；
   - 预算与质量权衡；
   - Judge 独立模型/固定提示词/版本记录；
   - 降级与 fallback 可观测。

5. **可观测性与 SLO**
   - 任务成功率、阶段耗时、重试率、恢复成功率；
   - 上下文压缩收益、artifact 命中；
   - PR 创建/合并延迟；
   - 告警与仪表盘。

### 验收场景

- 固定样本上能复现一份官方 harness 报告；
- 策略改动触发 Review P/R 回归检查；
- 失败任务可归因到阶段/工具/模型/环境；
- 线上审核反馈进入下一轮评测集；
- 成本报告包含失败尝试和 review chat，不虚报收益。

### 依赖 / 风险

- 官方 harness 需要 Docker 与数据集下载；
- 公开 benchmark 存在训练污染，企业任务不能直接套用；
- 线上指标受人工流程影响，不能替代离线对照。

---

## 推荐执行顺序

```text
M2  审核/合并闭环          ← 先把交付语义补完整
M3  真实事件中心/绑定      ← 再把入口和权限做实
M4  沙箱/存储/RBAC/成本    ← 再做生产化
M5  官方评估/反馈闭环      ← 最后做持续质量
```

## 当前不做

- 不 fork OpenHands / ForgePilot Studio；
- 不把流程控制放进 pi；
- 不在 M2 前引入 K8s/多租户；
- 不用 SWE-bench 分数替代企业业务指标；
- 不自动合并未经人工审批的 PR。

## 相关文档

- [详细设计](design.md)
- [pi 学习手册](pi-study-guide.md)
- [本地 Demo 证据](demo-evidence.md)
- [README](../README.md)
