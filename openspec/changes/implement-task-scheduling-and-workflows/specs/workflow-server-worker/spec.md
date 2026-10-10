# Spec Delta

## Purpose

为 Orchard 定义 Server 与 Worker 的统一运行模式，使单个服务可以同时承担调度协调和任务执行，并保留独立 Worker 的可靠接管语义。

## ADDED Requirements

### Requirement: The service SHALL support combined Server and Worker mode
系统 MUST 能在同一服务实例内启动 API、调度器、队列协调器和 Worker，并使用与独立 Worker 相同的任务状态协议。

#### Scenario: Start the default service
- **WHEN** 用户以默认配置启动服务
- **THEN** 服务可以接收管理请求、调度工作流并执行已领取的任务

### Requirement: Workers SHALL claim tasks with leases
系统 MUST 通过带唯一租约的领取操作分配任务，并记录 Worker 标识、尝试次数和过期时间。

#### Scenario: Claim a queued task
- **WHEN** Worker 领取一个可执行任务
- **THEN** 任务原子地变为 leased/running，其他 Worker 不得同时成功领取该任务

### Requirement: Workers SHALL heartbeat and recover expired leases
系统 MUST 支持心跳续租，并在租约过期后重新排队未完成任务，同时保留原尝试记录。

#### Scenario: Worker disappears
- **WHEN** Worker 在租约期间失联且未完成任务
- **THEN** 系统在租约过期后接管并重新调度任务

### Requirement: Late task results SHALL be fenced
系统 MUST 使用租约或版本标识校验任务完成、失败和取消回报，过期 Worker 的迟到回报不得覆盖新尝试结果。

#### Scenario: Stale worker reports success
- **WHEN** 旧租约 Worker 在任务已被接管后回报成功
- **THEN** 系统拒绝其状态覆盖，并保留可审计的迟到回报记录

### Requirement: Combined mode SHALL be operationally observable
系统 MUST 提供 Worker 健康状态、队列深度、租约、失败和接管信息的查询能力。

#### Scenario: Inspect worker health
- **WHEN** 管理端查询运行时状态
- **THEN** 响应包含当前 Worker、活动租约、待执行任务和最近接管信息
