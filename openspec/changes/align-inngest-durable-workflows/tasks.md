# Tasks

## Apply checkpoint

Blocked on SDK operation identity: `tests/durable-pauses.test.mjs` reproduces parallel branches using the wrong sleep deadline after Step memoization changes arrival order. Explicit stable IDs for sleep/wait/send/invoke and a compatibility decision for existing no-ID signatures are required. The failing regression is retained (not skipped); parallel continuation acceptance and final verification remain incomplete. Database approval has already been received and is not the blocker.

## 1. 基线与兼容边界

- [x] 1.1 固定 Inngest 语义对齐清单：trigger、step memoization、sleep、wait、invoke、retry、flow control、history 和 worker lease；明确不做协议兼容
- [x] 1.2 为现有 Run/Step/Task/Lease 状态定义唯一事实来源和状态转换矩阵
- [x] 1.3 增加当前缺口的回归测试：事件只 intake、scheduler 未启动、占位 Step executor、内存 sleep
- [x] 1.4 更新兼容性文档，说明 Orchard Workflow SDK 与 Inngest SDK 不可直接互换

## 2. 数据模型与迁移审核（必须先审核）

- [x] 2.1 设计 continuation/pause、wait condition、resume command、policy bucket、worker heartbeat 和 parent-child Run 的字段、索引、唯一约束及回滚方案
- [x] 2.2 评审 `docs/workflow-data-model.md`，解决旧 `step_runs` 与 `workflow_tasks` 的边界和状态来源冲突
- [x] 2.3 提交数据库结构变更审核记录；审核通过前不得新增 migration 或执行 schema 变更
- [x] 2.4 审核通过后实现增量 migration，并验证空库、已有库、备份、回滚和旧历史兼容

## 3. 统一 Trigger/Run command

- [x] 3.1 定义可序列化 RunCommand，包含 trigger identity、workflow version、input、idempotency key、parent run 和 event context
- [x] 3.2 将 `/api/events` 接入 trigger matcher 和 `deliverMatching`，确保 intake、delivery、Run 创建具有清晰事务边界
- [x] 3.3 实现 manual/event/invoke 的统一版本绑定和重复 command 幂等
- [x] 3.4 实现 event wait 的唯一匹配、消费和 timeout 恢复
- [x] 3.5 增加重复事件、payload conflict、重复 delivery 和并发创建测试

## 4. Durable Step execution

- [x] 4.1 将 `step.run` 接入真实 durable executor，移除 artifact 执行链中的 `Worker step execution is not configured` 占位路径
- [x] 4.2 持久化 Step attempt 输入、输出、错误、稳定 key、执行顺序/lineage 和 memoization 记录
- [x] 4.3 实现 Sleep/SleepUntil continuation，释放 Worker，并由 recovery loop 恢复
- [x] 4.4 实现 Wait For Event、Send Event 和超时分支
- [x] 4.5 实现 Invoke Workflow、parent/child Run 关系和父 Step 恢复
- [x] 4.6 增加并行 Step、服务重启、重复恢复和取消中的 continuation 测试

## 5. Retry、Replay 和取消

- [x] 5.1 将 Workflow/Step retry policy 映射到 Task attempt、backoff、next_attempt_at 和最终状态
- [x] 5.2 统一 retryable error、timeout、cancel 和 lease expiry 的处理，追加 history
- [x] 5.3 为 Step lineage 保存稳定执行顺序，修复 rerun from step 不得使用字典序复制前缀的问题
- [x] 5.4 实现 replay source/boundary/lineage 的持久化，确保原 Run 不变
- [x] 5.5 增加 retry exhaustion、timeout、cancel、rerun 和 late result 测试

## 6. Cron 和 Flow Control

- [x] 6.1 将 PersistentScheduler 接入服务启动、poll、shutdown 和 recovery 生命周期
- [x] 6.2 实现 timezone-aware Cron occurrence、cursor 和 skip/catch_up misfire 行为
- [x] 6.3 将 priority 接入 queue claim，保证稳定排序和公平性
- [x] 6.4 将 global/key concurrency 接入 Run/Task claim，并持久化 key snapshot
- [x] 6.5 实现 rate limit 和 throttle 的持久化窗口/bucket
- [x] 6.6 实现 debounce pending command 合并和 singleton skip/cancel 原子决策
- [x] 6.7 记录所有 scheduling decision，并增加重启、并发和边界时间测试

## 7. Server + Worker 完整闭环

- [x] 7.1 统一 task claim/heartbeat/complete/fail/cancel 协议和 Repository fencing
- [x] 7.2 将 Task 完成结果连接到 Run/Step 状态机和下一任务生成
- [x] 7.3 启动默认同进程 WorkerLoop、scheduler、recovery 和 coordinator
- [x] 7.4 实现 Worker health、queue depth、active lease 和 recovery 查询 API
- [x] 7.5 明确独立 Worker transport 的序列化边界，增加 stale result 和双 Worker 竞争测试
- [x] 7.6 增加服务重启后 queued/running/sleeping/retrying/waiting 的恢复测试

## 8. Observability、API 和管理入口

- [x] 8.1 扩展 History/Trace，展示 pause、retry、schedule decision、parent-child 和 stale result
- [x] 8.2 增加 Run 按 workflow、status、trigger、时间范围筛选和 continuation 查询
- [x] 8.3 API 返回 operation/run/decision 标识，不暴露内部绝对路径或敏感 payload
- [x] 8.4 CLI/Web 增加事件发送、schedule 启停、Run cancel/rerun 和 Worker health 查询
- [x] 8.5 更新 workflow SDK、scheduler、runtime 和运维文档

## 9. 验收

- [x] 9.1 运行 `pnpm typecheck`、`pnpm test` 和 OpenSpec 校验
- [x] 9.2 增加端到端覆盖：event trigger、Cron catch-up、Step retry、Sleep、Wait For Event、parallel、child Run、cancel、rerun、debounce、singleton、key concurrency、lease takeover 和 same-process Server+Worker
- [x] 9.3 验证新版本发布期间旧 Run 仍使用原 Workflow Version
- [x] 9.4 记录 Inngest 语义对齐矩阵、已知差异、数据库审核结果和迁移兼容性
