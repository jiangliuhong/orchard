# Design

## Compatibility target

本 change 对齐 Inngest 的行为语义：Function/Workflow 由 trigger 启动，业务副作用封装在稳定 Step 中，Step 结果持久化并可 memoize；Sleep、等待事件和重试都释放 Worker；调度策略在创建或领取前持久化计算。不会声称 Orchard 可以直接运行 Inngest SDK，也不会复用 Inngest 私有存储协议。

## Current gaps

1. `/api/events` 目前只接收事件，未调用匹配触发器并创建 Run。
2. `sleep` 默认使用 `setTimeout`，`waitForEvent`、`sendEvent`、`invokeWorkflow` 没有 durable runtime 实现。
3. `PersistentScheduler` 和 `decideSchedule` 没有完整接入服务生命周期、Run 创建和 Task claim。
4. Workflow retry policy 未驱动实际重试；Task retry 参数和 Workflow policy 不一致。
5. artifact 执行路径仍可能使用 `Worker step execution is not configured` 占位实现。
6. WorkerLoop 只有 lease primitive，没有推进工作流状态机、暂停恢复和 Worker health API。

## Decisions

### 1. Durable continuation records

新增或扩展持久化 continuation/pause 记录，至少包含 `run_id`、`step_id`、`kind`、`resume_at`、`event_name`、`match_key`、`status`、`lease` 和唯一幂等键。Sleep、Wait For Event 和 retry 都通过 continuation 释放当前 Worker，再由恢复器创建下一次可执行 Task。

所有数据库结构变更必须先提交字段、索引、唯一约束和回滚方案，完成审核后才能加入 migration 和 `database.ts` 的启用列表。

### 2. Unified trigger delivery

实现统一的 `RunCommand`，事件、Cron、手动和 invoke 都必须携带 trigger identity、workflow version、input、idempotency key 和 parent run（如有）。Run 创建和 trigger delivery 在短事务内完成；重复命令返回既有 Run，不重新执行用户代码。

### 3. Step execution boundary

保留 Orchard 的受控 NodeRegistry/artifact 边界，但提供真正的 durable step adapter。每个 Step attempt 必须带稳定 step key、attempt number、input/output/error 和 execution config snapshot。已成功 Step 只从当前 replay lineage 读取 memoized output；不以 Step ID 字典序推断执行顺序。

### 4. Policy enforcement

将策略计算从纯函数提升为持久化调度决策：

- claim 前检查 global/key concurrency；
- 使用持久化窗口记录 rate limit；
- 使用 token/burst 状态实现 throttle；
- debounce 合并到同一 pending command；
- singleton 在同一 key 上原子地 skip 或请求旧 Run cancel；
- queue 按 priority、created_at 和稳定 ID 排序。

每次 delay、merge、skip、cancel、reject 都追加可查询 History 事件。

### 5. Server + Worker lifecycle

默认服务启动 API、recovery loop、scheduler loop、Run coordinator 和 WorkerLoop。所有 loop 支持关闭、错误隔离和重启恢复。Worker health 查询从持久化 task/lease 状态及当前实例心跳生成；未来可用序列化 claim/result transport 替换同进程调用。

### 6. Event wait delivery

Wait For Event 注册唯一等待条件。事件接收事务先写入去重事件，再原子地匹配一个或多个等待条件并生成 resume command；超时由 recovery loop 生成 timeout result。重复事件或重复恢复只能成功消费一次。

### 7. Validation and rollout

先在不改变数据库的情况下补充协议、状态机和纯逻辑测试；数据库迁移须通过审核后再实现持久化字段。新执行路径在 feature flag 或兼容 adapter 下启用，旧历史 Run 不得静默改变状态。

## Failure handling

- 旧 lease 的 complete/fail/cancel 结果必须被 fencing 拒绝，并追加 stale-result history。
- 调度器创建 Run 后进程崩溃时，occurrence/delivery 唯一键保证重启不会重复创建。
- 导入或发布失败不得改变当前激活版本；临时 artifact 必须清理或保留为可审计 orphan。
- 用户取消必须同时阻止 queued continuation 和新的 Task 创建；已提交外部副作用只记录不可撤销状态。

## Verification

必须包含单元、Repository 并发、重启恢复和 HTTP/API 端到端测试，至少覆盖：重复事件、Cron catch-up、Sleep、Wait For Event、retry backoff、key concurrency、debounce、singleton cancel、child Run、stale lease result、artifact execution 和同进程 Server+Worker。
