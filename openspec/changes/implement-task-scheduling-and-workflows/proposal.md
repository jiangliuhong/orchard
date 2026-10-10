# Proposal

## Why

Orchard 需要一套可持久化、可恢复且可观察的任务调度与工作流运行时，以支持事件、Cron、人工和工作流间调用等触发方式，并提供类似 Inngest 的 Step 级重试、暂停、等待事件、取消、幂等和重放能力。除作为调度服务外，Orchard 服务本身还应能够直接承担 Worker 职责，并允许用户通过服务 API/CLI 对工作流进行新建、导入、导出、发布、运行和管理，形成不依赖额外进程的完整闭环。

## What Changes

- 建立 Inngest 风格的工作流模型：App、Workflow/Function、Trigger、Run、Step、Attempt、History 和 Trace。
- 支持通过代码定义工作流和稳定 Step ID，动态发现步骤并基于历史结果进行 memoization、重放和恢复。
- 支持 Run、Sleep、SleepUntil、Wait For Event、Invoke Workflow、Send Event、并行步骤等工作流操作。
- 实现事件、Cron、手动和工作流间调用触发器，并提供事件去重、Cron 补偿和统一 Run 创建流程。
- 实现持久化队列与调度器，支持优先级、延迟执行、重试退避、并发限制、按 Key 并发、Rate Limit、Throttle、Debounce 和 Singleton。
- 实现工作流和步骤的超时、取消、取消事件、暂停、恢复、失败、重试和从指定步骤重放。
- 实现 Run/Step/Attempt 的幂等状态转换、租约、心跳、过期接管和服务重启恢复。
- **新增**：Orchard 服务同时提供 Server 与 Worker 能力；默认可在同一服务进程内运行调度器、队列协调器和 Worker，也保留未来拆分独立 Worker 的协议边界。
- **新增**：通过 HTTP API、CLI 和 Web 界面支持工作流的新建、编辑、校验、编译、发布、启用、停用、导入和导出。
- 工作流导入导出应包含定义、版本、触发器、运行配置、源码/可执行产物元数据和完整性摘要，并执行路径、依赖、能力和版本校验。
- 提供工作流列表/详情、版本查看、Run 列表/详情、Step 时间线、History、Trace、输入输出、错误和父子 Run 关系查看能力。
- 提供 Run 取消、重试、从指定 Step 重放和结果查询 API，并保证历史运行绑定不可变的工作流版本。
- 保留 Orchard 现有的安全边界、代码校验、受控工具注册、SQLite 持久化和本地服务访问控制；不得将未经校验的导入代码直接作为主进程任意代码执行。

## Capabilities

### New Capabilities

- `workflow-definition`: 工作流、Function、Trigger、Step、版本和执行策略的定义、校验与发布。
- `workflow-execution`: 基于持久化状态的工作流 Run、Step、Attempt 执行，包含 memoization、重试、暂停、恢复、取消和重放。
- `workflow-scheduling`: 事件、Cron、手动及工作流间调用触发器，以及队列、延迟、优先级、并发、限流、节流、去重和 Singleton 调度。
- `workflow-server-worker`: Server/Worker 任务领取、租约、心跳、接管和同进程 Server+Worker 运行模式。
- `workflow-history-observability`: 工作流、Run、Step 的状态查询、History、Trace、结果、错误、时间线和父子 Run 展示。
- `workflow-management`: 通过服务 API、CLI 和 Web 完成工作流新建、编辑、校验、编译、发布、启停和运行管理。
- `workflow-import-export`: 工作流定义、版本、源码/产物元数据及触发配置的安全导入与导出。

### Modified Capabilities

- None.

## Impact

- 影响 `src/authoring`、`src/workflow-sdk`、`src/runtime`、`src/scheduler`、`src/storage`、`src/server`、`src/web` 及现有 HTTP/CLI API。
- 需要新增或扩展 Workflow、Version、Run、Step、Attempt、Queue Task、Lease、Schedule、Event、History、Trace 和 Artifact 持久化模型及迁移；数据库表结构变更需按项目规则审核后执行。
- 默认单实例服务需要同时启动 Server coordinator、调度器和 Worker loop；内部 Server/Worker 协议应可替换为独立进程或远程 Worker。
- 工作流版本和运行产物需要在数据库与受控本地 artifact 目录之间建立摘要关联，并支持安全导入导出和垃圾回收。
- 现有只读工作流查看、内存步骤执行或简化运行路径将被持久化执行状态机替代，部分内部 API 和行为可能存在不兼容变化。
- 需要补充 API 契约、CLI 命令、Web 页面、端到端测试、故障恢复测试、租约竞争测试、导入导出安全测试和调度一致性测试。
