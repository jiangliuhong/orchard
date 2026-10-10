# Design

## Context

Orchard 已具备 TypeScript Workflow SDK、事件接口、队列/协调器、编译器和 SQLite 存储基础，但本 change 需要把它们统一为可恢复的工作流运行时。具体需求见 `proposal.md` 和 `specs/`；本设计只说明实现边界和技术决策。

运行时必须支持两种部署形态：默认单进程内同时运行 Server 与 Worker，以及未来将 Worker 拆为独立进程。工作流执行不能依赖内存状态，历史运行必须绑定不可变版本。任何数据库表结构迁移在实施前都需要按项目规则完成审核。

## Goals / Non-Goals

**Goals:**

- 建立以 SQLite 为状态事实来源、以受控 artifact 为工作流源码和编译产物的持久化运行时。
- 用统一 Run/Task/Lease 协议支持同进程和独立 Worker 模式。
- 用追加式 History 与 Trace 支持恢复、调试、结果查询和从 Step 重放。
- 保证触发、领取、完成、重试、取消和导入发布具备幂等及租约隔离语义。
- 复用现有 SDK、编译器、服务认证、CLI 和 Web 边界。

**Non-Goals:**

- 本 change 不实现跨租户云服务、跨地域调度或外部副作用事务回滚。
- 不允许未经校验的导入源码直接在 Server 主进程中执行。
- 不承诺取消能够撤销已经提交到外部系统的副作用。
- 不在本阶段改变现有数据库表结构而绕过审核流程。

## Decisions

### 1. 采用 Workflow Version、Run、Step、Attempt、Task、History 分层模型

Workflow/Version 保存定义和策略；Run 保存一次执行及其绑定版本；Step 保存逻辑步骤；Attempt 保存每次实际尝试；Task 是可领取的执行单元；History 是不可变生命周期事件；Trace 是面向查询和 UI 的时间线投影。

选择分层模型而不是把所有状态放在一个 Run JSON 中，是为了支持按状态分页、步骤级重试、租约竞争、并发约束和故障恢复。Run 的当前状态可以作为查询投影，但 History 是恢复和审计依据。

### 2. 采用事件驱动的 durable state machine

所有 Event、Cron、手动执行和子工作流调用都先产生幂等的 Run command。协调器根据当前 Run 状态和版本定义生成 Task；Worker 完成 Task 后提交带 lease/version fencing 的结果，协调器再推进下一个状态。

Sleep、Wait For Event 和重试不会阻塞 Worker，而是保存 `resume_at` 或匹配条件并释放任务。恢复器扫描到期任务和等待事件，重新生成推进命令。选择状态机而不是长连接执行，是为了让 Node 进程重启、Worker 替换和水平扩展不影响长期工作流。

### 3. Server/Worker 使用数据库租约和 fencing

Task 领取必须在事务中完成，写入 `lease_id`、`worker_id`、`lease_expires_at` 和 attempt。Worker 以固定间隔心跳；完成、失败、取消请求携带 lease/version。协调器只接受当前租约结果，迟到 Worker 的回报转为审计事件，不得覆盖接管后的结果。

默认服务启动 coordinator、scheduler 和 Worker loop；内部接口采用可序列化 command/result，未来可由 HTTP/IPC transport 替换，而不改变状态语义。相比直接调用内存 StepRunner，租约协议可以测试和支持进程故障。

### 4. 使用受控 artifact 和不可变版本

Authoring/导入先写入临时目录，检查路径不得包含绝对路径、`..` 逃逸或符号链接，计算逐文件 SHA-256 及树摘要，完成编译和能力白名单校验后原子移动到 artifact 根目录，最后事务登记 Version。运行只加载数据库登记且摘要匹配的 bundle；运行记录保存 version/artifact ID。

导出包包含格式版本、工作流元数据、版本、源码清单、编译产物元数据、触发器和摘要，但不暴露内部绝对路径。导入失败不改变当前激活版本；未被数据库引用的临时 artifact 由延迟 GC 清理。选择不可变 artifact 而不是覆盖文件，是为了避免运行期间发布新版本破坏可重放性。

### 5. 调度约束作为独立策略层

事件去重和 Cron occurrence 使用唯一键；并发、Rate Limit、Throttle、Debounce、Singleton 和优先级在创建/领取 Task 前计算。策略结果只能是创建、排队、延迟或拒绝，不直接执行用户代码。队列索引和调度游标需要支持重启补偿。

这样可以避免把调度策略散落在 Worker，并保证等待、重试和人工运行复用同一套队列与观察 API。策略表达式在发布时校验，在运行时只读取已校验版本。

### 6. History 是事实事件，Trace 是查询投影

每个状态转换先追加 History 事件，再更新当前状态；Trace 由步骤开始/结束、错误、等待和父子关系生成。结果输出支持按需读取，Run 列表默认返回元数据而不加载大输出。选择该分离是为了同时满足恢复的完整性和 UI 查询的低成本，并允许后续替换 Trace 存储而不改变执行契约。

### 7. 管理 API、CLI 和 Web 共享同一服务契约

工作流新建、校验、发布、启停、手动运行、导入、导出和 Run 控制都通过受保护服务接口完成；CLI 和 Web 只作为客户端。长时间 authoring、编译和导入操作返回 operation ID，客户端轮询状态。服务接口复用现有 Host/Origin、认证和错误格式，禁止 CLI 或 Web 直接修改运行时表。

### 8. 数据库迁移采用可回滚的增量方案

新增表和索引按独立 migration 编号提交，先建立兼容读模型，再切换写入，最后清理旧路径。迁移执行前提交表结构变更说明并等待审核；若审核未通过，不执行迁移或应用数据库变更。运行代码需能识别旧数据并提供明确迁移错误，不静默丢弃历史。

## Risks / Trade-offs

- **[代码重放可能重复外部副作用]** → 强制副作用置于可识别 Step，提供幂等 key，并在文档和校验中区分 Step 外代码。
- **[同进程 Worker 故障会影响 API]** → Worker 使用受限并发和 AbortSignal；任务状态由 SQLite 持久化，未来可拆分独立 Worker。
- **[SQLite 写竞争限制吞吐]** → 使用 WAL、短事务、合适索引和队列批量读取；不在本 change 承诺分布式数据库。
- **[导入产物可能包含恶意代码或路径]** → 临时目录隔离、路径规范化、摘要校验、依赖/能力白名单和发布前人工可见校验。
- **[历史和输出数据过大]** → 输出按需加载、历史分页、保留策略与 artifact/Run 引用检查；不得为优化而删除仍可恢复的事件。
- **[调度策略组合复杂]** → 先定义策略计算顺序和可观测决策结果，所有拒绝、延迟和合并都写入 History/操作日志。

## Migration Plan

1. 完成数据库模型、迁移 SQL 和兼容性说明，并按项目规则审核数据库表结构变更。
2. 先部署只读查询模型和 artifact 校验能力，再启用新的 Run/Task 写入路径。
3. 在 feature flag 下启用同进程 Server+Worker，运行恢复、租约竞争和旧数据兼容测试。
4. 分阶段启用事件/Cron 调度、导入导出和管理 API；旧执行路径在新路径稳定后再下线。
5. 若发布或迁移失败，停止新版本激活，保留旧激活版本和旧 Run；恢复器继续处理已登记的旧任务。

## Open Questions

- 独立 Worker 的远程 transport 在本 change 中先保留内部可序列化接口，具体 HTTP/IPC 协议可在后续部署需求明确后确定。
- Trace 是否使用独立查询表或从 History 实时投影，可在性能基准完成后选择，不改变对外 Trace 契约。
