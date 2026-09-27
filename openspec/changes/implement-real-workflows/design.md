## Context

当前 Orchard 已有 TypeScript Workflow SDK、JSON Schema 校验、SQLite Repository、内存 StepRunner、运行协调器、队列、事件 API 和编译器，但执行状态、发布产物和触发调度尚未形成完整闭环。设计需保持本地优先、单实例服务兼容现有安全边界，并允许未来把 Worker 拆到独立进程。详见 `proposal.md` 及本 change 下的 capability specs。

## Goals / Non-Goals

**Goals:**

- 建立以 SQLite 为事实来源的 workflow/version/run/step/attempt 状态模型。
- 采用 Inngest 风格的 server/worker 协作：服务端负责编排和任务租约，Worker 负责执行步骤并回报结果。
- 保证发布、运行、事件投递和步骤完成的幂等性，并支持重启恢复。
- 复用现有 SDK 校验、编译器、CLI 工具注册和 Pi 适配边界。
- 提供 API/CLI/工作台所需的发布、运行、导入导出和观察接口。

**Non-Goals:**

- 本 change 不引入多租户、跨机器分布式数据库或云端托管 Worker。
- 不允许导入包绕过可信 CLI 工具注册、代码校验或 Pi 配置边界。
- 不把任意 HTTP 提交的 schema 或代码直接加载到主服务进程执行。
- 不承诺外部副作用具备事务回滚；取消仅保证 Orchard 内部状态和后续调度停止。

## Decisions

### 1. SQLite 作为状态机事实来源

新增 workflow versions、artifacts、runs、step executions、attempts、leases、events、schedules 和 authoring sessions 的持久化记录，并用事务完成状态转换。现有 UUIDv7、WAL、外键和 Repository 模式继续使用。状态转换由显式允许表约束：queued → running → succeeded/failed/cancelled，attempt 则记录每次实际领取和结果。

选择 SQLite 而不是仅依赖内存队列，是为了重启恢复、审计和幂等唯一约束；选择数据库队列而不是新增 Redis，符合本地优先和零外部服务约束。

### 2. Server/Worker 使用数据库租约协议

Server 将可执行步骤写入任务表，Worker 通过事务按优先级和并发额度领取任务，写入 `lease_id`、`worker_id`、过期时间和 attempt。Worker 定期心跳；完成、失败和取消回报必须携带租约版本，过期回报被拒绝或仅记录为迟到结果。租约扫描器把过期任务重新排队，并保留原 attempt。

默认先在同一 Node 进程内启动 server coordinator 与 worker loop，协议边界使用可复用的内部接口，后续可替换为 HTTP/IPC Worker。相比直接让队列调用 StepRunner，这种方式能统一并发、接管和故障恢复语义。

### 3. 编译产物与发布版本不可变

Authoring 流程将源码限制在 workspace，先执行语法/依赖/Workflow SDK 校验，再由现有 esbuild 编译器生成 artifact；artifact 写入受控目录并记录摘要。发布事务只创建新的不可变版本，激活版本通过指针或状态字段切换，失败不会触碰旧版本。运行记录保存明确的 `workflowVersionId`，因此历史运行不随当前版本变化。

导入包采用带格式版本、manifest、内容摘要和源码/产物的 JSON+文件包结构。先解包到临时目录、校验路径和摘要、验证契约及能力白名单，再在单事务中创建未激活版本；不使用导入包中的绝对路径或任意执行入口。

### 4. 运行编排采用事件驱动的持久化推进

Workflow execution 从触发输入创建唯一 run，协调器根据工作流版本产出的步骤请求推进 DAG/序列执行。每个 `ctx.step` 调用映射到稳定 step key；成功输出写入 attempt/result 表，重复请求先读取已成功结果。重试策略记录退避时间、最大次数和错误类别，不在内存中隐藏尝试。

取消通过数据库取消标记加 AbortSignal 传播实现：协调器不再创建后续任务，Worker 停止可取消的本地执行，并将迟到结果视为非成功回报。外部 CLI 的进程组终止沿用现有实现，但不声称能够撤销外部副作用。

### 5. 调度器只负责产生幂等运行请求

Cron 计算器为每个启用 schedule 生成稳定的 `(scheduleId, occurrence)` key；事件接收先按 `(source, id)` 的唯一约束保存事件摘要，再按订阅创建运行请求。Cron 与事件都不直接执行工作流，而是提交统一的 run command，由 run 唯一键防止重复创建。

调度循环在重启时扫描上次游标到当前时间，并按每个 schedule 的补偿策略处理遗漏；事件内容摘要冲突返回 409 类错误。这样触发器与 Worker 解耦，也能复用同一套观察和重试逻辑。

### 6. Pi agent 仅作为受控 authoring adapter

新增 Pi authoring session：输入包含工作流目标、当前源码和允许修改范围，输出为补丁/文件内容及结构化摘要。适配器只负责调用已配置 Pi，并将结果交给 authoring compiler；编译、依赖白名单和发布审批不委托给模型。会话、调用错误和校验错误持久化，未配置或失败时返回明确错误，不创建版本。

选择补丁/受限文件写入而非让 agent 直接操作 workspace，可限制路径逃逸和无关文件修改；选择先校验再发布则保留人工审查点，并避免模型输出成为可信执行代码。

### 7. API 与工作台按状态机暴露能力

新增工作流草稿/编译/发布、版本列表、运行创建与详情、任务取消、导入导出、schedule 管理和 Pi authoring session 接口；现有 runs/events 接口改为调用统一的持久化 coordinator。响应返回状态、版本、错误和可追踪 ID，长任务使用轮询而不是保持 HTTP 请求。

浏览器先实现列表、编辑/预览、发布、手动运行、导入导出和运行详情；Pi 生成结果必须显示 diff 与校验状态。所有接口继续执行 Host/Origin 校验，并复用本地服务的错误格式。

## Risks / Trade-offs

- [SQLite 写竞争增加] → 使用短事务、WAL、索引和有限轮询退避；不在事务中执行用户代码。
- [租约过期导致非幂等外部副作用重复] → step key/attempt 幂等只能保护 Orchard 状态；对 CLI/Pi 工具明确标记副作用类别，并在文档与 API 中暴露“可能重复执行”语义。
- [导入代码带来执行风险] → 仅允许受控工作区和已批准能力，导入先验证再落地；对不可信代码不直接在主服务加载。
- [迁移破坏现有开发数据] → 新增迁移保持旧表兼容，启动前备份数据库；保留旧只读记录并提供回滚到上一版本的激活指针。
- [单进程 Worker 仍受主进程故障影响] → 所有任务先持久化并使用租约恢复；后续可在不改变任务协议的情况下拆分 Worker。
- [Pi 输出不稳定或耗时] → 设置超时、取消和最大输出，持久化会话错误；没有有效响应时不生成成功 artifact。

## Migration Plan

1. 增加 SQLite migration 和 Repository 状态转换测试，不改变现有查询接口。
2. 将现有已注册工作流转换为草稿/版本记录；没有可恢复源码的历史记录保持只读，不自动激活未知产物。
3. 上线 coordinator/worker loop，默认只处理新发布版本；完成恢复、租约和幂等测试后开启现有手动运行入口。
4. 接入 Cron、事件、导入导出和 Pi authoring API，再启用工作台入口。
5. 回滚时停止调度与新 Worker，恢复旧激活版本指针并保留新增运行记录；数据库迁移通过备份恢复回滚，不删除历史数据。
