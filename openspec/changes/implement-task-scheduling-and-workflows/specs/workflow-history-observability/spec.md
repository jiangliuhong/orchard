# Spec Delta

## Purpose

为 Orchard 提供从工作流定义到单次运行和步骤时间线的完整可观察能力，支持结果查看、故障诊断、审计和运行控制。

## ADDED Requirements

### Requirement: Users SHALL be able to list and inspect workflows
系统 MUST 提供工作流列表、详情、版本、触发器、执行策略、启停状态和最近运行信息。

#### Scenario: View workflow details
- **WHEN** 用户查看一个已发布工作流
- **THEN** 系统显示其版本、触发器、步骤能力、调度策略和生命周期状态

### Requirement: Users SHALL be able to query runs
系统 MUST 支持按工作流、版本、事件、状态和时间范围分页查询 Run，并提供单个 Run 的输入、输出、错误、状态和父子关系。

#### Scenario: Filter failed runs
- **WHEN** 用户按工作流和 failed 状态查询
- **THEN** 系统返回符合条件的分页结果及可继续查询的游标

### Requirement: Run history SHALL be chronological and complete
系统 MUST 为 Run 保存按时间或序列排序的生命周期、步骤、暂停、重试、取消和结果历史。

#### Scenario: Inspect a failed run
- **WHEN** 用户打开失败 Run 的 History
- **THEN** 系统可以定位触发、每次步骤尝试、错误、退避、恢复和最终失败原因

### Requirement: The system SHALL expose execution traces
系统 MUST 提供 Run 的 Trace/时间线视图，至少包含步骤名称、类型、状态、开始时间、结束时间、耗时和错误信息。

#### Scenario: View parallel steps
- **WHEN** Run 包含并行步骤
- **THEN** Trace 展示其独立生命周期以及与父 Run 的关联，而不是将其合并为不可区分的日志

### Requirement: Observability SHALL respect output access controls
系统 MUST 对输入、输出、错误和历史中的敏感数据执行既定访问控制，并允许查询方选择是否加载大体积输出。

#### Scenario: Query without output
- **WHEN** 用户未请求 Run 输出
- **THEN** 系统返回状态和元数据但不加载完整输出内容
