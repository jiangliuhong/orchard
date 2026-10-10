# Spec Delta

## Purpose

使 Orchard 的 Workflow/Function 执行具备 Inngest 风格的 durable Step、暂停、恢复、重试和重放语义。

## ADDED Requirements

### Requirement: Step execution SHALL be durable and memoized

系统 MUST 为每个 Run 使用稳定 Step ID 和 replay lineage 持久化输入、输出、错误、attempt 和状态；成功 Step 在恢复或重放时 MUST 返回既有结果而不重复执行。

#### Scenario: Resume after restart

- **WHEN** 服务在 Step 完成后、后续 Step 执行前重启
- **THEN** 恢复后的 Run 复用已完成 Step，并只调度未完成 Step

### Requirement: Sleep and wait SHALL release workers

系统 MUST 将 Sleep、SleepUntil 和 Wait For Event 保存为持久化 continuation，并释放当前 Worker；恢复时间到达或匹配事件到达后 MUST 只生成一次 resume command。

#### Scenario: Durable sleep

- **WHEN** Workflow 请求睡眠两小时且服务随后重启
- **THEN** Run 保持 sleeping 状态，重启后不会占用 Worker，并在目标时间后恢复

#### Scenario: Wait for event

- **WHEN** Workflow 等待指定事件和 key
- **THEN** 等待条件可查询，匹配事件只恢复对应 Run 一次，超时则产生可观察的 timeout 结果

### Requirement: Workflow operations SHALL be durable

系统 MUST 提供持久化的 Send Event 和 Invoke Workflow 操作；子 Run MUST 保存 parent Run、调用 Step 和幂等 key，并将结果或错误返回给父 Run。

#### Scenario: Invoke child workflow

- **WHEN** 父 Workflow 调用子 Workflow
- **THEN** 系统创建绑定不可变版本的子 Run，保存 parent_run_id，并在子 Run 完成后恢复父 Step

### Requirement: Retry policy SHALL drive execution

系统 MUST 按 Workflow/Step retry policy 计算尝试次数、backoff、next attempt time 和最终状态，并记录每一次失败及重试决策。

#### Scenario: Retry failed step

- **WHEN** Step 失败且仍有剩余尝试次数
- **THEN** 当前 attempt 标记 failed，Run/Task 进入 retrying，达到 next attempt time 后重新调度且不重复执行已成功的前置 Step

### Requirement: Replay SHALL preserve lineage

系统 MUST 支持从指定 Step 创建新的可追踪 Run，复用该 Step 之前同一 lineage 的成功结果，不修改原 Run，也不得依据 Step ID 的字典序决定执行前缀。

#### Scenario: Rerun from step

- **WHEN** 用户请求从指定 Step 重放
- **THEN** 新 Run 记录 source Run 和 boundary，前置结果按执行 lineage 复用，boundary 及后续 Step 重新执行
