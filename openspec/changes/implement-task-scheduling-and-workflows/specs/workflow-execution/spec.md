# Spec Delta

## Purpose

为 Orchard 提供可靠的、可恢复的工作流执行语义，使步骤结果、暂停状态、错误和重试能够跨进程重启持续存在并可被用户观察。

## ADDED Requirements

### Requirement: Runs SHALL persist lifecycle state
系统 MUST 持久化工作流运行、步骤、尝试、输入、输出、错误和状态转换，并支持 queued、running、waiting、sleeping、retrying、completed、failed、cancelled 等状态。

#### Scenario: Resume after service restart
- **WHEN** 服务在运行中重启
- **THEN** 未完成运行从持久化状态恢复，已完成步骤不被重复执行

### Requirement: Step results SHALL be memoized
系统 MUST 根据稳定步骤标识复用成功结果或恢复已记录错误，而不是重复执行已经完成的步骤。

#### Scenario: Replay a completed step
- **WHEN** 工作流再次到达已有成功结果的步骤
- **THEN** 系统返回持久化结果并继续执行后续步骤

### Requirement: Execution SHALL support durable workflow operations
系统 MUST 支持可重试运行步骤、定时睡眠、等待事件、调用子工作流、发送事件和可观察的并行步骤。

#### Scenario: Wait for an event
- **WHEN** 工作流执行到等待事件步骤
- **THEN** 系统保存等待条件并释放执行资源，匹配事件到达后恢复该运行

#### Scenario: Sleep without holding a worker
- **WHEN** 工作流执行到睡眠步骤
- **THEN** 系统保存恢复时间并释放 Worker，到期后重新调度运行

### Requirement: Execution SHALL support retries and replay
系统 MUST 按配置进行退避重试，并 MUST 支持从指定步骤重新运行且复用更早步骤的结果。

#### Scenario: Retry a failed step
- **WHEN** 步骤失败且仍有剩余尝试次数
- **THEN** 系统记录失败尝试、计算下一次时间并重新调度该步骤

#### Scenario: Rerun from a step
- **WHEN** 用户请求从某个步骤重放运行
- **THEN** 系统创建可追踪的重放运行，复用指定步骤之前的结果并重新执行该步骤及后续步骤

### Requirement: Execution SHALL support cancellation and timeout
系统 MUST 支持用户取消、取消事件、Singleton 替换取消和执行超时，并停止后续调度、记录原因和最终状态。

#### Scenario: Cancel an active run
- **WHEN** 用户取消正在运行或等待中的 Run
- **THEN** 系统停止可取消执行、阻止新的步骤调度并将 Run 标记为 cancelled

#### Scenario: Run reaches timeout
- **WHEN** Run 或 Step 超过配置的时间限制
- **THEN** 系统记录超时错误并按重试策略处理，耗尽重试后进入 failed 或 timed_out 终态

### Requirement: Parent and child runs SHALL be linked
系统 MUST 保存工作流调用产生的父子 Run 关系及子 Run 结果。

#### Scenario: Invoke a child workflow
- **WHEN** 一个工作流调用另一个工作流
- **THEN** 系统创建带 parent_run_id 的子 Run，并允许从父 Run 查看其状态和结果
