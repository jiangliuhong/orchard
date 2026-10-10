# Spec Delta

## Purpose

将事件、Cron 和 Flow Control 连接到统一的持久化 Run 调度流程。

## ADDED Requirements

### Requirement: Triggers SHALL create idempotent Runs

系统 MUST 支持 event、Cron、manual 和 invoke trigger，并将其转换为统一 Run command；同一事件 ID 或 Cron occurrence MUST 最多创建一个 Run。

#### Scenario: Event trigger delivery

- **WHEN** 收到匹配已启用 Workflow trigger 的事件
- **THEN** 系统记录 event delivery 并创建绑定当前或指定不可变版本的 queued Run

#### Scenario: Duplicate event

- **WHEN** 相同 source/event ID 重复投递
- **THEN** 系统返回既有 intake/delivery 结果，不创建第二个 Run

### Requirement: Cron SHALL be durable and timezone-aware

系统 MUST 使用 Schedule timezone 计算 occurrence，持久化 cursor/occurrence，并按照 skip 或 catch_up misfire policy 在重启后补偿；补偿 MUST 幂等。

#### Scenario: Recover missed Cron occurrence

- **WHEN** 服务重启时存在已到期且未投递的 occurrence
- **THEN** scheduler 按 misfire policy 创建或跳过该 occurrence，且不会创建重复 Run

### Requirement: Flow Control SHALL be enforced before execution

系统 MUST 在 Run 创建或 Task claim 前持久化执行 priority、global/key concurrency、rate limit、throttle、debounce 和 singleton 决策。

#### Scenario: Key concurrency

- **WHEN** 同一 key 已达到并发上限
- **THEN** 新 Run 按策略延迟或进入 backlog，不得领取为 running

#### Scenario: Debounce

- **WHEN** 同一分组在 debounce 窗口内多次触发
- **THEN** 系统合并 pending command，并记录可解释的 merge history

#### Scenario: Singleton cancel

- **WHEN** 同 key 已存在 active Run 且策略为 cancel
- **THEN** 系统原子地请求旧 Run 取消并只调度新 Run

### Requirement: Scheduling decisions SHALL be observable

系统 MUST 为 delay、merge、skip、cancel、reject 和 create 记录 reason、policy key、retryAt（如有）和关联 Run/trigger。

#### Scenario: Explain a delayed run

- **WHEN** a run is delayed by a concurrency or rate policy
- **THEN** history exposes the decision, reason, policy key, and next retry time when one exists
