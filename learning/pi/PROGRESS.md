# 学习进度

> 每完成一个 Block，把 `[ ]` 改成 `[x]`，并在下面追加一条记录。
> 没通过完成标准，不要勾。

## 总进度

- [ ] Block 0：跑通基线
- [ ] Block 1：看懂阶段执行链
- [ ] Block 2：看懂 pi 接入层
- [ ] Block 3：看懂平台四条亮点
- [ ] Block 4：面试口述与追问

---

## Block 0：跑通基线

- [ ] `npm test` 通过
- [ ] `npm run build` 通过
- [ ] `npm run demo:incident` 跑完
- [ ] UI 打开，Trajectory 能点开 tool 记录
- [ ] 知道 `events.jsonl` 在哪里

记录：

```text
日期：
taskId：
看到了什么：
还卡在哪：
```

---

## Block 1：阶段执行链

- [ ] 找到 `agent_turn / tool_call / tool_result / agent_settled / context_metrics`
- [ ] 能画出 `orchestrator → runPiStageAgent → createAgentSession → prompt → settled → dispose`
- [ ] 能解释 `loader.reload()` 的作用
- [ ] 能解释为什么用 `SessionManager.inMemory()`
- [ ] 能解释 `agent_settled` 与 `agent_end` 的区别
- [ ] 能说出哪些事件 subscribe 收不到

记录：

```text
日期：
我画出的链路：
仍然不懂：
```

---

## Block 2：pi 接入层

- [ ] 能解释 `createAgentSession` 的六个关键参数
- [ ] 能解释 `tools` 与 `customTools` 的关系
- [ ] 能解释 extension vs subscribe
- [ ] 能解释 `tool_call` 门禁校验了什么
- [ ] 能解释为什么禁用 `bash/edit/write`
- [ ] 能解释 `content` vs `details`
- [ ] 能说出两个静默失败的坑

记录：

```text
日期：
最关键的三个 API：
最容易踩的坑：
```

---

## Block 3：平台四条亮点

- [ ] 上下文压缩：能讲 3 句话
- [ ] 长任务可靠执行：能讲 3 句话
- [ ] PR Review 评估：能讲 3 句话
- [ ] SWE-bench 评估：能讲 3 句话
- [ ] 能讲一个 `afterPrCreate` 恢复故事
- [ ] 能讲清 Review Chat 只读边界
- [ ] 能说出三个生产化限制

记录：

```text
日期：
四条亮点的共同点：
最容易被追问的点：
```

---

## Block 4：面试口述

- [ ] 3 分钟不卡壳
- [ ] 白板画出调用链
- [ ] 10 个问题至少答出 8 个
- [ ] 能讲一个失败恢复故事
- [ ] 能讲一个“没做/下一步”
- [ ] 没有把 demo 数字说成生产成绩

记录：

```text
日期：
自评（1–5）：
下一次要改：
```

---

## 面试前最后检查

- [ ] 一句话定位能脱口而出
- [ ] 能讲清 pi 与 ForgePilot 的分工
- [ ] 能讲清一个阶段一个 session
- [ ] 能讲清 extension vs subscribe
- [ ] 能讲清幂等键为什么不用 `tool_call_id`
- [ ] 能讲清 Review P/R 与 SWE-bench F2P/P2P
- [ ] 能主动说三个限制

---

## 学习记录

<!-- 每完成一个 Block，在下面追加一项 -->

### YYYY-MM-DD / Block 0

```text
完成：
产出：
问题：
下一步：
```
