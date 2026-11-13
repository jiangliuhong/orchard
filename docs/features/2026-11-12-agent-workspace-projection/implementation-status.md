# 实施状态

## 2026-11-12 实际数据目录验收

- 仓库内 `.orchard` 已从 v10 迁移至 v11。迁移作业 `ab5923a4-4417-4466-87e2-1e533174c1dd` 为 `committed`，备份位于 `.orchard/backups/migrations/ab5923a4-4417-4466-87e2-1e533174c1dd`。迁移时通过了备份清单、数据库完整性、外键及业务行保留校验。
- Pi 1.5.2 使用 `openai-codex/gpt-6-sol`。首次提交遗漏了业务脚本，提案未生成。复跑任务 `281f0032-8935-4ac7-bd06-b3feac0e0731` 为 `succeeded`，进程为 `stopped`。提案 `6c7c4481-43e5-4840-ab6e-2df66782d4c0` 只在工作流名称末尾追加「（维护验证）」。用户确认后，应用回执 `ddac00d4-2f34-47c0-aca8-c1fdb9a6729d` 为 `applied`，草稿由修订 0 升至 1。
- 工作流 `workflow-d89d48ed-2c0f-40ca-bc0e-735ee096d20b` 已发布版本 1，版本 ID 为 `2b7356db-e48b-4f6a-a24e-a31ba8fde53e`。发布定义与草稿修订 1 一致。
- 复核时，服务 `127.0.0.1:7443` 的健康检查返回 `ready: true` 和 `schemaVersion: 11`。投影为 `ready`，目标代次和同步代次均为 4。发布脚本 `fm-rex-outbound-api` 和浏览器工具 `fm-rex/outbound_request` 仍因 `QUERY_SENSITIVE_CONTENT` 仅投影受限标记。

两次运行均绑定已发布版本 1。唯一节点「处理输入」和工作流最终输出均与各自输入逐项一致。

| 运行回执 | 输入 | 运行状态 | 节点状态 | 最终输出 |
| --- | --- | --- | --- | --- |
| `5109f5d1-4d3e-4441-9c5b-51d8a93ebc65` | 空对象 `{}` | `succeeded` | `start: succeeded` | `{}` |
| `99beb1d3-b06e-4a3d-9ca0-ede97e38d731` | 含中文、嵌套对象、数组、`false` 和 `null` 的示例 JSON | `succeeded` | `start: succeeded` | 完整原样回传 |

### 受限资源的安全元数据

- 含安全元数据更新的最终 v11 构建在隔离环境完成全量回归，共 1061 项，1055 通过、0 失败、6 跳过。发布锁校验通过，16 条已审核迁移声明与冻结包一致，发布摘要为 `e3fae68e0514f457467c10d872c1357a46fd52cd88d5579ac6f9e170cc78a008`。

- `fm-rex-outbound-api` 的输入 Schema 含两个凭据相关必填参数名，源码在运行时构造 Bearer 请求头。投影标记补充了运行时、结果模式和输出 Schema。
- `fm-rex/outbound_request` 的 `execution.preprocess.code` 在运行时构造 Authorization 请求头。投影标记补充了 HTTP 方法和返回字段。
- 隔离排查未匹配到已知密钥值，也未发现写死的 Bearer 值。安全元数据仍通过原敏感内容检查，命中检查时不进入投影。隔离副本的投影构建、投影数据源和安装器回归共 33 项，全部通过。
- 更新后只读复核实际 `.orchard`，投影为 `ready`，目标代次和同步代次均为 `5`。两个资源的 `contentWithheld: true` 和 `QUERY_SENSITIVE_CONTENT` 标记仍在，安全元数据与定义中的对应字段一致。完整定义和源码仍受限。本次复核未触发运行。

## 2026-11-12 实际迁移前的阶段记录

- v11 已封版。最终隔离全量 1059 项，1053 通过、0 失败、6 跳过。发布锁包含 16 条审核迁移声明，摘要为 `5c11a923442fc2754d02f47589533a4fa2df49ca7cc434aa20d9cb7926fd57a6`。旧 Agent 路由用独立 v10 库验证，当前版本的浏览器写入、恢复与结构断言在 v11 上验证。
- 使用封版构建刷新了仓库内 `.orchard` 的只读迁移预览。检测到 `INSTANCE_LOCKED`，源库仍为 v10。实际目录迁移等待用户单独确认。

- v11 候选的四项指定回归已通过。维护测试复用 v11 已安装的结构，发布锁按版本验证声明数，升级预演使用独立 v10 源库。修复了 v11 计划在源浏览器配置缺失时重复登记同一路径的问题。
- 更新后的隔离 v11 全量回归共 1059 项，990 通过、63 失败、6 跳过，迁移主链通过。随后单独验证的发布锁专项 6 项通过，含历史 SQL 校验和保留 v11 版本的重新封版。剩余全量失败涉及旧 Agent 路由、浏览器配置写入或恢复、旧 UI 夹具及历史结构断言，发布锁维持 v10。

- 工作流、脚本库和浏览器工具的新维护会话使用「设置 → Provider」中 Pi 的 CLI 路径和默认模型。续聊默认使用最近一次提交的模型，也可为下一条消息选择其他已启用的 Pi 模型，保留同一原生会话。开发启动和生产构建都会生成维护扩展与 MCP helper，运行时沿用本机 Pi 的模型和登录配置。
- Chrome 用空提案列表发起工作流、脚本、浏览器工具三项任务。真实 Pi 通过本机模型协议夹具调用 MCP 提案工具，三个页面逐项确认并应用。隔离数据库中三项任务为 succeeded/stopped，三个应用回执已提交，投影同步至代次 5。
- 隔离 v11 候选通过构建、锁校验与生产入口空目录初始化。针对候选的发布回归仍失败，原因包括测试夹具重复安装维护表、写死发布条数，以及迁移预演用例从默认初始化取得 v11 而非 v10 源库。工作区发布锁继续使用 v10。

- 默认服务入口已注入维护授权、恢复和投影安装器。持有数据目录锁的启动恢复会先核对日志，再把已证明退出的遗留任务转为 interrupted 并触发投影重建。任务宿主在结算前关闭 IPC、等待处理回调和进程退出。生产模型任务的提交与经过验证的 Pi 后端仍待接通。
- 工作流草稿、脚本和浏览器工具三个页面已接入按对象筛选的提案审阅。Chrome 在独立回环服务中逐页确认并应用三条预置提案，通过真实维护 API、应用 worker 和业务写入链路。数据库中三条应用均为 applied，投影目标和同步代次均为 5。验收使用临时数据库和启动状态夹具，覆盖范围从预置提案开始。

- 维护进程注册器可在启动前持久登记任务归属和进程组。隔离测试用 SIGKILL 终止原宿主，后继宿主在进程组存活时拒绝出具证明，在核对该组消失后通过。同一次系统启动内，未完成进程组登记的启动仍须保留阻断。生产任务宿主仍需接入日志、IPC 静默验证和任务状态恢复。
- 保留清理 API 根据审阅过的预览摘要执行，保留审计数据至少 90 天和任务展示引用至少 30 天。已接受应用请求的最小回执继续支持原键重试，任务与会话行保留。已验证注入可信宿主时，应用服务会先运行宿主恢复，并通过宿主认证访问清理 API。默认生产入口和三类页面仍待接线。

- 已记录 v11 迁移审核，增加正式迁移声明、升级 SQL、新安装基线和 v10 历史发布快照。隔离发布包以 `--workspace-v11` 生成并通过发布锁校验。隔离数据目录验证了升级预演、安装中断后恢复为 v10、重试提交为 v11，以及全新安装 v11。当前工作区生产包仍锁定 v10，正式切换需完成 Runtime 和页面接线。
- `orchard workspace-migration preview --data-dir <dir>` 对实际目录执行只读预检。仓库内 `.orchard` 的预检识别 2 条草稿绑定、2 个浏览器应用、1 个工具和 1 个待保留的旧会话，发现现有实例锁。生产数据仍在 v10。
- 真实 Pi 以指定 UUID 建立原生会话并调度工具。测试关闭 Pi 和 MCP helper 并核对进程组退出及 IPC 关闭后，新 Pi 进程按准确路径恢复同一 session ID 和消息。进程证明限于持有子进程句柄的宿主实例，异常退出后仍须接入跨重启证明。

- `maintenance-pi-extension.ts` 从继承 fd 安装七项维护工具。`maintenance-pi-launcher.ts` 提供隔离单轮启动，校验 Pi CLI、扩展和 helper 的入口摘要并限制环境。真实 Pi RPC 已通过本机 OpenAI-compatible 协议夹具验证模型响应 → 工具调用 → 工具结果回传，读取和提案提交成功，草稿 revision 保持不变。生产授权、完整依赖包的受信发布证明、原生多轮恢复和跨重启进程退出证明仍待接入。
- 浏览器凭据 Schema 的嵌套字面值会在投影与维护提案入口被拒绝。浏览器工具和应用删除通过 Store 提交屏障统一核对保留工作流的引用，引用仍存在时回滚。
- 已刷新 v10 发布依赖锁，14 条迁移声明逐条一致，类型检查、`npm run migration:check` 和 `npm run build` 通过。最终全量 1052 项，1046 通过、0 失败、6 跳过。下面的旧测试数字保留作为刷新前基线。Workspace Projection 的 v10 → v11 方案见[版本迁移审核稿](./migration-release-review.md)，生产迁移入口尚未激活。

**状态：实施中，整体尚未完成。** 投影、持久化结构、提案/应用服务、文件安装与受限读取、工具协议和独立审阅组件已有实现及测试；业务提交屏障和浏览器数据库事实源选择已接入生产启动路径（仅完整迁入 8 表时启用）；应用/投影 worker 已提供依赖真实宿主 authority 的装配与生命周期入口，不提供默认授权/停机放行。尚未完成真实 Provider/原生会话接线、写入口全部业务语义验收、生产迁移及三类维护页面接入。不能把独立模块测试通过当成已交付生产功能。

数据库结构设计已获用户“确认”，证据、原始审核稿及 SHA-256 见 [database-approval.json](./database-approval.json)。本轮未安装用户数据库新结构，未修改全局 schema 版本、迁移清单或 frozen.ts，未移动旧目录/重置 Agent 数据；它们在工作区原有的用户改动保持不动。

## 1. 已实现代码

| 文件 | 能力与边界 |
|---|---|
| `src/agent/workspace-schema.ts` | 已审 8 表、索引、FK/CHECK/触发器；全项目单活动任务、不可变身份/正文/确认/终态、禁止 INSERT OR REPLACE 绕过。只导出 SQL，不自动迁移 |
| `workspace-identity.ts` | 发布前后使用 workflow.json.id；存在新绑定表时必须有匹配绑定，不自动回填或重命名。无新结构的隔离旧数据读取只做身份预检 |
| `workspace-projection.ts` | 多草稿 `drafts/<draftId>`、当前发布版、按需 `versions/<versionId>`、派生 project.json；版本一致性、路径/大小写冲突及预算；不完整草稿可读但标记依赖不完整 |
| `workspace-projection-source.ts` | 配置读屏障下授权收集；当前/历史脚本准确版本及归属、归档脚本只读依赖、浏览器 live 引用、发布定义/源码一致性；返回前重新授权 |
| `workspace-state.ts` | 新结构准入、目标/已同步代次读取，以及业务事务内部 markDirty；不安装缺失结构 |
| `workspace-files.ts` | 已校验不可变快照的 read/find/ls/字面搜索、分页/返回预算、租约撤销；覆盖 Pi ReadOperations 的 read/access/MIME/stream，禁止退回宿主文件读取 |
| `workspace-installer.ts` | 包内规则 + 业务文件统一安装，数据目录租约、配置写屏障、暂存/fsync/只读权限/目录切换/校验/同步 CAS；损坏阻断、停止证明、独占读取与恢复；不递归猜测清理未知暂存 |
| `maintenance-protocol.ts` | 固定目标/范围和单资源提案信封校验，拒绝额外字段及任意宿主文件补丁 |
| `maintenance-sessions.ts` | 8 表会话/任务内核：精确 owner、actor 隔离、幂等创建/入队、全项目串行、single 单任务、就绪投影/基线绑定、准确 multi 引用、宿主内存 capability、取消/未知退出/停机后结算及重启核对；拒绝异步授权/停机检查。**不启动 CLI，未接生产 Runtime/API；没有默认放行的后端或停止证明** |
| `maintenance-assets.ts` | 三类资源的当前基线、完整候选校验/不可变产物准备与 fsync；保留工作流布局，脚本 id/runtime 固定，浏览器工具删除检查保留工作流引用；不发布或执行业务 |
| `maintenance-service.ts` | 不可变 before/after/diff/hash、主体/目标/任务基线绑定、真实用户决定接口、7 天提案/24 小时确认、预算、幂等 queued 应用、事务内二次授权/确认/基线检查；业务/回执/目标代次同事务 |
| `maintenance-worker.ts` | start/idle/close 生命周期、DB 队列启动恢复、提交后队列/任务结束/dirty 唤醒、失败重试与可选纯投影同步；剥离事件发出者的写权限上下文，关闭等待在途处理，完全不调用模型 |
| `maintenance-composition.ts` + `src/server/app.ts` | 仅迁入模式接受平台代码提供的真实 authority factory；启动前核对停机证明，服务就绪后启动 worker，关闭时先停 worker/宿主再关 Store。没有 authority 却有 queued 请求时明确拒绝就绪，不静默遗留、不假装授权；正式入口尚未提供真实 factory |
| `maintenance-tools.ts` | 短期内存 grant 绑定 actor/session/task/generation/投影，取消/撤销/过期检查；只有 submit/apply/status；MCP 协议处理、结果敏感检查及错误码白名单；grant 撤销中止在途调用。已被独立 stdio helper 使用，**尚未注册到真实 Provider** |
| `maintenance-ipc.ts` / `maintenance-ipc-client.ts` / `maintenance-ipc-wire.ts` | 每任务私有、双向 HMAC 认证的 loopback IPC；reader/MCP 分权、准确快照与实时权限复核、预算/序号/重复连接限制、继承管道 bootstrap；撤销立即关闭 socket/reader/grant，关闭证明等待在途工作。不是 OS 沙箱或 Provider 进程树退出证明 |
| `maintenance-mcp-stdio.ts` | 独立可信 MCP stdio helper，fd 3 接收 bootstrap，stdin/stdout 只有 MCP；不接受连接参数，无环境/文件凭据兜底。真实 Node 子进程已验证握手、工具列表、通知、拒绝资源读取、断管与 IPC 丢失退出；另完成真实 Pi RPC 无模型组合探测，未完成生产/模型调度验收 |
| `maintenance-mcp-client.ts` / `maintenance-pi-tools.ts` / `maintenance-file-protocol.ts` | 私有有界 MCP stdio 客户端、共享读取 Schema、7 个显式 Pi 工具适配器；拒绝 shell RPC、会话切换/分叉、工具集漂移，撤销中止提案提交。真实 Pi 1.5.2 无模型探测通过；只有适配器和测试扩展，**无正式 launcher/生产扩展入口，不构成模型工具调度或进程树证明** |
| `maintenance-processes.ts` | 宿主内存 capability + 准确 task/session/generation 的 POSIX 受管 Node 进程 registry：独立组、显式环境、私有管道、EOF/TERM/KILL 有界停止、真实 exit/close 与组消失核对、回调 drain、停止重入/失败重试。真实 Pi/MCP 无模型探测已改由其管理；**仅证明本实例登记的进程组/回调，不证明逃逸后代、跨重启状态、授权或工具通道关闭，不能单独作为完整 authority** |
| `maintenance-routes.ts` | 用户身份回调下的提案列表、diff、决定、应用和回执 HTTP 注册器；拒绝 actor/confirmed/替换正文等额外字段。**尚未注册进生产 app** |
| `workspace-business-hooks.ts` + `Store.observeTransactions` | 生产启动安装事务观察器；资源/权限元数据提交前检查读取屏障、活动任务和未知退出状态，同事务绑定新草稿、登记 dirty、固定对象失效 tombstone；删除/发布/归档/换草稿后旧会话不可接管重建对象。嵌套提交合并代次，回滚不唤醒；普通展示记录不阻断但仍核对目录租约。部分新表直接拒绝启动，不回退旧模式 |
| `src/web-bridge/database-config.ts` / `configured.ts` | 生产 app、资源收集统一选 DB backend；配置 Git 导出/恢复点/指纹/敏感引用均读 DB；恢复同事务 CAS，不再安装旧 JSON。声明排除 bound/tabAvailable，读接口刷新 DB 视图，禁止损坏时回退缓存/旧文件；无新表时保留旧版兼容 |
| `src/web/agent-chat/MaintenanceProposalReview.tsx` | 复用内置 Dialog/Button/Textarea，确切前后内容、删除后果、hash 确认、撤销、排队/冲突/待同步、丢失响应复用请求 ID；**尚未挂入旧三类 chat adapters** |
| `workspace-migration-preview.ts` | 只读身份/配置/旧 workspace 预检、源指纹、计划 hash、阻断原因；不赋迁移版本、不提供绕过发布审核的执行入口 |

已迁入模式的旧工作流 Agent start、脚本 Agent start/apply、浏览器 Agent start/apply 返回 `LEGACY_AGENT_DISABLED`，包括旧幂等回放，不能用文件 journal 绕过新确认。原生 Runtime 未接好之前不重新开放维护生成。启动遇到持久化活动任务时先拒绝就绪，不调用旧业务恢复假定进程已停。

文件短名均位于 `src/agent/`，另有完整路径的条目除外。`Store.directoryLease` 仅向内部投影服务保留真实数据目录所有权证明，不作为 DTO 返回。

### 文件恢复的归属证据

第一次安装在目录激活后崩溃时，尚无成功 synced_generation。安装器复用既有 `command_receipts` 的保留作用域 `workspace.install` 登记代次/hash/目录 inode，并在私有 tmp 日志只保存 receipt ID；恢复必须与数据库登记及文件身份匹配。该日志不是配置、提案或同步状态的第二份事实源，伪造/无归属目录不被采纳。已完成投影以 DB content_hash 为准；未知/崩溃遗留暂存保留诊断，不自动扫描删除。

### 会话/任务内核与固定对象失效

`MaintenanceSessions` 强制使用已安装业务观察器且持有有效目录租约的 Store。每轮只向后续可信宿主返回本次用户输入、固定目标/基线、投影身份及准确保存的原生引用，不提供平台历史重放、源码注入或“最近会话”查找；公开 DTO 不返回原生引用、内部 capability、输入/输出产物引用或任意原生错误正文。

开始进程前先持久化 `starting`；取消已启动任务只转 `stopping`。未取得宿主对整个 Provider/MCP/读取资源和在途回调的同步停止证明时，保留全局活动任务并将投影置为 `failed/PROCESS_STOP_UNCONFIRMED`。重启不自动把这些任务改为成功/中断。外部证明后的 reconcile 可登记 interrupted，但不能擅自标记工作区 ready，仍需安装器恢复。测试中的后端认证/停机回调都是明确的模拟，**不是实际 CLI 安全验证或生产进程管理实现**。

业务提交前使用既有 `command_receipts` 的保留 scope `maintenance.owner.retired` 登记最小不可逆失效标记，request_id 为 sessionId。工作流草稿删除/发布、脚本删除/归档/固定草稿切换、浏览器应用删除会使相关旧会话只读，即使同 ID 对象后来重建也不能恢复写权。标记与业务和 dirty 同事务回滚；旧提案不能新确认/应用，已排队请求经平台处理后报告 OWNER_UNAVAILABLE 冲突，历史与成功幂等回执仍可读。该标记**不等于用户同意删除原生历史**，不得顺带删除共享目录或原生文件；保留会话期间不能清理该 scope。没有增加表/列/触发器或修改已审 SQL。

私有传输与独立 MCP stdio helper 已实现并有真实连接/Node 子进程测试，但它们不自动提供受认证的 Provider。原生会话删除、同 session 模型切换、完整进程树/跨重启停机证明、Pi 正式可信扩展/受控 launcher、真实宿主 authority factory 与 UI/API 接线仍未完成；应用 worker 生命周期及条件装配已有实现。

### 已确认应用优先级与 worker 装配

存在 queued 应用时，普通页面/Store 业务写入返回 `MAINTENANCE_APPLY_PENDING`，回滚业务和回执；通过配置 writer 的操作在执行副作用前即被拒绝。展示记录、用户确认/撤销和任务状态等纯元数据不改变事实源，仍可提交。只有平台内部的 apply/recovery 意图可消费队列或完成已经提交的恢复，不接受 HTTP/MCP `purpose` 等绕过字段。同步意图即使嵌套于应用独占范围，也不能提交业务定义变更。

事务观察器在外层真正提交后才发送 `maintenance-work`/dirty 唤醒，内层/外层回滚不会发出。worker 剥离事件上下文的重入写权限，启动消费已有队列，维护任务活动时不自等待，任务终止后继续；已应用但同步失败时只重建派生文件，不重放资源更新。关闭先注销监听/定时器并中止在途操作，队列保留到下次启动。新的停机证明失败会持久化 STOP 阻断，即使 DB 活动任务为空也不能继续页面写入；队列重试只能在新的真实证明后转 pending，绝不直接标记旧文件 ready。

`createApp` 的第六个内部参数是每个 Store 的 authority factory（授权、密钥集合、真实停机证明、受控同步及可选 close）。它不是用户配置/API 字段；`server/main.ts` 尚未提供真实 factory。worker 生命周期/条件装配测试使用明确的模拟 authority，不是实际 CLI 证据。有待处理队列而未提供 authority 时启动返回 `MAINTENANCE_RUNTIME_REQUIRED`。隔离 fixture 的 Store 重开测试没有走正式 Bootstrap 迁移验证，不能视为迁移链验收；没有放宽 frozen schema 校验。

### 受管进程 registry 的证据范围

`MaintenanceProcessRegistry` 先同步登记真实 ChildProcess，再处理 spawn/exit/close。每轮 capability 绑定准确归属；有尚未停止的记录时不能启动下一轮。停止先取消回调准入并撤销 lease signal，再依次 EOF、TERM、KILL；所有等待使用单调时间预算。退出 ACK/发信号不算证明，必须等真实 exit、stdio close、已登记回调结算及对应组消失。超时保留阻断，回调真正结算后才能重新核对；abort 监听器重入 stop/close 复用同一 promise。

主进程退出后组仍在时不再按可能复用的 PGID 猜测杀进程；保持 `PROCESS_STOP_UNCONFIRMED`，不得写就绪。只探测本实例实际 detached spawn 所创建的组，观察到消失后永久锁存，不恢复/接管未知 PID。环境不合并 process.env，抑制 Node 隐式继承 NODE_V8_COVERAGE；macOS 编码变量由 OS uid 生成固定安全值，不继承父值。Windows 尚无已验证实现，明确拒绝准入。

此模块不是完整平台停止证明：不能检测逃逸/另建组的未登记后代，也不证明 reader/grant/MCP/授权/跨重启进程状态。正式宿主必须组合进程约束、所有工具通道关闭与回调 drain，另核对持久任务。未接生产 Runtime 或默认 factory；Provider 仍禁用。

### 敏感内容现状

生成器/提案服务沿用保守敏感内容检测，另检查已知密钥值、当前数据根及 home 路径；候选源码在准备产物前即检查，避免被拒提案先落盘。复杂浏览器凭据声明/Schema 的结构化筛选仍需补齐，不能将保守正则称为完整秘密检测或读取权限边界。误报明确拒绝，不静默脱敏后假装完整。

## 2. 验证结果

- `pnpm typecheck` 与 `pnpm exec tsc -p tsconfig.server.json --noEmit` 通过。
- 既有专项覆盖 schema、投影、源收集、安装恢复、提案/应用/worker、MCP/HTTP、审阅组件及只读迁移预览。既有 15 项生产业务接线测试覆盖 create/edit/copy/publish/delete、导入绑定、dirty/回滚、维护 gate、DB 配置与恢复；本轮新增 17 项会话/任务/失效测试，覆盖准确引用与 owner、single、授权/能力变化、取消、未知退出/重启、排队应用优先、原生历史保留、固定对象重建、目录租约和敏感 DTO。本轮另新增私有 IPC/stdio 集成验证（15 项，含子测试），本轮新增应用优先级/worker 生命周期验证（16 项，含子测试），此前专项合跑 **132 项全部通过**。在 Pi 适配器/MCP 客户端与无模型组合探测基础上，本轮补充 12 项真实进程 registry 测试，最新专项 **154 项全部通过**（显式设置真实 CLI 路径，本机 macOS 无 skip）。包含真实连接、独立 Node helper 和 Pi 1.5.2 RPC 探测，不包含付费模型或模型发出工具调用的完整调度链。
- 真实 Pi 1.5.2 的原生 read 默认可越过 cwd；新增 `scripts/probe-workspace-reader.mts` 使用安装包实际工具实现和受限 ReadOperations，验证绝对外部路径、../、未登记文件和已撤销租约均被拒绝。该原生 read 探测无模型调用；另已执行隔离的 Pi RPC 显式测试扩展 + reader IPC + MCP stdio 组合探测，验证 7 工具注册、shell/切换拒绝、读取范围及只提交不应用。测试 input driver 直接执行适配器，不是模型调度或生产安全认证，详见 cli-verification 第 8 节。
- UI 完成 JSDOM 交互测试：精确 hash、取消/Esc、删除后果、queued/待同步、响应丢失重试、撤销。**未做实际页面、主题、长内容和窄屏视觉验收。**
- 首次全量测试 960 项：872 通过、82 失败、6 跳过；macOS `/var` → `/private/var` 临时目录符号链接触发路径/密钥安全检查。
- 本轮真实 TMPDIR 全量：**1049 项中 1020 通过、23 失败、6 跳过**（含真实 Pi 无模型探测）。首次 120 秒预算不足中断，增加至 300 秒后完成；23 项仍集中在发布锁与 `MIGRATION_PACKAGE_CHANGED` 引起的 Bootstrap/迁移阻断；未绕过门禁，不宣称全量全绿。
- `pnpm build` 在 prebuild 报 **Incomplete local dependency lock**，没有进入正式构建/删除 dist；需要后续版本化迁移和运行时切换完成后按项目流程重新审核封版。

```sh
pnpm typecheck
pnpm exec tsc -p tsconfig.server.json --noEmit
node --import tsx --test tests/agent-workspace-schema.test.ts tests/agent-workspace-projection.test.ts tests/agent-workspace-projection-source.test.ts tests/agent-workspace-installer.test.ts tests/agent-maintenance-service.test.ts tests/agent-maintenance-ui.test.ts tests/agent-workspace-preview.test.ts tests/agent-workspace-business.test.ts tests/agent-maintenance-sessions.test.ts tests/agent-maintenance-ipc.test.ts tests/agent-maintenance-mcp-client.test.ts tests/agent-maintenance-processes.test.ts tests/agent-maintenance-worker-lifecycle.test.ts

# macOS 路径安全检查下使用真实临时目录，不放宽检查
TMPDIR="$(node -e 'process.stdout.write(require("node:fs").realpathSync(require("node:os").tmpdir()))')" \
  node --import tsx --test --test-concurrency=4 tests/*.test.ts
```

## 3. 必须继续完成的 P0 编码/接线

1. **维护 Runtime 的生产 composition root**：将已实现的 8 表 Session/Task 内核及条件 worker 装配绑定到真正的全项目 authorizer/用户确认身份、已认证后端、真实进程 registry 和安全投影安装器，提供正式 factory。事件、启动/关闭、确认应用优先级已接线，但 Session/Task/API/真实进程生命周期仍未接入；继续补齐删除依赖、保留/清理及完整业务语义验收，审计详见 write-entry-audit。
2. **真实原生 Runtime**：将已实现的私有 IPC/MCP stdio helper 接入包内可信 Pi 范围工具扩展；验证继承管道认证注入、工具/规则 allowlist、每轮关闭和精确恢复；single 非持久、跨 session 隔离、取消/重试/压缩/子进程未知状态及旧数据删除边界须实际验证。Pi/Codex 未通过时保持关闭，不能用夹具代替证据。
3. **事务屏障后续验收**：浏览器 DB 工厂、配置 Git 的导出/恢复/敏感引用，以及新草稿/copy/import 绑定已接线。仍须核对迁移引擎与备份恢复跨版本路径、非 DB 权限/密钥变更、资产删除依赖与提案失效；仅在 Store 事务内的原生 SQL 受提交观察器覆盖，迁移引擎直接 db 写入必须独立停机。
4. **三类维护页面接入**：新 chat adapters 使用原生会话及 proposalId，不再走旧直接 apply/历史重放；挂载审阅组件，完成实际页面/主题/长内容/窄屏检查。
5. **可执行版本化迁移及清理**：在审阅后的迁移链中确定版本和预检/备份/确认/回滚接线；落实提案保留/最小幂等 tombstone、旧会话和 orphan 诊断清理。当前 preview 明确 executable=false；不能就地安装表或直接运行旧 v11 reset。
6. **发布验收**：完成上述代码后重新审核发布依赖锁与生成包，恢复全量测试/构建；实际生产 DB/目录迁移仍需要独立预览与确认。

本轮没有假装完成这些接线，也没有为了让测试/构建变绿而修改历史审核快照、发布锁或安全检查。
