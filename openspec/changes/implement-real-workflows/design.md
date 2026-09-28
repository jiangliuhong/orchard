## Context

当前 Orchard 已有 TypeScript Workflow SDK、JSON Schema 校验、SQLite Repository、内存 StepRunner、运行协调器、队列、事件 API 和编译器，但执行状态、发布产物和触发调度尚未形成完整闭环。设计需保持本地优先、单实例服务兼容现有安全边界，并允许未来把 Worker 拆到独立进程。详见 `proposal.md` 及本 change 下的 capability specs。

运行时目标环境为 Node.js（项目要求 Node.js >= 24），Worker 的实现文件采用 TypeScript。默认实例数据根目录为用户主目录下的 `~/.orchard/`，不能把运行状态或工作流产物依赖在仓库工作区中。

## Goals / Non-Goals

**Goals:**

- 建立以 SQLite 为状态事实来源、以 `~/.orchard/` 文件为源码和可执行产物存储的 workflow/version/run/step/attempt 模型。
- 采用 Inngest 风格的 server/worker 协作：服务端负责编排和任务租约，Node.js/TypeScript Worker 负责加载受控运行文件、执行步骤并回报结果。
- 保证发布、运行、事件投递和步骤完成的幂等性，并支持重启恢复。
- 复用现有 SDK 校验、编译器、CLI 工具注册和 Pi 适配边界。
- 提供 API/CLI/工作台所需的发布、运行、导入导出和观察接口。
- 让数据库记录与文件 artifact 通过版本、相对路径和 SHA-256 摘要稳定关联。

**Non-Goals:**

- 本 change 不引入多租户、跨机器分布式数据库或云端托管 Worker。
- 不允许导入包绕过可信 CLI 工具注册、代码校验或 Pi 配置边界。
- 不把任意 HTTP 提交的 schema 或代码直接加载到主服务进程执行。
- 不承诺外部副作用具备事务回滚；取消仅保证 Orchard 内部状态和后续调度停止。
- 不将 `~/.orchard/` 下的 TypeScript 文件视为任意用户脚本入口；Worker 只能加载数据库已登记且摘要匹配的版本文件。

## Decisions

### 1. SQLite + `~/.orchard/` 文件作为本地持久化边界

新增 workflow versions、artifacts、runs、step executions、attempts、leases、events、schedules 和 authoring sessions 的持久化记录，并用事务完成状态转换。现有 UUIDv7、WAL、外键和 Repository 模式继续使用。

默认目录布局为：

```text
~/.orchard/
├── orchard.db
├── artifacts/<app-id>/<workflow-id>/<version-id>/manifest.json
├── artifacts/<app-id>/<workflow-id>/<version-id>/source/worker.ts
├── artifacts/<app-id>/<workflow-id>/<version-id>/source/<other-files...>
├── artifacts/<app-id>/<workflow-id>/<version-id>/bundle/worker.mjs
├── imports/
├── tmp/
└── logs/
```

SQLite 保存状态、App/Workflow/版本、artifact 相对路径、内容摘要、编译器版本和生命周期状态；源码目录、编译产物目录及较大的导出内容保存为文件。数据库中的路径只能是相对于实例根目录的规范化路径，禁止绝对路径、`..` 逃逸和符号链接逃逸。启动时创建目录并设置合理权限；数据库迁移、artifact 写入和清理均通过 Repository/Store 完成。

一个 App 可以包含多个 Workflow。每个 Workflow 以其源码目录中的 `worker.ts` 作为约定入口；复杂 Workflow 可以通过相对路径导入同一目录下的其他 TypeScript 文件、资源和受控模块。每个发布版本保存完整源码目录及编译后的 Worker bundle，但运行时只加载经过摘要校验的 `bundle/worker.mjs`。

选择 SQLite 而不是仅依赖内存队列，是为了重启恢复、审计和幂等唯一约束；选择本地文件而不是把 TypeScript 内容全部塞进 SQLite，是为了保留可审查、可校验的 Node.js Worker 文件，并避免大文本与状态事务混在一起。

### 2. Node.js/TypeScript Worker 文件与 artifact 生命周期

Authoring 流程以一个 Workflow 目录为单位，在临时 workspace 中生成或修改 `worker.ts` 及其相对导入的其他文件，执行语法、依赖、Workflow SDK 和能力白名单校验，再由现有编译器生成可执行 bundle。`worker.ts` 是可审查、可导出和可重新编译的源码入口；`worker.mjs` 是运行时唯一加载的编译产物，不能把 TypeScript 源码直接作为任务请求提供的执行入口。

发布时先将完整源码目录、`manifest.json` 和 `bundle/worker.mjs` 写入 `~/.orchard/tmp/<operation-id>/`，为每个文件计算 SHA-256，并额外记录源码树摘要和 bundle 摘要。校验完成后，以原子 rename 将整个版本目录移入 `artifacts/<app-id>/<workflow-id>/<version-id>/`，最后在 SQLite 事务中登记不可变版本。任何编译或校验失败都不得改变当前激活版本。

Worker 启动或领取任务时，只接受数据库中处于可执行状态的版本；根据登记的 artifact 根目录和 manifest 解析到 `~/.orchard/` 内，重新计算源码清单、manifest 和 bundle 摘要，并校验 App、Workflow、版本和入口后加载 `bundle/worker.mjs`。Worker 不接受任务携带的任意文件路径，也不从 HTTP 请求直接 import 源码。步骤代码只能通过受控 Workflow SDK、已注册 CLI 工具和运行上下文访问系统能力。

文件与数据库采用“先临时目录、后原子移动、最后提交元数据”的发布顺序。若编译或校验失败，删除对应临时目录；若最终目录已移动但 SQLite 事务失败，则保留该目录并标记为候选孤儿。启动恢复和后台 GC 扫描未被数据库引用的 artifact，仅在至少 24 小时宽限期后删除；任何仍被版本、运行或导出任务引用的目录不得删除。

文件与数据库采用“先文件、后元数据提交”的发布顺序；清理使用引用计数/版本状态和延迟删除，避免仍被运行引用的文件被删除。导入同样先写临时目录、验证路径和摘要，再复制到受控 artifact 目录。

### 3. Server/Worker 使用数据库租约协议

Server 将可执行步骤写入任务表，Worker 通过事务按优先级和并发额度领取任务，写入 `lease_id`、`worker_id`、过期时间和 attempt。Worker 定期心跳；完成、失败和取消回报必须携带租约版本，过期回报被拒绝或仅记录为迟到结果。租约扫描器把过期任务重新排队，并保留原 attempt。

默认先在同一 Node.js 进程内启动 server coordinator 与 TypeScript Worker loop，协议边界使用可复用的内部接口，后续可替换为 HTTP/IPC Worker。相比直接让队列调用 StepRunner，这种方式能统一并发、接管和故障恢复语义。

### 4. 编译产物与发布版本不可变

发布版本包含 App/Workflow 标识、完整源码目录、manifest、`worker.ts` 入口、编译后的 `worker.mjs`、依赖能力、编译器版本、逐文件 SHA-256 和源码树/bundle 摘要。运行记录保存明确的 `workflowVersionId` 与 artifact 标识，因此历史运行不会随当前版本变化。版本激活只切换数据库指针，不能覆盖已发布目录。

导入包采用带格式版本、App/Workflow 元数据、manifest、内容摘要和源码/产物目录的 JSON+文件包结构。先解包到 `~/.orchard/tmp/`，校验路径、目录清单和摘要，验证契约及能力白名单，再在单事务中创建版本并立即将其设为该 Workflow 的激活版本；不使用导入包中的绝对路径或任意执行入口。若激活事务失败，保留 artifact 进入孤儿 GC 流程，已有激活版本保持不变。

### 5. 运行编排采用事件驱动的持久化推进

Workflow execution 从触发输入创建唯一 run，协调器根据工作流版本产出的步骤请求推进 DAG/序列执行。每个 `ctx.step` 调用映射到稳定 step key；成功输出写入 attempt/result 表，重复请求先读取已成功结果。重试策略记录退避时间、最大次数和错误类别，不在内存中隐藏尝试。

取消通过数据库取消标记加 AbortSignal 传播实现：协调器不再创建后续任务，Worker 停止可取消的本地执行，并将迟到结果视为非成功回报。外部 CLI 的进程组终止沿用现有实现，但不声称能够撤销外部副作用。

### 6. 调度器只负责产生幂等运行请求

Cron 计算器为每个启用 schedule 生成稳定的 `(scheduleId, occurrence)` key；事件接收先按 `(source, id)` 的唯一约束保存事件摘要，再按订阅创建运行请求。Cron 与事件都不直接执行工作流，而是提交统一的 run command，由 run 唯一键防止重复创建。

调度循环在重启时扫描上次游标到当前时间，并按每个 schedule 的补偿策略处理遗漏；事件内容摘要冲突返回 409 类错误。这样触发器与 Worker 解耦，也能复用同一套观察和重试逻辑。

### 7. Pi agent 仅作为受控 authoring adapter

新增 Pi authoring session：输入包含工作流目标、当前源码和允许修改范围，输出为补丁/文件内容及结构化摘要。适配器只负责调用已配置 Pi，并将结果交给 authoring compiler；编译、依赖白名单和发布审批不委托给模型。会话、调用错误和校验错误持久化，未配置或失败时返回明确错误，不创建版本。

选择补丁/受限文件写入而非让 agent 直接操作 workspace，可限制路径逃逸和无关文件修改；选择先校验再发布则保留人工审查点，并避免模型输出成为可信执行代码。

### 8. API 与工作台按状态机暴露能力

新增工作流草稿/编译/发布、版本列表、运行创建与详情、任务取消、导入导出、schedule 管理和 Pi authoring session 接口；现有 runs/events 接口改为调用统一的持久化 coordinator。响应返回状态、版本、错误和可追踪 ID，长任务使用轮询而不是保持 HTTP 请求。

浏览器先实现列表、编辑/预览、发布、手动运行、导入导出和运行详情；Pi 生成结果必须显示 diff 与校验状态。所有接口继续执行 Host/Origin 校验，并复用本地服务的错误格式。

## Risks / Trade-offs

- [SQLite 写竞争增加] → 使用短事务、WAL、索引和有限轮询退避；不在事务中执行用户代码。
- [文件与 SQLite 元数据短暂不一致] → 发布采用临时目录、摘要校验、原子 rename 和最后提交元数据；启动扫描未登记或缺失文件并标记为不可执行，不静默执行。
- [租约过期导致非幂等外部副作用重复] → step key/attempt 幂等只能保护 Orchard 状态；对 CLI/Pi 工具明确标记副作用类别，并在文档与 API 中暴露“可能重复执行”语义。
- [导入代码带来执行风险] → 仅允许 `~/.orchard/` 内受控工作区和已批准能力，导入先验证再落地；对不可信代码不直接在主服务加载。
- [用户目录权限或磁盘空间不足] → 启动时检查根目录可读写性，写入前检查空间并返回可识别错误；不删除已激活版本作为自动恢复手段。
- [迁移破坏现有开发数据] → 新增迁移保持旧表兼容，启动前备份数据库；保留旧只读记录并提供回滚到上一版本的激活指针。
- [单进程 Worker 仍受主进程故障影响] → 所有任务先持久化并使用租约恢复；后续可在不改变任务协议的情况下拆分 Worker。
- [Pi 输出不稳定或耗时] → 设置超时、取消和最大输出，持久化会话错误；没有有效响应时不生成成功 artifact。

## Open Questions / Resolved Decisions

### Resolved Decisions

- **数据库文件名**：使用 `~/.orchard/orchard.db`，与现有实现保持一致。
- **App 与 Workflow 层级**：一个 App 可以包含多个 Workflow；Workflow 版本和 artifact 按 App、Workflow、Version 三层隔离。
- **源码组织**：每个 Workflow 的源码以目录保存，`worker.ts` 是约定入口；可以包含任意数量的受控相对导入文件，但所有文件必须出现在 manifest 清单中。
- **运行入口**：运行时只加载编译后的 `bundle/worker.mjs`，不直接执行 `worker.ts`。源码用于审计、导出和重编译。
- **完整性校验**：manifest、源码目录中的每个文件和 bundle 都记录 SHA-256；运行前必须校验 bundle 及其 manifest。
- **发布失败清理**：临时目录立即清理；已移动但未成功写入 SQLite 的目录进入至少 24 小时宽限期后的孤儿 GC，不影响当前激活版本。
- **导入行为**：导入验证成功并完成 SQLite 事务后立即激活导入版本；事务失败时旧激活版本保持不变。

### Open Questions

无。上述决策作为 task 阶段的实现约束；如果后续需要改变这些行为，应先更新 design、specs 和 tasks。

## Migration Plan

1. 增加 SQLite migration、实例目录初始化和 artifact store；默认使用 `~/.orchard/`，支持显式配置根目录用于测试。
2. 增加 Repository 状态转换及文件摘要/路径安全测试，不改变现有查询接口。
3. 将现有已注册工作流转换为草稿/版本记录；没有可恢复源码的历史记录保持只读，不自动激活未知产物。
4. 上线 coordinator/Node.js TypeScript Worker loop，默认只处理新发布版本；完成恢复、租约、文件校验和幂等测试后开启现有手动运行入口。
5. 接入 Cron、事件、导入导出和 Pi authoring API，再启用工作台入口。
6. 回滚时停止调度与新 Worker，恢复旧激活版本指针并保留新增运行记录；数据库迁移通过备份恢复回滚，不删除历史 artifact 或历史数据。
