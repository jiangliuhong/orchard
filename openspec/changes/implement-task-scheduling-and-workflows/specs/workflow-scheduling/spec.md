# Spec Delta

## Purpose

为 Orchard 提供统一的事件与时间调度能力，将触发匹配、队列策略和运行创建纳入可恢复且幂等的调度流程。

## ADDED Requirements

### Requirement: The scheduler SHALL support multiple trigger types
系统 MUST 支持事件、Cron、手动和工作流间调用触发器，并将所有触发类型转换为统一的 Run 创建请求。

#### Scenario: Event trigger matches
- **WHEN** 收到匹配工作流触发器和条件的事件
- **THEN** 系统创建对应的可追踪 Run 并将其加入调度队列

#### Scenario: Cron trigger fires
- **WHEN** 到达启用 Cron 的计划时间
- **THEN** 系统创建该时间点唯一的 Run，即使调度器发生重启也不得重复创建

### Requirement: Trigger delivery SHALL be idempotent
系统 MUST 使用事件 ID 和稳定的 Cron occurrence 标识避免重复事件或补偿扫描创建重复 Run。

#### Scenario: Duplicate event
- **WHEN** 相同事件 ID 被投递两次
- **THEN** 系统只创建一次对应的 Run，并返回或记录幂等结果

### Requirement: The scheduler SHALL enforce execution policies
系统 MUST 支持优先级、全局或按 Key 并发、Rate Limit、Throttle、Debounce 和 Singleton 策略。

#### Scenario: Concurrency limit is reached
- **WHEN** 某工作流或 Key 已达到并发上限
- **THEN** 新 Run 按策略等待、进入 backlog 或被拒绝，且不得突破限制

#### Scenario: Singleton cancel mode
- **WHEN** Singleton 工作流已有同 Key 的活动 Run 且新 Run 使用 cancel 模式
- **THEN** 系统取消旧 Run 后调度新 Run

#### Scenario: Debounce events
- **WHEN** debounce 窗口内收到多个相同分组的触发
- **THEN** 系统按配置合并触发并只调度符合规则的 Run

### Requirement: Delayed work SHALL be durable
系统 MUST 持久化延迟、重试、睡眠和等待事件的恢复时间或匹配条件，并在重启后继续调度。

#### Scenario: Recover overdue work
- **WHEN** 服务重启时存在已到期的延迟任务
- **THEN** 调度器将其重新加入队列且不创建重复 Run
