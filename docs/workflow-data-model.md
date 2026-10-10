# Orchard Workflow Data Model

## Existing sources of truth

当前仓储已经包含两套工作流运行相关表定义：`migrations/001-initial.sql` 已包含 workflow、version、run、step、attempt、event、trigger、task、lease 和 schedule 表；`migrations/002-workflow-runtime.sql` 又声明了 apps、workflow_tasks、task_attempts、task_leases、schedules 和 schedule_occurrences。数据库注册顺序由 `src/storage/database.ts` 控制。

工作流定义（名称、描述、触发器、执行策略和并发配置）的唯一事实来源是已发布版本的源码。数据库仅保存发布生成的定义备份，不允许独立修改，读取时也不回退到该备份。运行状态的统一事实来源仍为 Repository 对 SQLite 的事务操作；内存队列只能作为调度缓存，不能作为 Run/Task 的最终状态来源。

| 领域概念 | 当前持久化表 | 主要 Repository/服务 | 说明 |
| --- | --- | --- | --- |
| App | `apps` | `WorkflowRepository` | 工作流所属应用；需确认与 workspace 的边界 |
| Workflow | `workflows` | `WorkflowRepository` | 当前激活版本由 `current_version_id` 指向 |
| Workflow Version | `workflow_versions` | `WorkflowRepository` | 不可变定义、源码路径、bundle 路径和 manifest |
| Draft | `workflow_drafts` | `WorkflowRepository` / authoring | 发布前编辑和校验结果 |
| Run | `runs` | `RunRepository` / `RunCoordinator` | 绑定 `workflow_version_id`，保存运行状态和 claim |
| Step | `step_runs` 或 `workflow_tasks` | `RunRepository` / `WorkflowTaskRepository` | 当前存在旧执行模型和持久化 Task 模型，需要审核后统一 |
| Attempt | `step_attempts` 或 `task_attempts` | 对应 Repository | 每次实际执行和错误/Worker 信息 |
| Lease | `task_leases`、Run claim 字段 | `WorkflowTaskRepository` / `RunRepository` | Worker 接管和 fencing 的持久化边界 |
| Trigger/Event | `triggers`、`incoming_events`、deliveries | `EventRepository` / scheduler | 事件去重和触发投递 |
| Schedule | `triggers` 或 `schedules`、occurrences | `ScheduleRepository` / `PersistentScheduler` | Cron occurrence 必须唯一 |
| History | `run_events` | `RunRepository.appendEvent` | 追加式生命周期事件 |
| Artifact | `artifacts` + 文件目录 | `ArtifactStore` | 文件内容通过 hash 和受控相对路径关联 |

## State invariants

- 每个 Run 必须绑定一个存在且不可变的 Workflow Version。
- `(run_id, step_instance_key)` 或 `(run_id, step_key)` 必须是步骤幂等边界。
- `(task_id, attempt_no)` 必须唯一；同一 Task 同时最多存在一个有效 Lease。
- Lease 回报必须匹配 `lease_id`、Worker 和 lease version；过期回报不得覆盖新 Attempt。
- Run 状态转换必须通过 `assertRunTransition` 或等价事务边界完成。
- History sequence 在单个 Run 内必须单调递增，状态修改和对应 History 事件应位于同一事务。
- Event 去重使用 `(source, event_id)`；Cron 去重使用 `(schedule/trigger, occurrence_key)`。
- 已有 Run 的版本指针不可因工作流新版本激活而变化。

## Required review before migration

审核结论（已确认）：

1. 保留 `step_runs` 作为用户可见的逻辑 Step，保留 `workflow_tasks` 作为 Worker 可领取的执行 Task；两者通过 Run/Step 关联逐步收敛，避免破坏已有运行历史。
2. 保留 `triggers` 处理事件触发，保留 `schedules` 处理 Cron 调度；两者都创建统一 Run，后续通过服务层统一查询。
3. 保留 Run claim 与 Task lease 两级租约：Run claim 保护整个运行协调权，Task lease 保护单个 Worker 执行权；两者都使用超时恢复。
4. 为 `workflow_versions` 增加执行配置快照、artifact 摘要和激活时间字段，保证版本发布和运行加载可验证。
5. 使用增量 migration，不删除或重命名已有表；启动时先备份数据库，迁移失败回滚事务并保留旧版本可用。

当前 `001` 与 `002` 的重复声明保持兼容，不在本次迁移中删除重复表；后续可在数据迁移专项中合并表结构。
