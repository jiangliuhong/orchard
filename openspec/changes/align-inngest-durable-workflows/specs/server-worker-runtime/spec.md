# Spec Delta

## Purpose

完成同进程 Server+Worker 运行模式，并保留独立 Worker 所需的 lease、heartbeat、recovery 和 fencing 语义。

## ADDED Requirements

### Requirement: Default service SHALL run Server and Worker together

系统 MUST 在默认启动路径中启动 API、scheduler、recovery、coordinator 和 Worker loop；管理 API 创建的 Run MUST 能由同一实例领取并执行。

#### Scenario: Local end-to-end execution

- **WHEN** 用户发布 Workflow 并通过 API 或事件创建 Run
- **THEN** 默认服务可以调度、领取、执行、完成该 Run，并暴露其 History 和 Trace

### Requirement: Task leases SHALL be transactional

系统 MUST 原子地 claim queued Task，写入 task、attempt、worker、lease version 和 expiry；并发 Worker 对同一 Task 最多一个成功 claim。

#### Scenario: Concurrent claim

- **WHEN** two Workers claim the same queued Task concurrently
- **THEN** exactly one transaction succeeds and the other observes no claimable Task

### Requirement: Expired work SHALL be recoverable

系统 MUST 周期性扫描过期 lease、sleep、retry 和 event wait continuation；接管时保留原 attempt/history，并根据 policy 重新排队或终止。

#### Scenario: Worker disappears

- **WHEN** Worker 在执行过程中失联
- **THEN** lease 过期后任务可被新 Worker 接管，旧 attempt 保留为 expired/failed，任务不会永久卡住

### Requirement: Stale results SHALL be fenced and observable

系统 MUST 校验 lease ID、worker ID、lease version 和 attempt；旧 Worker 的迟到成功、失败或取消回报 MUST 不得覆盖当前状态，并 MUST 追加 stale-result history。

#### Scenario: Late completion

- **WHEN** a lease is taken over and the original Worker reports success
- **THEN** the result is rejected and a stale-result history entry is retained

### Requirement: Worker health SHALL be queryable

系统 MUST 提供活动 Worker、活动 lease、队列深度、失败数量、最近 recovery 和实例 heartbeat 的查询接口。

#### Scenario: Health snapshot

- **WHEN** an operator queries Worker health
- **THEN** the response includes active workers, active leases, queue depth, failures, and the last recovery timestamp
