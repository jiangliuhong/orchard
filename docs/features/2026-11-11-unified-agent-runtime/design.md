# 统一 Agent 对话、知识与工作区

- 状态：设计中（待评审，未实施）
- 创建日期：2026-11-11
- 最后更新：2026-11-11
- 范围：所有 Orchard Agent 调用入口、单轮/多轮语义、知识资产、工作区、生命周期、设置 UI 与兼容迁移。
- 数据库审核：**需要审核，尚未批准。本文仅提出变更；不得据此直接修改表结构、索引、迁移或冻结版本。**

## 1. 目标与核心决策

所有业务场景使用同一套 AgentRuntime，只允许两种对话类型：

1. **single 单轮**：一个对话只接受一个逻辑轮次，使用全新、非持久的 CLI 上下文；不自动携带历史，不允许继续。
2. **multi 多轮**：一个对话可顺序接受多个轮次，固定 Provider、模型、知识版本与工作路径，使用 CLI 原生持久会话。进程可以回收，但后端上下文必须可明确恢复。

不再把“每轮创建新 CLI，然后拼接全部历史”称为多轮。历史重放仅允许用于用户明确发起的**重建操作**，重建产生新的 multi 对话，并记录来源。

统一的是运行机制，不是业务权限：工作流、脚本、Web Bridge 保留各自的 Schema、提案校验和应用流程。项目分析仍是单轮且有独立工具策略。

其他决策：

- 稳定知识在源码目录维护、随安装包分发、启动时初始化，设置页可查看维护。
- 每个逻辑对话一个稳定工作区。创建时只分配身份，首次执行才物化目录。
- 对话记录、CLI 原生会话、可再生成工作区是三类不同资源，分别保留和清理。
- 公共知识使用不可变版本，工作区复制当前场景所需文件，不链接可变公共目录。
- 第一阶段由宿主确定性加载知识，不依赖 CLI 自动发现 Skills，也不默认开启 MCP、扩展或 shell。
- 全部业务入口接入统一运行时；禁止业务模块直接调用 Provider 的 run/openSession。

### 1.1 非目标

- 不新增第三种“重构式多轮”、隐式历史摘要或自动模型降级。
- 不在本需求开放模型直接发布、执行业务脚本、修改平台设置。
- 不将 cwd 当作安全沙箱，不承诺只靠 Markdown 实现访问控制。
- 不同步 CLI 登录凭据、完整用户 home 或模型隐式推理。
- 不在此需求实现任意第三方 MCP 安装市场。平台受控 MCP 的启用设独立验收门槛。

## 2. 当前实现与差异

以下是设计创建时工作树的实际实现，不表示这些行为已经被本方案替换。

| 场景 | 当前上下文模式 | 当前 cwd | 改造结果 |
|---|---|---|---|
| 工作流创作 multi | 原生持久会话 | agent-workspaces/<conversationId> | 保留语义，迁入统一调度 |
| 工作流创作 single | 每轮隔离，同一 UI 对话可有多个调用 | .agent-<随机值> | 每次提交新 single 对话 |
| 脚本创作 | 每轮单次调用，宿主重放历史 | runtime/script-agent/<scriptId>/<turnId> | 新建对话显式选择 single/multi；multi 使用原生会话 |
| Web Bridge 创作 | 每轮单次调用，宿主重放历史 | runtime/web-bridge-agent/<application>/<turnId> | 同上 |
| 普通工作流 Agent 节点 | 单次 | 数据根目录 | single，独立工作区 |
| 项目分析节点 | 单次、开放项目工具 | 临时项目工作区 | single，统一身份与租约，保留项目准备/清理流程 |
| Git 提交说明生成 | 单次 | 数据根目录 | single，独立工作区 |
| 模型验证 | 单次验证提示词 | Provider 内部管理 | single 系统任务，短保留期 |
| CLI readiness 探测/模型目录刷新 | 无模型握手/目录命令 | Provider 内部管理 | 不是对话；仍受全局进程调度 |

现有 `SessionManager` 默认最多 4 个进程、32 个等待请求，等待超时 60 秒，空闲进程 TTL 10 分钟。该能力继续复用；目前进程回收不等于磁盘清理。

代码基线：`src/authoring/service.ts`、`src/authoring/context.ts`、`src/authoring/resources.ts`、`src/authoring/script-agent.ts`、`src/web-bridge/agent.ts`、`src/runtime/runner.ts`、`src/server/app.ts`、`src/providers/session.ts`、`src/providers/session-manager.ts`。

## 3. 用户场景与行为规则

### 3.1 新建对话

创作页面使用统一“新建对话”入口，显式选择：

- 单轮：本次请求独立执行，不记住其他对话。适合一次生成、检查、改写。
- 多轮：继续当前对话上下文。适合澄清、迭代与调试。

创作场景 UI 默认选 multi，但创建 API 必须传 mode，禁止服务端按场景猜测。运行节点、提交说明和模型验证固定 single，不展示无效的模式选择。

single 的请求可以包含当前草稿、测试结果、节点输入等业务数据；这些不是对话历史。每次再次提交产生新的 single 对话。UI 可在同一资源列表展示多个 single，但不得呈现为同一连续对话。

### 3.2 不可变绑定

创建时固定：scenario、资源归属、mode、Provider/模型及配置修订、知识 hash、场景契约版本、工具策略版本、工作区身份。single 与 multi 不允许原地互转。

更换模型、升级知识或变更影响上下文的策略时，用户选择：

- 新建：不带历史；
- 从当前对话重建为 multi：完整导入已保存的可见消息、提案和应用结果，保留来源。

Provider 被禁用、凭据失效等运行限制即时生效，不能因绑定旧版本而绕过。配置改变导致指纹不兼容时暂停继续并要求重建，不静默切换后端。

### 3.3 single 严格语义

- 只允许一个逻辑 turn。数据库唯一性和事务校验同时保障。
- 同一 requestId、相同请求返回原结果/状态；不同内容返回冲突，不重复调用模型。
- 失败后“重试”创建新 single 对话，并记录 retryOf，不向原 single 添加第二轮。
- 模型可能已接受但结果未知时，先展示 interrupted/unknown 状态；不自动重新发费。
- 结束后关闭 CLI 并清理工作区；保留历史按场景政策处理。
- 原生后端不保存可恢复引用：Codex ephemeral，Pi --no-session。若 CLI 意外生成残留，应纳入受管清理，不将其视为可恢复对话。

### 3.4 multi 严格语义

- 每个对话最多一个 queued/running/cancel_requested 轮次；第二个并发提交返回 TURN_ACTIVE，不在该会话背后隐式排多轮。
- 首轮创建持久会话；后续轮次复用原进程或使用准确 backendRef 恢复。
- 进程被空闲回收不改变 multi 类型，不丢失对话身份。
- 每轮发送当前权威业务快照、revision、上一轮宿主结果与新请求；不重复发送整段历史。
- 新进程恢复时重新装载同版本知识，防止仅保留历史消息却缺失规则；具体去重由适配器证明，不假定 CLI 自动保持 system prompt。
- 后端引用永久失效时标记 needs_rebuild；暂时启动失败可再次尝试恢复原引用，但不自动重发已接受的轮次。
- 取消/失败后，仅在后端已确认停止且上下文健康时允许下一轮；无法确认则关闭进程并标记需要检查/重建。
- CLI 原生压缩若存在，属于后端上下文管理，不等同宿主重放。应展示可观测的压缩事件；不得承诺原生上下文永远逐字保存。

### 3.5 重建

重建不是第三种对话类型：新建 multi，第一轮带 `historySource: explicit_rebuild` 与来源链。

导入内容为完整已保存的 user/assistant/error、完整提案、应用状态；不导入隐藏推理、工具原始日志、密钥或未保存内容。当前草稿始终权威。

按统一顺序去重来源链消息，防止重复导入嵌套重建历史。第一阶段提示词预算 512 KiB（包含知识、Schema、快照与导入历史）；超限拒绝并建议新建，不偷偷截断。普通多轮每轮也检查该宿主预算，但它不代表后端累计上下文上限。

## 4. 统一运行时架构

```text
HTTP / Workflow Runner / 系统任务
    → 场景 Adapter（权限、快照、Schema、结果处理）
    → AgentRuntime
        ├─ ConversationService / TurnService
        ├─ KnowledgeService
        ├─ WorkspaceService / Lease
        ├─ ContextComposer
        ├─ ProviderRegistry / SessionManager
        └─ LifecycleService / EventJournal
    → Codex app-server 或 Pi RPC
```

建议新增 `src/agent/`，旧业务服务只保留领域逻辑。统一前端组件继续复用 `src/web/agent-chat/`，不另建视觉体系。

### 4.1 场景契约（示意，不是已实现接口）

```ts
type ConversationMode = "single" | "multi";
interface ScenarioAdapter {
  id: string;
  allowedModes: ConversationMode[];
  knowledgeProfile: string;
  toolPolicy: string;
  contextVersion: number;
  validateOwner(owner: unknown): Promise<void>;
  buildContext(turn: unknown): Promise<unknown>;
  validateResult(result: unknown): Promise<unknown>;
  recordOutcome(result: unknown): Promise<void>;
}
```

运行时不接收客户端任意 cwd、文件路径、工具开关或 MCP 认证。路径和权限由服务端场景契约派生。

执行状态与提案应用状态分开：模型生成成功不等于文件已应用。原工作流自动应用等既有行为可保留，但统一记录 applyStatus、appliedRevision、冲突和错误；脚本/Web Bridge 保持确认流程。

### 4.2 调用时序

1. 权限、owner、mode、资源 revision、知识/Provider 可用性检查。
2. 事务保存幂等请求、对话/轮次、输入摘要和预算结果；single 原子创建唯一 turn。
3. 取得工作区运行租约；固定业务输入快照。动态目录查询时间与修订写入 turn 元数据。
4. 物化知识、准备 workspace；排队等待全局进程槽位。
5. 根据 mode 创建/恢复 CLI；保存 backendRef 和 generation 后才允许继续发送。
6. 记录 sending，发送 prompt；onAccepted 持久化后端接受状态。
7. 消费事件、校验最终输出、记录生成及业务处理结果。
8. 确认本轮终止；single 关闭进程，multi 转空闲；释放租约。
9. 调度清理；清理失败不改写已成功的业务结果，另外记录 cleanup_failed 并重试。

租约、进程槽位和业务写锁职责分离。等待 CLI 槽位时不持有长数据库事务。

### 4.3 状态与异常恢复

- 对话 lifecycle：open / archived / deleted；backendHealth：new / ready / needs_rebuild。single 是否可再次提交由唯一 turn 判断，不滥用 archived 表达已完成。
- UI 当前选中对话是资源级引用，不等于运行状态，也不影响其他历史对话的 backendHealth。
- turn：queued → running → succeeded / failed / cancelled / interrupted；running 可经 cancel_requested。
- submission：not_sent / sending / accepted / settled。sending 时崩溃视为接受状态未知，不自动补发。
- 进程状态：absent / starting / busy / idle / closing，与上述状态独立。

服务重启后，先确认旧受管子进程/进程组已退出，再回收租约。不得只凭 PID 判断归属；使用服务实例 ID、创建信息和进程注册记录。无法确认的工作区隔离为 cleanup_blocked，禁止边恢复边删除。

运行中断记录为 interrupted；保留 backendRef，经过适配器状态检查才能继续。永久不可恢复标记 needs_rebuild。queued 且确认 not_sent 的任务可按既定恢复策略重新排队，任何未知是否接受的任务不自动重发。

## 5. 知识资产与初始化

### 5.1 源码和安装包

```text
src/agent/knowledge/
├── manifest.json
├── AGENTS.md
├── docs/
│   ├── workflow.md
│   ├── script.md
│   └── web-bridge.md
└── .agents/
    ├── skills/
    │   ├── workflow-authoring/SKILL.md
    │   ├── script-authoring/SKILL.md
    │   └── web-bridge-authoring/SKILL.md
    └── mcp.json
```

构建显式复制到 `dist/agent/knowledge/`。当前 npm files 仅包含 dist；发布测试必须检查隐藏目录和所有 Markdown 已进入 tarball。运行时使用模块相对路径定位安装包资源，不依赖启动 cwd 或源码目录。

manifest 包含 formatVersion、bundleVersion、文件路径/bytes/sha256、profiles、每个 profile 必需文件、兼容场景契约版本。内容 hash 按明确排序后的路径和原始文件字节计算；不包含时间戳。限制文件数、总字节、单文件大小、相对路径范围和 UTF-8 格式。

### 5.2 数据布局

```text
<data>/agent/
├── knowledge/                       # 当前可编辑配置，设置页管理
├── knowledge-versions/<hash>/       # 不可变有效版本
├── workspaces/<conversationId>/
│   ├── manifest.json               # 缓存副本，不是权威数据库
│   ├── AGENTS.md
│   ├── docs/
│   ├── .agents/
│   ├── context/                    # 按场景需要物化，默认不落敏感数据
│   ├── project/                    # 仅项目分析，见 §7.3
│   └── tmp/
├── sessions/pi/<conversationId>/   # 与工作区缓存分离
├── staging/
└── trash/
```

全局 conversationId 由服务器生成 UUID，不使用现有场景局部 ID 直接命名。owner 保存资源及旧 ID 的映射。目录权限默认 0700、私有数据文件 0600；权限位只是基本保护，不构成同用户进程间安全隔离。

### 5.3 初始化和升级

数据目录就绪且迁移完成后、接受 Agent 请求前，使用独占初始化锁：

1. 校验包内 manifest 和全部文件。
2. 首次启动写入 staging，验证完整后原子发布 knowledge 和版本记录。
3. 后续启动比较安装版本、上一安装基线与用户当前值，执行三方升级：未修改文件更新；用户修改保留；双边修改产生待解决冲突。用户删除文件也属于修改，不静默补回。
4. 必需文件缺失、解析失败或契约不兼容时禁止发布新知识版本；已有兼容有效版本继续供旧对话使用。不能兼容当前安全策略的旧版本暂停使用。
5. 升级冲突在设置显示；不覆盖用户编辑，也不让新对话使用半升级配置。
6. 发布知识使用 expectedRevision 乐观锁，生成完整快照后原子切换 active hash；与配置恢复操作共用协调锁。

默认内容与用户覆盖的来源记录独立保存，用于恢复默认和升级差异；不能用单个“已初始化”标记跳过未来升级。

### 5.4 加载、分层和版本固定

每个场景 profile 选择：公共规则 + 该场景文档 + Skill。single 创建时绑定 active hash；multi 整个生命周期固定 hash。

物理上复制所需知识到工作区，不用指向可变 knowledge 的软链接或硬链接。被修改的缓存副本在执行前按 hash 检测并重新物化；不能从工作区反向发布知识。

上下文分层：

1. 宿主强制安全策略/场景契约/输出 Schema（代码维护）。
2. 已批准知识资产（文件维护）。
3. 当前业务快照与安全资源目录（动态数据）。
4. 用户请求；仅重建时附加来源历史。

第一阶段使用 `host-inline`：由宿主读取 profile 文件，确定性组装文本。Skill 是场景规则文件而不是自动扩展执行器。静态说明移出 TypeScript，但 Schema、授权、版本检查不迁到 Markdown。

Provider 适配器须验证并控制原生 AGENTS/Skills 自动发现，避免自动加载与 host-inline 重复，以及额外加载用户 home/父目录的未受管规则。若当前 CLI 无法隔离，readiness 必须明确报告能力限制，不可宣称“知识已完全受控”；是否允许该版本上线由兼容性验收决定，不能凭文件布局推断。

未来 `native-files` 只能通过同一 Composer/Adapter 契约启用，需证明两个 Provider 均能读到相同版本、只加载一次且权限一致。不能同时全量 inline 和自动加载相同文件。

### 5.5 动态知识

工作流创作继续注入当前文件、revision、可用模型配置、字典安全元数据、已发布脚本契约和启用 Web Bridge 工具契约；保留现有 `resources.ts` 白名单过滤。

脚本创作注入当前草稿、运行契约、可选测试结果。Web Bridge 注入应用工具快照、所选工具和测试上下文。普通节点只注入声明的 prompt 和绑定输入，不自动获得其他资源。

不把凭据、字典值或用户业务源码复制到共享知识目录。历史禁存场景不得把上下文、prompt、结果或原始诊断落入 workspace、事件日志或 CLI 持久 session；强制 single/no-session，只保留允许的非敏感元数据，临时异常残留亦须清理。

## 6. 平台 MCP 与工具边界

`.agents/mcp.json` 是 Orchard 声明式配置源，不假定 Codex/Pi 原生支持此路径。CLI 参数/配置由 Provider Adapter 转换。

第一阶段默认 `mcp: disabled`；当前 Pi --no-mcp、Codex mcp_servers={} 不因新增文件自动取消。设置可以查看计划能力，但不能显示为已连接。

后续启用仅限内置 allowlist 工具：读取绑定草稿、查询安全资源目录、读取所选测试记录。按会话签发短期能力 token，绑定 scenario、owner、conversationId、允许方法、过期时间；每次调用由服务端重新校验，不能只相信模型传入的 owner。取消/归档/删除撤销 token。

不允许把任意 shell 命令、服务端绝对路径、明文 token 写入知识配置。凭据在宿主受控存储中管理，执行时注入，设置只显示引用和状态。结果有字节预算、超时、脱敏和调用审计。

生成修改提案不依赖写 MCP；应用、发布、测试仍通过已有业务 API 和用户确认。项目 shell 权限与创作 MCP 权限是独立策略，不能因为同一 AgentRuntime 混用。

## 7. 工作区与 Provider 适配

### 7.1 生命周期

`allocated → materializing → ready → leased → ready → evicting → evicted`；异常物化为 failed，可重试；无法确认进程退出为 cleanup_blocked。

single 可在终态后直接回收。multi 被回收的是可再生成缓存，保留 workspaceId、固定绝对路径及知识版本；下一轮在同一路径恢复。

数据库为归属、版本、租约和状态的权威；manifest 只用于磁盘验证/诊断。不得根据目录里自报的 owner 授权或删除。

### 7.2 一对话一目录与并发

- 新会话使用全局 UUID。资源类型/ID 和本地旧 conversationId 存元数据，不拼到路径中。
- 每个对话只有一个稳定根目录；轮次可有 tmp/<turnId>，但不是新的逻辑工作区。
- 对话提交、关闭、归档、清理使用同一互斥/租约协议。取得删除标记后新任务须等待或重建缓存，不得启动旧路径上的进程。
- 同数据目录只允许一个服务写者（进程级锁）；数据库租约仍保存 instanceId、generation、expiresAt 和 heartbeat，以支持崩溃恢复。过期租约本身不足以证明子进程已死。
- 路径组件拒绝 symlink、越界及外部目录；不得跟随链接递归删除。

### 7.3 项目分析的特殊性

项目分析也是 single，工作区由统一服务分配，但项目准备模块继续负责 pin 分支/SHA、下载和清理。

建议将源码准备到 workspace/project，CLI cwd 为该 project 子目录；一个对话仍只有一个工作区根。知识由宿主明确注入，不覆盖仓库自己的 AGENTS.md，不向 Git 跟踪文件中写 Orchard 规则。仓库指令/代码视为任务数据，其原生加载行为需要在 Provider 验收中显式确认，不能获得平台权限。

project 的全部源码、CLI 临时文件和 sessionDirectory 均归本次 single 所有；退出进程后清理。Git 镜像/下载缓存由原项目服务按引用管理，不由工作区清理器删除。不得把临时 repo 的未提交改动当作正式业务产物。

### 7.4 Provider 契约调整

SessionOpenRequest 显式传入 workspaceRoot、cwd、managedSessionRoot、knowledgeHash、toolPolicyVersion、persistencePolicy；禁止适配器从 cwd 向上推导数据根目录。

- Codex single 使用 ephemeral thread；multi 使用 thread/start/resume。保存 threadId、cwd 与连接指纹。
- Pi single 使用 --no-session；multi 显式 --session-dir/--session-id，恢复使用校验后的绝对 sessionFile。
- readiness 检查需要的原生会话、工具策略及知识加载能力；不支持 multi 时禁用该选择，不退化为历史重放。
- releaseSession 只关闭运行资源；不得隐式删历史。原生 session 清理使用独立能力和显式授权。
- 业务请求以 conversationId/turnId 关联事件；后端 threadId/sessionId、绝对路径不直接暴露给浏览器。

## 8. 清理、配额与保留策略

### 8.1 分层策略

| 资源 | 默认建议 | 约束 |
|---|---|---|
| 空闲 CLI 进程 | 保持现有 10 分钟 TTL，压力时 LRU | 仅 idle，完成关闭后才能清理 cwd |
| single 工作区 | 本轮终态且进程退出后立即清理 | 清理失败进入重试队列 |
| multi 的 tmp/context 派生缓存 | 本轮结束清理不再需要的临时数据 | 不删除用户明确保存的正式产物 |
| multi 可再生成工作区 | 最后使用 7 天后可回收；归档后可立即回收 | 无运行/排队租约，先关闭闲置进程 |
| orphan/staging/trash | 启动检查 + 定时扫描 | 先验证无有效引用和活进程，不凭目录时间删除 |
| CLI 原生上下文 | 默认不自动过期删除 | 显式预览确认；删除后标记 needs_rebuild |
| 平台历史/提案/应用审计 | 默认保留 | 永久删除走独立确认及业务保留约束 |
| 知识版本 | 引用存在则保留；无引用版本保留 30 天 | active、安装基线和可恢复对话引用不得删 |

默认派生缓存预算建议 1 GiB，设置可调整；不包含数据库、正式产物和原生会话。先扫孤儿和 single 残留，再按 LRU 回收无租约 multi 缓存；无法释放足够空间时新任务返回 AGENT_STORAGE_FULL，不删除仍需保留的原生会话/历史。计费/输出限额继续沿用 Provider 限制。

以上 TTL/配额是本 feature 的建议默认值，审批时可调整；不能误写为当前已有行为。

### 8.2 清理算法与可靠性

1. 预览基于数据库状态和安全路径扫描，生成对象清单、估算字节、影响说明及短期 planToken。
2. 执行时重新验证引用/租约/generation，变化则跳过或要求重新预览。
3. 关闭对应闲置 CLI 并确认退出；原子标记 evicting。
4. 同一文件系统 rename 到 trash，标记 evicted，异步递归删除；失败留下可重试任务。
5. 崩溃后依据状态与 manifest 校对 staging/trash；不依赖文件 mtime 判断活动性。
6. 新任务与清理使用同一工作区锁；清理原生上下文还须先更新可恢复性状态并撤销使用权。

归档可恢复，不等于删除。原生上下文删除后 UI 明确显示“需从历史重建”；重建保留知识版本和来源链。删除历史可能影响重建来源，需列出依赖并确认，不能留下可重建的虚假承诺。

Codex 共享 home 不属于 Orchard 可递归删除范围。若 CLI 没有安全的按 thread 删除能力，仅移除本地引用并显示“外部 CLI 存储未回收”，禁止报告已释放这些磁盘字节。Pi 只删除归属校验通过的受管 session 文件。

## 9. 数据模型与数据库审核范围

本节是**逻辑模型建议，须单独提交 schema-review 和审批记录后才能实施**。版本号由合并时基线决定，不预占当前迁移版本。禁止顺手修改其他进行中的数据库 feature。

建议新增统一表而不是直接把现有 draft 专用表泛化，以保留可验证的迁移边界：

| 表/对象 | 主要字段与约束 |
|---|---|
| agent_runtime_conversations | id、scenario、ownerType/ownerId/ownerVersion、mode、lifecycle、backendHealth、bindingSnapshot、knowledgeHash、contractVersion、toolPolicyVersion、workspaceId、rebuildFromId、retryOf、timestamps；mode 只允许 single/multi |
| agent_runtime_turns | id、conversationId、sequence、requestId、requestHash、status、submissionState、baseRevision、inputPolicy、outcome/proposalRef、error、backendTurnId、generation、timestamps；UNIQUE(conversationId, sequence)，幂等键有 owner/操作作用域 |
| agent_runtime_messages | conversationId、turnId、sequence、role、受保留策略约束的内容/引用；稳定排序、可分页 |
| agent_runtime_backends | conversationId、Provider 类型、backendRef、cwd、fingerprint、generation、health；single 禁止持久 backendRef |
| agent_runtime_workspaces | id、conversationId UNIQUE、受管相对路径或受控 legacy 标记、state、lastUsedAt、leaseInstance/generation/expiresAt、估算 bytes |
| agent_knowledge_versions | hash、manifest、来源/bundleVersion、兼容版本、createdAt；文件内容在不可变目录 |
| agent_runtime_mappings | 旧场景/owner/localConversation/turn 标识到新标识映射；唯一性支持幂等迁移 |
| agent_cleanup_jobs | 对象、状态、尝试次数、错误、plan/generation；可恢复清理任务 |

single 唯一 turn、每对话唯一活跃 turn 必须有数据库级保障（条件唯一索引或经审核的等价约束），不能仅靠进程内 Map。跨表 mode 约束采用受审核的事务/触发器方案，并补直接写库的约束测试。

模型配置快照不包含认证值。历史禁存任务只记录允许的生命周期和摘要元数据，不把输入哈希默认视为无敏感性，需按现有敏感策略处理。

必须同时审核：旧表外键及索引、新旧消息引用、恢复流程、历史删除依赖、配置备份格式兼容、schema validators、migration manifest/frozen 生成、版本升级预览和失败恢复。

## 10. API 与事件

建议统一 API，旧业务路由保留薄适配直到迁移验收完成：

| API | 行为 |
|---|---|
| POST /api/agent/conversations | 创建，mode/scenario/owner/modelConfig/requestId 必填 |
| GET /api/agent/conversations?scenario=&ownerId= | 分页列表，显示 mode/知识版本/后端健康/清理状态 |
| GET /api/agent/conversations/:id | 对话详情及可执行动作，不暴露后端路径 |
| POST /api/agent/conversations/:id/turns | expectedRevision/requestId/prompt/场景输入；single 只一次 |
| GET /api/agent/conversations/:id/messages | 游标分页、全序 sequence |
| POST /api/agent/turns/:id/cancel | 幂等取消，不能将仅发送中断请求视为已停止 |
| POST /api/agent/conversations/:id/archive 或 restore | 生命周期管理，运行中拒绝并要求先取消 |
| POST /api/agent/conversations/:id/rebuild | 显式创建 multi，来源和预算检查 |
| POST /api/agent/conversations/:id/delete-preview 或 delete | 有影响清单/确认 token 的永久删除 |
| GET /api/settings/agent-knowledge | 当前版本、内置版本、文件清单、冲突与校验结果 |
| PUT /api/settings/agent-knowledge/files | 白名单相对路径、expectedRevision，写入草稿配置 |
| POST /api/settings/agent-knowledge/validate 或 publish 或 reset | 校验/发布/恢复默认；写操作幂等 |
| POST /api/settings/agent-storage/cleanup-preview 或 cleanup | 可再生成缓存与破坏性清理明确分组 |

应用提案继续由场景业务 API 负责，统一 turn outcome 与场景结果关联。Git 提交说明等同步 API 可以内部 create single + await，外部响应保持兼容；仍须请求幂等键防重复发费。

事件统一包含 conversationId、turnId、sequence、type、time、受控 payload。支持事件续传与断线补拉；客户端去重，不因 SSE 丢失重复提交。共用 queued/started/accepted/text_delta/usage/completed/failed/cancelled/interrupted/backend_state/workspace_state 事件。原始工具日志不默认广播，尤其项目和敏感输入场景。

主要错误码：CONVERSATION_MODE_CONFLICT、SINGLE_TURN_EXISTS、TURN_ACTIVE、REQUEST_CONFLICT、KNOWLEDGE_INVALID、KNOWLEDGE_INCOMPATIBLE、CONTEXT_LIMIT、SESSION_REBUILD_REQUIRED、AGENT_STORAGE_FULL、WORKSPACE_BUSY、CLEANUP_PLAN_STALE。可恢复性和推荐动作随错误返回，不只显示内部代码。

## 11. 设置与对话 UI

采用已有紧凑桌面工作区风格：侧栏分类 + 文件列表 + Markdown/JSON 编辑区 + 校验/差异面板。不增加营销式卡片和大标题。

设置新增“Agent 工作区”：

- 知识：公共 AGENTS.md、场景文档、Skills、版本与覆盖状态、发布/恢复默认、实际 profile 预览。
- 平台 MCP：允许能力、启用状态、Provider 兼容状态、凭据引用；不支持时禁用并解释。
- 存储：工作区/原生上下文/历史/知识版本分别计量；清理预览、预计影响与失败重试。

对话工具栏固定显示 single/multi、模型、知识版本、状态；多轮显示继续、归档、重建，单轮终态显示“再次发起（新单轮）”。模式不可原地切换。新知识发布时已有对话显示“有新版本，可新建/重建”，不自动热更新。

历史旧会话展示只读/需重建标签，说明连续性变化。临时错误保留输入；已经受理的请求重试查询原 turn，不再发送新任务。

覆盖浅色/深色/系统主题、键盘焦点、图标可访问名称、长路径/长输出和窄屏。需实际浏览器验证；未验证不得声明 UI 已验收。

## 12. 兼容迁移与发布

### 12.1 旧对话处理

- 工作流旧 multi：迁入统一记录并保留原 cwd、backendRef、旧知识来源信息。不得仅修改路径字符串。旧内联规则固化为 legacy 知识版本，防止旧会话被新规则静默替换。
- 若无法精确恢复旧规则或契约已不兼容，保留历史并标记 needs_rebuild，不伪造知识版本；不能把当前源码规则宣称为历史实际使用规则。
- 工作流旧 single 如果一个旧 conversation 有多个 turn：拆为多个 single，每个 turn 一个对话，保留 legacyGroupId 供 UI 分组，绝不导入为可继续 multi。
- 脚本/Web Bridge 旧重放式对话：导入为 archived、needs_rebuild 的 multi 历史记录，无可用 backendRef；第一次“继续”必须明确重建新 multi。不能把拼接历史机制继续藏在新 multi 路径里。
- 旧运行节点、Git 说明等不强行制造不存在的完整历史；已有执行记录保留原位置，必要时映射，只有新调用进入统一对话记录。
- JSON journal 导入完整提案、应用标记和错误，使用旧 ID 映射去重。旧文件在迁移验收与备份保留期内只读保留，不能先删再导入。

### 12.2 路径兼容

当前 Pi 从 cwd 向上推导 agent-sessions/pi，且 Store 校验旧前缀；统一实现改显式 managedSessionRoot，并支持受控 legacy 路径列表。

旧多轮原路径持续使用至归档/重建，不移动其 cwd。若迁移到另一数据根目录、Provider home 或设备导致原生引用失效，标记 needs_rebuild。不要假设本地原生会话可随备份跨设备恢复。

### 12.3 发布和回退

1. 提交数据库评审，审核通过后制作版本化迁移与 fixtures。
2. 迁移前停止 Agent 受理、等待/取消活动任务、关闭进程、备份数据库和相关 journals/session 索引。
3. 先验证源数据，再分阶段导入、对账，写迁移完成标记；重复执行不产生重复对话。
4. 新旧 API 兼容层只路由到一个权威写入端，不长期双写两套真相。
5. 验证通过后启用统一路径；旧路由只做 DTO/标识转换。
6. 失败按迁移框架恢复；升级后的数据库不允许旧二进制直接打开。应用回退需要对应备份恢复，不承诺无损 downgrade。

### 12.4 备份与配置 Git

本需求第一版不扩展现有配置 Git snapshot 格式：知识页面明确标注“本地配置，暂不参与配置 Git 同步”，不得显示已备份。完整数据备份须纳入 knowledge、被引用知识版本、数据库和受管 Pi session；排除 staging/trash/可再生成 workspace 缓存。恢复前关闭进程，恢复后校验引用、绝对路径和 Provider 身份，不兼容会话改 needs_rebuild。

后续知识 Git 同步需要独立 snapshot 格式与安全审核，尤其 MCP 命令/凭据引用，不以自动扫描 .agents 的方式偷渡到现有配置同步。

## 13. 实施拆分与交付门槛

| 阶段 | 交付 | 完成门槛 |
|---|---|---|
| P0 评审与协议验证 | 数据库审核、Codex/Pi 知识隔离和原生恢复实验、加载兼容矩阵 | 未通过不得开始表结构改造；原生规则隔离不可行时先修订设计 |
| P1 知识资产 | 迁移静态规则、manifest、打包、初始化、版本与设置预览 | tarball 安装启动可用；升级不覆盖用户修改 |
| P2 统一内核 | 对话/轮次模型、租约、WorkspaceService、Runtime、场景契约 | single/multi 不变量、故障注入、假协议测试通过 |
| P3 全场景接入 | 工作流/脚本/Bridge/普通节点/项目/Git说明/模型验证 | 不再存在业务直接调用 Provider 的旁路；项目与敏感策略不退化 |
| P4 生命周期与迁移 | 导入旧数据、清理预览、配额、存储 UI、旧路由适配 | 迁移对账、清理竞态、恢复和真实 CLI 多轮验收通过 |
| P5 可选受控 MCP | allowlist、token、适配配置、设置状态 | 两 Provider 权限一致，越权/取消/泄漏测试通过；未通过保持禁用 |

P1–P4 构成本 feature 的完整基础交付。P5 不阻塞知识文件化，但不得将仅有配置文件称作 MCP 已实现。

预期涉及 `src/agent/**`、`src/providers/**`、`src/authoring/**`、`src/web-bridge/agent.ts`、`src/runtime/runner.ts`、`src/server/app.ts`、`src/storage/**`、`src/web/agent-chat/**`、设置页、构建脚本以及经审核的 persistence/migrations。当前工作树中其他需求的改动不可覆盖。

## 14. 验收矩阵

### 14.1 对话和 Provider

- single 第二次提交被数据库/服务双重拒绝；UI 再次提交生成新 ID、新 cwd、新后端上下文。
- single 不包含其他对话历史；失败重试不复用上下文；幂等重放不额外调用模型。
- 三个创作场景 multi 都通过原生 session 连续两轮，第二轮不携带全量历史。
- 进程 TTL 回收和服务重启后恢复同一 cwd/backendRef；Codex/Pi 分别真实验证。
- 恢复失败不暗中退化成 single 或宿主历史重放；显式重建来源完整、不截断、不重复。
- 切模型、切 mode、升级知识有明确新建/重建边界；不原地改变绑定。
- 取消确认、接受后崩溃、发送状态未知、流事件断线和 late generation 均不重复发费/写入。

### 14.2 知识与打包

- npm pack 后全新目录安装，无源码环境也能初始化全部必需文件和隐藏 .agents。
- 首次启动、重复启动、并发启动、中断写入、损坏 manifest、缺少文件均有确定结果。
- 用户修改/删除与内置升级三方冲突正确，发布原子，旧会话知识 hash 不变。
- 工作区篡改不能修改公共知识；重新物化 hash 一致；知识版本仍被引用时不可删除。
- 两 CLI 的全局/祖先/项目规则加载行为有实测记录；未隔离项明确列出，不宣称完全受控。
- Schema 和安全策略继续由宿主执行；编辑 AGENTS.md 不能获得发布/密钥读取权限。

### 14.3 工作区与清理

- 同 owner 下多个对话、跨场景相同旧 local ID 均不冲突；同会话并发提交拒绝。
- 无租约/进程确认不得清理；恢复与清理竞态、trash rename 后崩溃可恢复。
- single 正常/异常结束、项目准备失败、磁盘满、清理权限不足有可观察结果与重试。
- multi 缓存回收后同路径重建并恢复；删除原生 session 明确 needs_rebuild。
- 不删除 Codex 共享 home、Git 镜像、正式产物、仍被引用知识或其他会话目录。
- symlink/路径穿越、伪造 manifest、过期 planToken、PID 复用均不能越界清理。
- 敏感节点不落盘输入/输出/prompt/原始日志，无可恢复 session 残留。

### 14.4 迁移、UI 和业务回归

- 旧工作流 single 拆分正确；旧 multi 保持路径；脚本/Bridge 明确重建后才继续。
- 对账消息顺序、完整提案、应用标记、资源归属、记录数量和重建来源；导入可重入。
- 项目 SHA pin、工具策略、已有脚本/Bridge 应用确认、字典敏感传播保持不变。
- 单轮/多轮 UI、归档恢复、清理确认、知识差异在浅/深/系统主题与窄屏实际验收。
- 运行类型检查、单测、API/交互测试、构建打包测试及真实 CLI 冒烟；记录实际版本和成本授权。

## 15. 风险与评审问题

1. **原生知识隔离能力**：当前启动参数不能证明全局/祖先规则不会加载。P0 必须读取对应 CLI 文档并实测；无法确定性控制时不得发布“严格受控知识”模式。
2. **历史迁移成本**：旧脚本/Bridge 为文件 journal，原工作流为 SQLite；需要清晰的权威切换和对账。
3. **上下文增长**：multi 原生历史增长不可由 512 KiB 当前请求预算完全约束；需处理 CLI 上下文上限与压缩通知，不自动丢历史。
4. **磁盘清理预期**：删除工作区不等于删除历史和 Codex 外部存储，UI 必须分别展示估算与实际回收。
5. **安全与维护便利的冲突**：Markdown 可维护不意味着可执行任意扩展；MCP 和项目工具保持独立权限。
6. **需用户/维护者评审确认**：single 严格一轮、multi 全部原生、旧脚本/Bridge 首次继续需显式重建、默认缓存 1 GiB/7 天、知识暂不进配置 Git、数据库逻辑模型。这些是本方案推荐决策，尚非已批准实现。

## 16. 关联设计

- [原 Agent 对话设计](../2026-11-04-agent-conversations/design.md)：本需求替换跨场景对话组织方式，保留原生协议实现经验。
- [Git 项目 Agent](../2026-11-10-git-project-agent/design.md)：复用项目准备、工具风险和清理约束。
- [配置 Git 存储](../2026-11-06-config-git-storage/design.md)：知识同步范围需明确隔离。
- [数据迁移](../2026-11-06-data-migration/design.md)：数据库审核、备份和升级流程沿用其框架。
- [当前公共 Agent UI 架构](../../wiki/architecture/agent-chat.md)：复用 UI 组件，不把现有 UI 复用误当作运行时已统一。
