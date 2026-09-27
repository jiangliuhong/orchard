## Why

当前 Orchard 的工作流主要停留在 SDK、内存步骤执行和只读工作台层面，尚不能可靠地发布、运行、调度或复用真实工作流。需要建立类似 Inngest server/worker 的执行模型，使工作流可以通过代码或 Pi agent 创建，在本地持久化运行状态，并支持可移植的导入导出。

## What Changes

- 实现完整的工作流 authoring、校验、版本发布与可执行产物管理流程。
- 实现持久化的 workflow run、step、attempt 执行状态，支持重试、取消、幂等和故障恢复。
- 引入 server/worker 风格的任务领取、心跳、并发控制和步骤执行调度模型。
- 实现 Cron 与事件触发器，并将触发投递与运行创建纳入幂等边界。
- 提供工作流定义的导入与导出能力，保留版本、依赖和触发器信息并进行安全校验。
- 支持在系统内通过 Pi agent 编写、校验和发布工作流代码；未配置 Pi 时必须明确失败，不伪造执行结果。
- 完善 HTTP API、CLI 和浏览器工作台，使工作流创建、发布、运行、观察及取消形成闭环。

## Capabilities

### New Capabilities

- `workflow-authoring`: 工作流代码编写、校验、编译、版本化和发布。
- `workflow-execution`: 基于持久化状态的工作流、步骤和尝试执行，包含重试、取消、幂等和恢复。
- `workflow-server-worker`: server/worker 风格的任务队列、领取、租约、心跳、并发与故障处理。
- `workflow-scheduling`: Cron 和事件触发器的注册、调度、投递和去重。
- `workflow-import-export`: 工作流定义、版本和相关元数据的安全导入导出。
- `pi-agent-authoring`: 使用 Pi agent 生成和修改工作流代码，并执行校验与发布流程。

### Modified Capabilities

- None.

## Impact

- 影响 `src/authoring`、`src/runtime`、`src/scheduler`、`src/storage`、`src/server`、`src/web` 和 `src/workflow-sdk`，并需要补充数据库迁移、API 契约和端到端测试。
- 可能增加 Pi 适配及代码沙箱/权限校验相关依赖；工作流执行仍需遵守本地服务安全边界和可信 CLI 工具注册机制。
- 现有仅内存或只读行为将被替换为持久化、可恢复的运行时行为，部分内部 API 和数据模型可能发生不兼容变化。
