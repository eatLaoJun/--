# 学习笔记

> 每个 Block 结束后写三行，不要写长篇总结。
> 当前 Block 之外的问题放到 Parking Lot。

## Block 0：基线

### 三行结论

1. 这个项目解决的问题是：
2. 我第一次看到的执行链路是：
3. 我还不懂的是：

### 观察记录

```text
taskId：
页面：
events.jsonl 里的关键事件：
```

### Parking Lot

-

---

## Block 1：阶段执行链

### 三行结论

1. 这个模块解决：
2. 它用了 pi 的：
3. 去掉它，系统会坏在：

### 调用链

```text
orchestrator.
  → runPiStageAgent
    → loader.reload()
    → createAgentSession(...)
    → session.subscribe(...)
    → session.prompt(...)
      → pi.on("before_agent_start")
      → pi.on("context")
      → pi.on("tool_call")
      → pi.on("tool_result")
    → agent_settled
    → session.dispose()
```

### 必须回答

- `loader.reload()` 不调用会怎样？
- 为什么用 `SessionManager.inMemory()`？
- `agent_settled` 和 `agent_end` 的区别？
- 哪些事件 subscribe 收不到？

### 我的回答

```text

```

### Parking Lot

-

---

## Block 2：pi 接入层

### 三行结论

1. `createAgentSession` 的核心是：
2. 扩展层和 subscribe 的边界是：
3. 工具门禁的关键是：

### 关键 API / 事件

| 名称 | 作用 | 易错点 |
|---|---|---|
| `createAgentSession` | | |
| `DefaultResourceLoader` | | |
| `SessionManager.inMemory` | | |
| `pi.on("context")` | | |
| `pi.on("tool_call")` | | |
| `pi.on("tool_result")` | | |
| `defineTool` | | |

### 静默失败清单

1.
2.
3.

### Parking Lot

-

---

## Block 3：平台四条亮点

### 上下文压缩

```text
解决什么问题：
关键机制：
失败会怎样：
```

### 长任务可靠执行

```text
解决什么问题：
关键机制：
失败会怎样：
```

### PR Review 评估

```text
解决什么问题：
关键机制：
失败会怎样：
```

### SWE-bench 评估

```text
解决什么问题：
关键机制：
失败会怎样：
```

### 失败恢复故事

```text
场景：afterPrCreate
错误做法：
正确恢复：
幂等键：
```

### Parking Lot

-

---

## Block 4：面试口述

### 3 分钟录音自评

- 时长：
- 卡壳点：
- 需要删掉的口头禅：
- 下一次改进：

### 10 个问题自评

| # | 问题 | 能答（1–5） | 需要补的点 |
|---|---|---:|---|
| 1 | 为什么用 pi | | |
| 2 | 为什么一个阶段一个 session | | |
| 3 | extension vs subscribe | | |
| 4 | 为什么禁用 bash/edit/write | | |
| 5 | 上下文压缩怎么不丢 | | |
| 6 | 长任务怎么恢复 | | |
| 7 | Review Chat 为什么只读 | | |
| 8 | Review 评估 vs SWE-bench | | |
| 9 | 最大生产化风险 | | |
| 10 | 哪些真实、哪些模拟 | | |

### 面试收尾句

```text
“这个项目我最想展示的不是功能数量，而是边界感：
哪些交给模型，哪些必须由平台控制；
哪些已经用代码验证，哪些还是本地适配器。”
```

### Parking Lot

-
