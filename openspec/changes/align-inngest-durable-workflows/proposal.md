# Proposal

## Why

当前 Orchard 已具备 Workflow、Run、Step、Task、Lease、事件去重和 Cron occurrence 的基础实现，但与 Inngest 的 durable function 语义仍有明显差距：事件不会完整触发工作流，Sleep/Wait For Event 仍依赖内存或只有接口，重试与 Flow Control 未接入真实调度路径，Server+Worker 也没有形成完整闭环。

本 change 将以 Inngest 当前公开的核心语义为对齐目标，而不是复制 Inngest 的内部协议或实现语言。重点是让 Orchard 的工作流在重启、Worker 接管和重复投递场景下保持一致、可恢复且可观察。

## What Changes

- 将事件、Cron、手动和子工作流调用接入统一的幂等 Run command 流程。
- 实现持久化 Sleep、SleepUntil、Wait For Event、Send Event 和 Invoke Workflow。
- 让 Step 使用稳定 ID、持久化结果 memoization，并支持正确的 retry、replay 和 parent/child Run 关系。
- 将 concurrency、key concurrency、priority、rate limit、throttle、debounce 和 singleton 接入真实队列/Run 创建路径。
- 完成 Cron scheduler 生命周期、timezone 计算、misfire 补偿和 occurrence 幂等投递。
- 完成 Server+Worker 同进程模式、Task claim/heartbeat/recovery/fencing 和 Worker health 查询。
- 增加面向 Inngest 语义的端到端测试和兼容性说明。
- 数据库表结构变更必须先完成审核；审核前不得执行或默认启用新 migration。

## Goals

- 服务重启不会丢失已持久化的等待、睡眠、重试和队列任务。
- 重复事件、重复 Cron 扫描和迟到 Worker 回报不会产生错误的重复执行。
- 新版本发布不会改变历史 Run 使用的 Workflow Version。
- 用户可以解释 Run 为什么等待、重试、合并、跳过或被取消。

## Non-goals

- 不实现与 Inngest Cloud 的协议、认证或部署兼容。
- 不承诺撤销已经提交的外部副作用。
- 不在本 change 中实现跨地域或多租户云调度。
- 不绕过项目要求的数据库结构审核。

## Impact

影响 `src/workflow-sdk`、`src/runtime`、`src/scheduler`、`src/storage`、`src/server`、`src/cli`、`src/web`、migrations、测试和工作流文档。
