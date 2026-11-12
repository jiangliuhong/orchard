# 统一 Agent 对话、内置知识与原生会话生命周期

> 2026-11-12 后续设计：[Agent 只读项目工作区与平台统一应用](../2026-11-12-agent-workspace-projection/design.md)。关于工作区内容、文件读取、平台写工具和提案应用流程的后续目标以新设计为准；原生会话及生命周期等约束按新设计的继承范围保留。旧数据库审批不自动覆盖新方案。

- 状态：P0 实施中（能力门禁、引用校验、锁/guard 核心、存储身份与独立删除适配器已编码；两个 CLI 基本删除实测通过；未接入生产，剩余 P0 待验证；具体 schema 已获批准，九表/Store/v11 DB 重置步骤已编码，生产迁移未激活；内置知识/打包/共享 workspace 初始化恢复已编码测试）
- 创建日期：2026-11-11
- 修订依据：本 feature 的 grilling review，Q1–Q24 及最终共同理解确认。
- 本文替换初版设计；不再采用初版的历史重建、可编辑知识、旧对话迁移、缓存配额和存储清理方案。
- 后续确认：维护对话共用只读 workspace，不按 conversation 复制知识；原生会话身份、存储与生命周期由可扩展 Provider 契约封装。
- 最新决策：直接删除对话和原生上下文，不做归档或恢复；替换此前归档方案。
- **数据库审核：用户已明确批准具体 schema-review.md；审批快照与证据见 schema-approval.json。仅授权编码与测试，实际旧数据重置仍须另行确认。**

## 1. 已确认决策

| 主题 | 最终决定 |
|---|---|
| single | 一个对话只允许一个逻辑轮次；再次发起创建新对话 |
| multi | 由 Codex/Pi 原生持久会话提供，不使用平台历史重放 |
| 维护页面 | 工作流、脚本、浏览器工具维护 Agent 全部固定 multi，不提供类型切换 |
| 其他入口 | 普通 Agent 节点、项目分析、Git 提交说明、模型验证使用 single |
| 上下文管理 | CLI 自行管理历史、压缩和裁剪；平台不重放、不摘要、不重建上下文 |
| 当前对象 | Agent 通过平台工具查询最新草稿和 revision；平台不每轮注入完整草稿 |
| 知识 | 全部平台内置，源码维护、随包发布、服务初始化；设置只读 |
| 知识更新 | 旧对话只读；使用新版须新建，不维护旧知识兼容或重建流程 |
| 平台工具 | 第一版必须开放受控的跨资源定义/源码/关联关系查询 |
| 运行数据 | 不开放跨资源运行数据；当前对象测试信息仅由用户明确选择后提供 |
| 修改 | 沿用各场景提案应用流程，必须携带查询所得 revision，宿主强制校验 |
| 结果反馈 | 允许反馈应用结果、冲突及资源变化，不视为接管上下文 |
| Provider/模型 | Provider 开始后固定；空闲时允许同 Provider 内切换模型，保留原生上下文 |
| 后端不可恢复 | 暂时失败可重试原生恢复；永久失效只能新建，旧对话可查看 |
| 平台删除 | 直接删除对话内容及对应原生上下文，不归档、不提供恢复 |
| 删除前提 | 用户明确确认且无活动/不确定任务；运行中先取消并确认停止 |
| 删除失败 | 保留引用和阶段，标记未完成/失败，允许幂等重试，不能宣称成功 |
| 存储 | 设置仅展示当前占用；不做定期清理、容量驱逐、手动清理 UI |
| 工作区 | 三个维护场景共享一个只读 workspace；新建会话不创建知识副本 |
| Provider 抽象 | Runtime 只持有不透明会话引用，不解析 CLI 标识、历史文件或协议 |
| 运行资源释放 | 保留闲置 CLI 回收、单轮终态临时资源释放，不属于历史清理；绝不释放共享 workspace |
| 升级 | 明确确认后重置旧 Agent 数据，不导入旧对话；保留业务资产和运行记录 |

## 2. 目标、范围与非目标

### 2.1 目标

所有 Agent 调用使用统一 AgentRuntime，严格区分 single/multi，统一请求幂等、事件、工作区、Provider 调度和生命周期。场景之间只保留业务权限、任务规则、输出契约和提案应用的区别。

将散落在 TypeScript 中的教学式规则迁入内置知识目录。知识提供规则与操作指引，平台工具提供最新业务事实，原生 CLI 管理对话上下文，宿主代码保障权限和数据一致性。

### 2.2 非目标

- 不提供第三种“宿主重构式多轮”，不提供任何历史重建按钮或 API。
- 不编辑、覆盖、Git 同步用户知识，不做知识三方升级合并。
- 不开放任意第三方 MCP、扩展、通用 shell 或平台写操作工具。
- 不因接入查询工具改变既有提案确认、应用和发布边界。
- 不导入旧对话，不要求新版本继续旧原生会话。
- 不提供批量磁盘清理、配额驱逐和自动历史过期策略；仅支持用户明确确认的单对话直接删除。
- 不把 cwd 当作安全沙箱，不把 Markdown 指令当作授权控制。

## 3. 代码现状与改造对象

以下为设计创建时源码检查结果，不代表本需求已实施。

| 场景 | 当前实现 | 目标 |
|---|---|---|
| 工作流维护 | single/multi，multi 已原生；多轮 cwd 为 agent-workspaces/<id> | 固定 multi，统一内核与工具查询 |
| 脚本维护 | 每轮新 CLI，平台重放历史，按 turn 建临时 cwd | 原生 multi，共用只读 workspace，Provider 隔离上下文 |
| 浏览器工具维护 | 每轮新 CLI，平台重放历史，按 turn 建临时 cwd | 同上 |
| 普通 Agent 节点 | 单次，cwd 使用数据根目录 | single 独立工作区，无平台查询权限 |
| 项目分析 | 单次、项目工作区、项目原生工具 | single，统一租约，保留项目风险策略 |
| Git 提交说明 | 单次，cwd 使用数据根目录 | single 独立工作区 |
| 模型验证 | Provider 内部单次任务 | single 系统任务，统一资源释放 |
| readiness/模型目录 | 无模型握手或目录命令 | 不属于对话，继续受进程调度 |

现有 SessionManager 默认最多 4 个 CLI 进程、32 个等待请求、等待超时 60 秒、空闲 TTL 10 分钟；本需求保留这些运行资源管理能力，不将其改成磁盘历史清理。

主要入口：`src/authoring/service.ts`、`src/authoring/script-agent.ts`、`src/web-bridge/agent.ts`、`src/runtime/runner.ts`、`src/server/app.ts`、`src/providers/registry.ts`。现有 `src/authoring/resources.ts` 的资源契约过滤逻辑可复用，但不继续每轮全量注入目录。

当前 Pi 使用 --no-mcp，Codex 使用 mcp_servers={}；当前代码存在 releaseSession，但不能据此推断已经支持原生删除或同会话模型切换。

## 4. 对话语义与不变量

### 4.1 single

- 一个 conversation 对应一个逻辑 turn；数据库约束与服务事务共同保障。
- 使用全新非持久后端上下文，不带其他对话历史。Codex 使用 ephemeral，Pi 使用 --no-session，具体行为通过集成测试确认。
- 同一 requestId 和内容重试只查询原任务；不同内容返回 REQUEST_CONFLICT。
- 用户再次发起或失败后重试，创建新 single 和全新后端上下文；需要独立执行目录的场景分配 operation 级 runtime 目录，可记录 retryOf 供诊断，不继承历史。
- 一旦存在 sending/accepted 不确定状态，不自动重复提交模型请求。
- 终态且确认 CLI 退出后释放本次临时目录；消息/元数据遵从原场景保留策略。
- 维护页面不使用 single；运行节点等固定 single，服务端不允许客户端升级权限为 multi。

### 4.2 multi

- 一个 conversation 固定 Provider、owner、knowledgeHash、契约和工具策略版本，并引用共享 workspace；模型允许按 §9 切换。workspace 与 conversation 不是一对一关系。
- 每个对话最多一个 queued/running/cancel_requested 轮次；并发提交返回 TURN_ACTIVE。
- 首轮由 Provider 创建独立原生会话，后续复用句柄或交回不透明引用，由 Provider 准确恢复。Runtime 不解析 threadId/sessionId 或会话文件。进程回收不是对话结束；共享 cwd 不允许共享、猜测或串用上下文。
- 后续提交以用户新消息为主；平台不附加完整历史、完整草稿和上一轮快照，不参与压缩或摘要。
- 原生 CLI 压缩、上下文窗口耗尽等按真实能力呈现，不承诺逐字保留无限历史。
- 暂时失败可重试连接原 session；永久失效标记 unavailable/read-only，只能新建。
- 不创建“重建 multi”，不从平台 messages 反向构造 CLI 历史。
- 当前知识或不兼容执行契约更新后，旧对话不能追加消息、调用工具或切换模型，但可以查看或直接删除，不能恢复已删对话。

### 4.3 资源归属

全局 conversationId 由服务端生成 UUID。对话记录显式关联 scenario、ownerType、ownerId；脚本同时关联草稿版本，工作流关联草稿，浏览器工具维护关联应用/选定对象范围。

当前编辑对象固定。跨资源查询不改变写入目标；跨资源修改应在对应维护页面另开对话。对象被删除、草稿被替换或权限撤销时禁止继续，不自动重新绑定到另一个对象。

## 5. 统一运行时

```text
页面 / Workflow Runner / 系统任务
  → ScenarioAdapter（owner、权限、任务入口、Schema、提案应用）
  → AgentRuntime
      ├─ Conversation / Turn / Operation
      ├─ KnowledgeService
      ├─ WorkspaceService / Lease
      ├─ PlatformQueryGateway
      ├─ HostFeedbackDispatcher
      └─ ProviderRegistry / SessionManager
  → 可注册 CLI Provider Adapter（当前为 Codex / Pi，后续可扩展）
```

建议新增 `src/agent/`。场景模块不再直接调用 providers.run/openSession；无需模型的 readiness 和模型目录刷新仍由 Provider 管理。

场景适配契约（示意）：

```ts
interface ScenarioAdapter {
  id: string;
  mode: "single" | "multi";
  knowledgeProfile: string;
  toolPolicy: string;
  authorizeOwner(owner: unknown): Promise<void>;
  buildTaskEntry(request: unknown): Promise<unknown>;
  validateProposal(output: unknown): Promise<unknown>;
  applyOrRecordProposal(proposal: unknown): Promise<unknown>;
}
```

平台 task entry 提供当前资源身份、用户需求、场景和查询方法，不塞完整草稿。single 运行节点的显式输入、项目信息仍是其任务数据，不受“维护 Agent 不注入完整草稿”的约束影响。

### 5.1 执行顺序

1. 校验 owner、mode、知识版本、Provider 状态、权限及 requestId。
2. 原子登记 conversation/turn，检查唯一活跃轮次，持久化请求接受状态。
3. 取得 conversation 操作锁和共享 workspace 读租约，验证当前知识已初始化，准备会话级工具授权；不创建或复制知识文件。独立执行场景另分配 operation runtime。
4. 获取全局进程槽位；通过 Provider 创建/恢复原生上下文；保存不透明 backendRef 和 generation，不解析其内部内容。
5. 按协议发送任务，持久化 sending/accepted；流事件归属到当前 generation/turn。
6. 响应查询工具调用；宿主检查最终提案 Schema、目标和 revision。
7. 沿用场景原有自动应用或确认流程，单独记录 generationStatus 与 applyStatus。
8. 可靠投递必要宿主事实；确认原生 turn 已停止；single 关闭并释放临时资源，multi 转空闲。

等待进程槽位时不持有长数据库事务。对话操作锁管理发送、切换模型、删除等互斥，不能只靠前端 disabled。

### 5.2 状态模型

- lifecycle：active / deleting；成功删除后仅保留最小幂等回执，不保留可恢复的 deleted 对话。操作失败保留 operation error 和阶段，不伪装成功。
- usability：usable / knowledge_outdated / backend_unavailable / owner_unavailable；与 lifecycle 独立。
- turn：queued / running / cancel_requested / succeeded / failed / cancelled / interrupted。
- submission：not_sent / sending / accepted / settled。
- process：absent / starting / busy / idle / closing。

服务重启后将未知轮次标记 interrupted，检查原生状态，不自动补发 sending/accepted 请求。不确定的会话禁止新提交，直到原生检查确认空闲或判定永久不可恢复。

## 6. 内置知识：源码、安装包与初始化

### 6.1 目录

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

构建复制为 `dist/agent/knowledge/`；当前 npm package 仅包含 dist，因此需显式测试 Markdown、manifest 和隐藏 .agents 都打入 tarball。资源按模块安装位置定位，不依赖用户启动 cwd 或源码目录。

manifest 声明 formatVersion、bundleVersion、按场景 profile、必需文件和字节哈希、兼容契约版本。`.agents/mcp.json` 是平台声明式工具配置，不假定 CLI 自动识别该路径；不含 token、用户 home、任意 shell 或外部可执行扩展配置。

### 6.2 数据目录

```text
<data>/agent/
├── workspace/                         # 唯一运行时知识副本，所有维护对话共用
│   ├── manifest.json
│   ├── AGENTS.md
│   ├── docs/
│   └── .agents/
├── sessions/<provider-storage-key>/   # 平台分配受管范围，内部布局由 Provider 管理
├── runtime/<operationId>/             # 按需创建的私有临时资源/项目执行目录
└── staging/                           # 知识初始化/升级的受管临时目录
```

`src/agent/knowledge/` 是源码知识源，安装后直接初始化到共享 `agent/workspace/`；数据目录不再另保留一份相同的 knowledge 副本。新建/恢复维护对话不创建子 workspace，也不复制 AGENTS.md、文档或 Skills。

只维护当前有效知识，不建用户 overrides 或 knowledge-versions 保留库。旧知识更新后只保留原生上下文中已有的历史，不为其维护旧知识工作区。sessions 的 Provider 存储键由注册表安全分配，不将任意客户端 Provider ID 直接作为路径；内部文件命名和布局不成为平台通用契约。

### 6.3 初始化和更新

数据目录可用、所需迁移完成后，AgentRuntime 受理前：

1. 取得数据目录初始化锁，校验安装包 manifest、路径、UTF-8、文件数/字节预算和哈希。
2. 首次使用 staging 写入并验证后原子发布共享 workspace；其中包含全部维护场景知识，由会话入口选择对应 Skill/profile，不通过改写公共文件选择场景。
3. 再次启动按 bundle/hash 校验；知识只允许平台内置，发现非平台修改应报告并从安装包重新物化，不将其视为用户覆盖。
4. 知识 hash 未变不影响已有会话；hash 改变时旧 multi 标记 knowledge_outdated、只读，关闭闲置进程、撤销查询能力。
5. 更新不在正在运行的轮次中热替换。部署/初始化先停止受理，确认旧任务结束或取消，收敛占用共享 workspace 的连接并取得升级写锁，再原子激活新知识。普通会话持读租约可并发；升级独占，不与读者同时修改文件。
6. 初始化失败使 Agent 能力不可用，设置显示诊断；不得用半写入目录启动 CLI。

知识文件只在源码评审维护。设置页可浏览 AGENTS、文档、Skills、平台工具配置和 hash，不提供保存、覆盖、发布、恢复默认按钮。

### 6.4 加载边界

知识 profile 包含公共规则、场景 Skill 和必要说明。Schema、授权、revision 校验仍由宿主代码强制实现。

优先由 Provider 使用其受支持的原生规则/Skill 加载机制读取工作区知识；明确验证文件发现范围、加载时机、是否会重复加载和全局/祖先规则影响。平台不自行读取整段历史、拼摘要或每轮注入整套规则。

“加载内置规则”和“接管对话历史”不是一回事；若某个 Provider 需要在创建/恢复时显式传入静态规则，由适配器使用已验证的原生指令接口完成，避免同时自动加载和手动注入同一内容。具体参数、路径和通道由协议验证决定，不能将 `.agents/` 布局本身当作生效证据。

宿主只记录当前已确认加载的 knowledgeHash 和策略版本，不声称能够抹除 CLI 历史里的旧规则。规则发现不能有效控制时列为兼容性阻塞项，不以默认信任全局扩展作为绕过方式。

## 7. 平台只读工具（第一版必需）

### 7.1 工具范围

三个维护 Agent 都能跨资源查询授权范围内已有资产，不能只提供名称和接口目录。

| 能力组 | 必须支持 |
|---|---|
| 工作流 | 搜索/列表；读取指定草稿或发布版本；节点、输入绑定、边；关联脚本文件和源码 |
| 脚本 | 搜索/列表；读取定义；指定草稿/发布版本的源码文件；输入输出 Schema、依赖声明 |
| 浏览器工具 | 搜索/列表；读取工具定义、参数、执行配置、返回字段及所需源码；过滤凭据 |
| 关系 | 查询工作流引用的脚本/工具，以及资源被哪些工作流引用；区分版本和草稿引用 |
| 当前对象 | 查询当前编辑快照与 revision，供生成修改提案 |
| 所选测试 | 读取用户明确选择的当前对象测试信息，不提供跨资源日志搜索 |

工具示例名可采用 `assets.search`、`workflows.get`、`scripts.get`、`assets.read_file`、`bridge_tools.get`、`assets.references`、`current.get`、`current.selected_test`；最终名称和 JSON Schema 需在实现前形成工具契约测试。

列表分页并可搜索；详情返回资源 ID、版本/revision、内容摘要和文件列表。源码按资源内受控路径读取，支持有界行范围和明确 nextCursor/truncated 信息。不得默默截断完整定义后仍称为完整；超限引导分文件/分页读取。工具不提供宿主任意路径读取。

### 7.2 权限与敏感信息

- 工具授权绑定当前调用主体、scenario、conversationId、owner、工具 allowlist 和有效期；每次查询重新检查资源可见性。
- 若当前平台尚无细粒度用户 ACL，应如实采用现有身份和访问边界，不虚构已经具备多租户隔离；未来 ACL 必须能接入同一 authorizer。
- 跨资源完整源码可读不等于可执行，不能调用工具定义对应的业务端点或运行脚本。
- 不提供密钥、凭据值、加密字典值、跨资源运行输入输出、原始调用日志。配置中的凭据仅提供安全引用和声明。
- 历史已有源码可能含硬编码敏感值，需沿用平台敏感字段策略和脱敏检测；不能保证任意源码字符串天然无密钥。检测到敏感内容应阻止或脱敏并明确说明，禁止“完整读取”成为泄漏豁免。
- 用户选择测试记录需校验属于当前对象和当前权限，受敏感/禁存策略约束；Agent 不能自行构造 testId 绕过选择。
- 工具结果包含的数据、注释、说明、源码均为不可信任务数据，不能提升平台权限。

### 7.3 受控工具传输

通过 PlatformQueryGateway 暴露 allowlist 工具，由 Codex/Pi Adapter 映射为其支持的 MCP 或原生工具接入方式。支持哪个传输必须有协议验证，不能保留 --no-mcp 后仍显示工具可用。

工具凭据不进入知识文件、公开 DTO、消息历史或诊断流。使用受控本地通道或短期凭据；删除、失效、取消后撤销相应执行授权，后续合法轮次重新签发。

禁用不相关用户 MCP、插件和通用工具；如果 CLI 只能以“全部工具一起开启”的方式接入，则不满足本需求。普通节点、Git 说明、模型验证没有该工具授权；项目分析只保留原项目工具策略。

## 8. 提案、revision 与宿主事实反馈

### 8.1 编辑基线

Agent 在生成修改前使用 current.get 查询当前维护对象，取得 resourceId、版本和 revision。提案必须携带基线信息。

宿主检查：

1. 提案目标属于本对话固定维护范围，不能夹带对其他资源的修改。
2. baseRevision 对应真实存在的当前对象，且与应用时 revision 一致。
3. 输出 Schema、完整文件/定义、引用依赖、运行契约及敏感约束合法。
4. 事务内再次比较 revision，避免查询后或预校验后发生并发修改。

冲突则拒绝应用，反馈“基线过期，请重新查询”，不自动合并模型输出。需要时记录服务端本轮查询所得 revision，防止仅凭模型猜测的数字绕过“先读取基线”的流程；校验机制不依赖 CLI 是否保留某条历史。

工作流、脚本、浏览器工具保持现有应用/确认方式，不因 Runtime 统一而自动改变。模型生成成功与修改应用成功分别记录。用户很晚才确认旧提案时同样执行 revision 校验。

### 8.2 事实反馈

只反馈完成任务所必需的宿主事实：

- 提案已应用，新的 revision；
- 提案被拒绝/应用失败，错误和冲突；
- 用户在页面更改资源，要求下次使用前重新查询；
- 用户明确选择或撤销测试上下文。

不主动附加完整新草稿、全量资源目录或历史摘要。

使用原生受支持的工具结果/宿主消息通道，不伪装用户发言或伪造模型未调用过的 tool result。若写操作由 UI 完成而非模型工具调用，必须有适配后的 host feedback 路径。

反馈使用持久 outbox、eventId 和归属 turn/operation；只投递一次已确认结果，未知交付状态先核对，不盲目重复触发模型。闲置时可排入下一轮发送前的原生上下文，不为通知自动启动新模型生成和计费。CLI 无法支持不触发额外生成的反馈时列为协议待解决项，不隐式产生额外轮次。

## 9. 模型切换

对话创建时选择 Provider/初始模型，开始后 Provider 固定；新建不同 Provider 对话不继承历史。

模型切换要求：

- 同 Provider 下已启用且可用的模型。
- 对话 usable 且 lifecycle=active，无 queued/running/cancel_requested 轮次或删除操作。
- 与提交任务使用同一对话锁，不能发生“提交一半换模型”。
- 保留相同原生 session/thread，不重新创建、不重放历史。
- 请求 pending 后由适配器确认模型变更，成功再更新当前模型；失败保持旧模型并显示错误。
- 若 CLI 仅支持下一轮选择模型，可在下一轮请求原子选择并核对实际模型，不把尚未验证的状态显示成后端已经切换；若协议无法可靠恢复失败前状态，列为不支持。
- 每轮记录 requestedModel、实际模型与 modelSource；会话列表显示当前模型，历史保留每轮模型，不以最新选择覆盖旧记录。
- 切换模型不改变工具权限，不绕过 Provider 禁用、模型停用或知识过期。

知识变更导致只读的旧会话不能通过切模型恢复使用。两个 Provider 必须分别验证模型切换和进程重启后的状态，不从 CLI UI 支持切模型推断 RPC 一定支持。

## 10. 直接删除对话与原生会话

### 10.1 产品语义与范围

用户确认后直接删除，不做归档、回收站、已归档列表或恢复 API。确认框明确：“永久删除此对话、消息、未应用提案和原生上下文，无法在应用内恢复；已应用业务资产与运行记录不受影响。”

删除由 Provider 抽象，Runtime 不解释 CLI 标识或文件布局。multi 必须删除对应原生会话，不能只删平台记录或调用 releaseSession。single 没有持久原生引用时 nativeDelete 为 not_applicable，只删除该对话所属数据及已确认停止的私有临时资源。

删除不级联删除工作流、脚本、浏览器工具定义、已应用版本、项目产物、运行记录、共享 workspace、模型凭据或其他对话。未应用提案删除后不能再确认应用；提案应用与删除须受同一业务一致性边界约束。业务记录所需溯源字段保留为不含对话正文的最小元数据，具体外键解耦须数据库审核。

“不恢复”指产品不提供恢复入口，不等于安全擦除：已有备份、SQLite 空闲页/WAL、外部日志及远端副本不保证立即物理清除；不承诺磁盘占用按对话大小即时下降。

### 10.2 删除状态机与幂等

1. 检查权限、固定 owner、expectedRevision 和 requestId；无 queued/running/cancel_requested 或原生状态不确定的任务。有任务返回 TURN_ACTIVE，用户先取消并确认 stopped；无法证明停止时禁止删除文件。
2. 持久登记幂等 delete operation，保存目标不透明引用、generation 和各阶段进度；原子置 deleting，禁止发送、切模型、应用旧提案及工具/反馈投递。
3. 撤销授权、取消未投递反馈，收敛并确认目标写入连接退出。Provider 调用原生删除或官方明确支持的存储删除方式，不发送模型任务。
4. Provider 确认目标已删除后，事务删除本对话消息、事件、未应用提案及无保留义务的关联数据；最后移除对话内容。事务失败继续保持 deleting，重试平台阶段，不重新创建原生会话。
5. 成功仅保留最小删除回执/operation tombstone：请求归属、请求 hash、阶段、时间、结果及必要幂等元数据；不保留正文/原生历史。不得在尚需核对和重试时丢弃唯一 backendRef；完成后按审核策略清除内部引用。
6. 失败/未知状态保留引用与进度，在待处理视图显示 delete_failed/待确认，可幂等重试；已被删除的原生上下文不可回滚，不能把对话恢复成可发送状态。

跨 SQLite 与原生存储不存在分布式原子事务，采用可恢复操作流程。原生已删但平台事务未完成、响应丢失、服务重启均须覆盖。只有在同一 Provider/存储身份下核对精确目标确实不存在，才可把“已不存在”当作删除完成；权限错误、Provider 未安装、存储未挂载、查询失败不能当作不存在。

### 10.3 Provider 实现与可行性

- **Codex 0.167.0**：本机生成协议有 `thread/delete { threadId }`，无需先 archive。官方源码另有派生子会话删除、附件引用冲突和缺失目标报错，需验证本机行为。Adapter 负责精确目标、原生删除范围及状态核对；不得删其他 Orchard 对话或业务资产。
- **Pi 1.5.1**：官方 session-format 明确支持删除原生 JSONL 会话文件。Adapter 在证明进程退出、归属和路径安全后删除确切文件及已核实的专属伴随资源；不调用交互删除中“trash 优先”的回收站路径，不扫描整个用户 home，不递归删除 Provider 根目录。
- Provider 提供 deleteSession 与 inspect；release 仅释放连接，nativeResume 仍用于未删除会话的进程重启恢复，不是恢复已删对话。
- 核心能力改为 nativeDelete、deleteStateQuery，不再要求 nativeArchive、nativeRestore、archiveStateQuery。无同名 RPC 不等于不支持，可由 Provider 封装官方等价存储操作；仍须有原生行为和故障测试证据。

### 10.4 评估结论与待验证项

方案可行，且显著简化 Pi 适配、生命周期、UI 和能力门禁；移除了归档/恢复接口及目录移动一致性问题。但不可恢复意味着删除误操作和跨存储部分成功风险更高，必须保留明确确认、停机证明、操作日志和失败重试。

直接删除决策不等于授权执行已有会话删除或数据库结构变更。独立 P0 适配器已编码，尚未接入生产；详细证据、测试清单及进展见[Provider 直接删除可行性评估](./delete-provider-plan.md)。宿主反馈、受控查询工具、共享只读 cwd 等其他 P0 门槛不因本决策自动通过。

## 11. 工作区与运行资源释放

### 11.1 共享只读工作区，独立原生上下文

三个维护场景统一使用 `<data>/agent/workspace/` 作为 cwd，平台初始化一次，知识升级时整体更新；点击新建或首次发送都不复制知识。独立 conversationId 表示逻辑会话，不对应专属知识目录。

公共 AGENTS.md 只放跨场景规则和索引，docs/Skills 包含各场景知识；场景选择、维护对象和会话身份经 Provider 的任务入口/原生指令接口传入，禁止通过覆盖共享文件实现。未来 CLI 只能加载全部索引时，也不得获得超出当前场景的工具权限。

共享 workspace 对 CLI 必须只读。只读权限位不是完整安全沙箱：适配器须限制文件写工具并验证 CLI 自身是否向 cwd 写锁、日志或元数据。必须写入的私有文件通过 Provider 受控参数定向到自身 session 存储或 operation runtime；无法避免 cwd 冲突写入的 Provider 不满足共享 workspace 能力门槛，不能偷偷退回每会话复制知识。

草稿、完整 prompt、查询结果、测试日志、工具 token 和会话认证不得写入共享目录。平台工具 endpoint 可以是公共静态声明，但会话授权须经独立连接、私有配置或受控环境传递，不能由 cwd 推断调用身份，不能逐会话覆写 .agents/mcp.json。

删除会话、模型切换、关闭或释放任何会话都不能修改/删除共享 workspace。上下文独立性由 Provider 契约保证，平台通过并发与恢复测试验证，而不是通过不同 cwd 假定隔离。

### 11.2 租约与崩溃

锁分三层：发送/切模型/删除使用每对话操作锁；共享知识使用可并发读租约和升级独占写锁；私有 runtime 资源使用每 operation 租约。不能对共享 workspace 使用一把会话独占执行锁，使所有对话被串行化。租约记录实例和 generation，不能仅凭 mtime/PID 判断是否活动。

单数据目录保持单写者锁。服务重启先确认旧受管进程是否退出；无法确认则保留目录并阻止冲突操作，不因租约过期直接删除。路径组件拒绝 symlink/越界，所有释放只处理明确归属于该 operation 的目录。

### 11.3 项目分析

仍是 single，项目服务 pin 分支/SHA，准备源码到 `<data>/agent/runtime/<operationId>/project`，CLI cwd 指向该目录，不与维护对话共用 cwd。普通 single 等有隔离需要的任务同样使用独立 operation runtime，不复制整套维护知识。

保留项目原生工具策略，不开放平台维护查询。平台知识通过已验证适配机制加载，不覆盖仓库自己的 AGENTS.md 或 Git 跟踪文件；项目规则发现和指令优先级纳入协议验收。

Git 镜像/下载缓存、正式项目产物仍由原项目服务管理，不纳入 Agent 历史删除。执行确认结束后释放本次项目临时工作区。

### 11.4 不做自动存储清理

保留：空闲 CLI 进程回收、single 终态关闭进程并释放此次临时资源、初始化失败回滚自己创建的 staging。

不做：按时间/LRU/磁盘配额自动删除原生会话或消息；不提供批量磁盘清理按钮和清理策略设置。用户明确确认的单对话直接删除不属于自动清理。共享 workspace 只由知识安装/升级服务管理，永不作为会话删除或释放目标。

single 临时资源释放失败记录 release_failed；可在后续受管恢复流程中重试这一已确定归属的释放操作，不扩大为扫描删除未知“孤儿目录”。无法证明归属和进程终止的残留仅报告，不自动删除。

磁盘不足时明确失败，不为完成新请求擅自驱逐历史。不承诺 Agent 总存储存在硬上限。

## 12. Provider 适配契约与协议验证门槛

### 12.1 可扩展 Provider 抽象

业务层只认识 conversationId、mode、模型和操作状态。Runtime 调用统一语义，不根据 Provider ID 编写 Codex/Pi 分支；CLI 命令、原生 ID、历史文件、cwd 绑定限制、删除存储规则均属于适配器内部实现。Codex/Pi 是当前注册实现，不是业务类型中的封闭枚举。

建议统一能力声明：nativeSession、nativeResume、sharedReadOnlyWorkspace、controlledKnowledge、platformReadTools、hostFeedback、sameSessionModelSwitch、nativeDelete、deleteStateQuery。能力由实现与安装版本共同决定，不仅由 Provider 名称决定。

概念接口如下，具体 TypeScript 类型在实施时沿现有 session 契约演进：

```ts
interface ProviderSessionReference {
  providerId: string;
  version: number;               // 该 Provider 引用格式版本
  opaque: unknown;              // 可 JSON 序列化，Runtime 不解释
}

interface AgentSessionProvider {
  createSession(request: SessionCreateRequest): Promise<SessionHandle>;
  resumeSession(reference: ProviderSessionReference, request: SessionResumeRequest): Promise<SessionHandle>;
  sendTurn(handle: SessionHandle, request: TurnRequest): Promise<TurnResult>;
  interrupt(handle: SessionHandle): Promise<void>;
  switchModel(handle: SessionHandle, request: ModelSwitchRequest): Promise<ModelSwitchResult>;
  deleteSession(reference: ProviderSessionReference, operation: OperationContext): Promise<DeleteResult>;
  inspect(reference: ProviderSessionReference): Promise<NativeSessionState>;
  submitHostFeedback(handle: SessionHandle, feedback: HostFeedback): Promise<FeedbackReceipt>;
  release(handle: SessionHandle): Promise<void>;
}
```

SessionHandle 是运行时句柄，不可作为可持久化引用直接落库。create/resume 结果提供需要保存的引用；原生恢复等若改变原生定位信息，返回更新后的引用，Runtime 通过 generation/revision CAS 原子替换，防止晚到结果覆盖新引用。

创建和恢复分开表达，避免“未找到指定 session 就创建最新/新 session”的隐式行为。适配器必须准确定位指定引用；禁止恢复当前目录最近会话、按 cwd 猜测、引用不存在时静默新建。无法恢复时返回标准错误，业务不解析 CLI 文案。

不要求 CLI 恰好有同名命令，Adapter 必须提供等价、可测试语义。release 只释放运行连接，不删除原生历史，绝不能删除平台传入的共享 workspace。deleteSession 以持久引用调用，即使执行进程已回收也能工作；inspect 必须区分存在、确切不存在与未知/不可访问。

Request 显式传入 cwd、workspace access policy、平台分配的 Provider 受管存储范围、可选私有 runtime 目录、知识 profile、工具授权、modelId 和 mode。这些是通用运行资源，不暴露具体 CLI 的 thread/session 参数。Provider 自己分配和定位内部历史文件，不从 cwd 向上推导数据根目录。

平台给每个 Provider 分配安全受管存储根；适配器负责内部会话独立性与路径校验。通用存储统计只遍历受管范围；外部原生存储由 Provider 提供可归属的统计/未知说明，不让 Runtime 扫用户 home 或解析会话文件。

不透明不等于不校验：Runtime 校验外层 providerId、版本、尺寸、可序列化性和所属对话；Provider 校验自己的 payload、路径归属、格式版本及兼容性。引用不可包含 token/凭据，不进入公开 DTO。Provider 未安装、引用版本不支持或原生上下文永久失效均返回明确不可用状态，不转换成其他 Provider 或历史重放。

新增 CLI 只需注册适配器、能力声明和其引用校验/恢复逻辑，不修改业务场景和统一表来增加固定 CLI 字段。共享目录隔离、原生恢复、权限、模型切换和删除契约测试为新 Provider 接入门槛。

### 12.2 P0 必须产出的能力矩阵

| 能力 | Codex | Pi | 通过证据 |
|---|---|---|---|
| 内置规则/Skills 加载及全局规则边界 | 待验证 | 待验证 | 文档、启动参数、实际加载行为 |
| 共享只读 cwd、独立会话与工具身份 | 待验证 | 待验证 | 并发不同对话/场景无串扰，CLI 不写共享目录 |
| 不透明引用及未知版本处理 | 待验证 | 待验证 | 准确恢复、拒绝猜测最新会话、不可恢复分类 |
| 仅开放平台只读工具 | 待验证 | 待验证 | 工具列表/调用，禁止无关工具的负例 |
| 原生多轮与重启恢复 | 需回归 | 需回归 | 同 session 两轮及进程回收后继续 |
| 不额外触发模型的宿主反馈 | 待验证 | 待验证 | 消息可见性、去重、实际模型调用次数 |
| 同 session 模型切换及失败保持 | 待验证 | 待验证 | session 身份不变、实际模型、失败/重启 |
| 原生删除/不存在状态核对 | 待验证 | 待验证 | 精确目标、实际消失、幂等、故障重试及范围隔离 |
| 原生上下文压缩可观察性 | 待验证 | 待验证 | 能观测则展示，不能观测则明确限制 |

实施协议适配前阅读安装 CLI 的相关文档/Schema/SDK 示例并记录版本；需要真实付费模型调用时按项目测试授权执行。没有实测之前，不将上述待验证项目写成“已支持”。无法满足核心能力时先报告阻塞并修订技术方案，不能静默降级为历史重放、换 session 或平台假删除。

## 13. 数据模型与审核边界

以下是逻辑模型；具体九表/索引/触发器与重置范围已由 schema-review.md 获批并编码。v10→v11 DB 步骤已在测试验证，生产注册/全局版本切换须与新 Runtime 接入一同完成；不能因产品或 schema 获批而直接重置用户数据库。

| 对象 | 关键字段与约束 |
|---|---|
| conversations | id、scenario、owner、mode、Provider 绑定、currentModel、knowledgeHash、contract/toolPolicyVersion、workspaceRef（允许多对一）、lifecycle、usability、timestamps |
| turns | conversationId、sequence、requestId/hash、status、submissionState、requested/actualModel、proposal/outcomeRef、baseRevision、generation、timestamps |
| messages/events | conversationId、turnId、sequence、role/type、受保留策略限制的内容；稳定游标和去重 |
| backends | conversationId、providerId、refVersion、opaque backendRef、fingerprint、generation、health、native delete 状态；single 不保存持久引用；无通用 threadId/sessionFile 字段 |
| shared_workspace | 稳定 ID、受管路径、knowledgeHash、安装状态、读租约/升级写锁状态；不与 conversation 一对一绑定 |
| runtime_resources | operationId、受管私有路径、用途、lease instance/generation、释放状态；仅按需分配，不保存知识副本 |
| operations | delete/switchModel 等幂等操作、阶段、预期 revision/generation、错误、确认结果及最小删除回执；删除重试所需引用在完成前保留 |
| host_feedback | eventId、conversationId、关联业务操作、payload、pending/delivered/unknown；可靠投递 |
| knowledge_installation | 当前 bundle/hash、初始化状态、manifest；不是可编辑版本库 |

约束：single 唯一逻辑 turn；每对话唯一活动 turn；所有操作互斥且幂等；不可由客户端覆盖 owner、cwd、工具策略或删除结果。数据库级唯一性/条件索引/必要触发器需审核并有直接写库约束测试。

无旧对话映射表、重建来源链、知识 overrides、自动清理任务/配额表。历史 retained 数据不代表允许用作模型历史重放。

审核包含旧表外键与业务记录关联：删除旧 Agent 记录不能级联删除工作流、脚本、工具定义、已应用版本或运行记录。若旧业务记录依赖旧 turn 外键，需审核其解耦/必要非对话溯源字段保留，不能凭表名直接清空。

模型凭据不进 bindingSnapshot。敏感输入策略继续优先，禁存场景不写 prompt、结果、原始日志或可恢复上下文；必要元数据也要按既有政策过滤。

## 14. API、事件和 UI

### 14.1 统一 API（建议）

| API | 行为 |
|---|---|
| POST /api/agent/conversations | 显式 scenario/owner/mode/Provider/模型/requestId；场景验证固定 mode |
| GET /api/agent/conversations | 按 owner、active/deleting、usability 分页；已删除内容不可查询 |
| GET /api/agent/conversations/:id | 状态和允许动作，不返回内部路径/token |
| POST /api/agent/conversations/:id/turns | 幂等提交，single 一次，multi 原生继续 |
| GET /api/agent/conversations/:id/messages | 历史分页，只读展示，不作为重建输入 |
| POST /api/agent/turns/:id/cancel | 等待确认停止，不把中断请求已发出当作取消完成 |
| POST /api/agent/conversations/:id/model | 空闲切换，同 Provider，expectedRevision/requestId |
| DELETE /api/agent/conversations/:id | expectedRevision、幂等 requestId；直接删除，未完成返回 operationId/阶段 |
| GET /api/agent/operations/:id | 查询已授权操作的进度、失败或最小删除回执，不返回已删正文 |
| GET /api/settings/agent-knowledge | 只读内容、manifest/hash、profile、能力状态 |
| GET /api/settings/agent-storage | 分类占用、范围、扫描时间、错误/未知项 |

没有 archive、restore、rebuild、knowledge PUT/publish/reset 或 storage cleanup API。DELETE 是永久删除，不另提供第二种删除入口。提案应用仍由场景 API 处理，统一反馈到对应 conversation。

旧 API 可短期作 DTO 适配，但不能继续提供旧 single 维护入口或历史重放旁路。Git 提交说明等同步调用内部创建 single，可保留外部响应形状，并增加/复用幂等请求机制。

事件统一带 conversationId、turnId/operationId、sequence、generation、type、time；支持断线续传和客户端去重。原始工具内容与诊断不默认广播；UI 可显示工具名、资源标识、成功失败，不显示凭据和不必要的源码副本。

### 14.2 对话页面

- 三个维护页面显示“多轮”，无 single/multi 切换；新对话选择 Provider 和模型。
- 已开始对话 Provider 只读，模型可在空闲且 usable 时切换。
- 知识过期/永久失效对话显示只读原因与“新建对话”，没有“重建”。
- 删除确认明确为永久删除、无法在应用内恢复，并说明业务资产保留；运行中禁用并引导先取消。
- 删除中/失败对象在待处理视图可见，可查看进度和重试；没有已归档列表或恢复按钮。
- 应用冲突显示“基线已变化，需要重新查询”；不自动覆盖或隐式重试模型。

### 14.3 设置页面

“Agent 工作区”使用紧凑的侧栏、列表和只读编辑器展示：

1. 内置规则、场景文档、Skills、工具配置及当前知识 hash。
2. Provider 能力矩阵、协议版本、不可用原因。
3. 当前磁盘占用：共享 workspace（即内置知识，只计一次）、Provider 受管 session 存储、历史数据库/journals、私有执行目录与临时残留分别计量。原生存储可归属性由 Provider 报告，不靠 Runtime 猜测文件格式。

展示扫描时间、统计范围、估算/实际值、权限失败和未知项。Codex 外部共享 home 无法可靠归属时标为外部/未知，不把整个用户目录计为 Orchard 对话占用；不声称扫描结果包括不可见存储。删除失败残留仍计入占用；删除不承诺数据库文件或备份占用即时下降。

只提供查看/刷新，不提供清理和知识编辑操作。遵循现有约 13px 紧凑尺度、浅/深/系统主题、键盘焦点与可访问名称；实际浏览器验收覆盖长文件、长路径和窄屏。

## 15. 升级：重置旧 Agent 数据，不迁移对话

### 15.1 明确破坏性确认

升级预览明确列出：旧 Agent 对话、消息、未应用提案、Orchard 管理的旧工作区和原生会话资源将重置；升级后的新对话从零开始。用户确认本设计不代替真正升级时的确认。

保留：工作流、脚本、浏览器工具定义，已应用修改、版本、发布状态、模型配置、业务运行记录和既有安全配置。

Codex/Pi 用户共享 home 不整体删除。不能安全按归属清理的外部存储只解除平台引用并明确说明未回收；不把外部历史重置失败伪装成已释放空间。

### 15.2 执行步骤

1. 完成数据库具体审核，制作版本化迁移和重置清单；版本号按合并时基线确定，不占用其他进行中的迁移版本。
2. 阻止新 Agent 请求，等待或取消活动任务并确认进程停止；存在无法确认的进程时阻止重置。
3. 按现有迁移框架备份数据库、相关 journals 和受管资源清单；备份不等于保留旧对话在新产品中继续使用。
4. 验证外键/业务依赖，按审核顺序重置旧记录，建立新统一模型；文件删除仅限确认的受管清单。
5. 初始化内置知识，验证新服务可用，显示重置结果和未处理外部资源。
6. 失败按迁移事务/备份恢复流程处理；不允许新旧运行时同时写入两套真相。

升级后的数据库不允许旧二进制直接打开；回退需对应备份。业务备份恢复或跨设备移动后，无法恢复的原生 session 只读，不从平台历史重建。

### 15.3 备份与配置 Git

内置知识由安装包提供，不作为用户配置纳入现有配置 Git snapshot，也不新增 snapshot 格式。备份恢复时以当前安装包验证知识；恢复记录 hash 不匹配时旧对话只读。

完整数据备份需明确覆盖平台消息和受管 Pi session 等持久资源；不承诺 Codex 外部共享存储一定包含在内。运行中备份遵循已有一致性流程，不能只复制活跃 SQLite 文件或变动中的 session 即宣称可恢复。

## 16. 实施顺序与交付门槛

| 阶段 | 内容 | 门槛 |
|---|---|---|
| P0 协议验证 | 规则加载、平台查询工具、宿主反馈、模型切换、原生删除 | 提交 Codex/Pi 版本与能力矩阵；核心能力缺失先解决，不假实现 |
| P1 数据库审核 | 统一模型、旧 Agent 重置、外键安全、备份与失败恢复 | 获得具体 schema review 批准后才能修改结构/迁移 |
| P2 知识和工具 | 源码资源、打包初始化、只读设置、跨资源查询与授权 | 安装包独立运行、越权/敏感负例、查询契约测试通过 |
| P3 统一内核 | single/multi、共享 workspace、Provider 不透明引用、反馈、模型切换、原生删除 | 幂等、共享 cwd 并发隔离、故障注入和假协议测试通过 |
| P4 全场景接入 | 三维护页面固定 multi，其余 single，旧入口移除 | 无业务 Provider 旁路、无历史重放/重建功能 |
| P5 验收 | 升级重置、存储只读、真实 CLI、多主题 UI | 全场景回归、实际模型与删除实测、发布验证完成 |

平台查询工具不是可选后续阶段；原生删除也不是只关闭进程或隐藏列表的 UI 功能。P0 没有通过，不能宣告整个统一 multi 方案可交付。

改动预计涉及 `src/agent/**`、`src/providers/**`、三个 authoring 服务、runner、server、storage、公共 agent-chat 和设置页、构建脚本以及经审核的 persistence/migrations。不得覆盖当前工作树中其他需求的改动。

## 17. 验收矩阵

### 17.1 对话与上下文

- 三维护场景全部原生 multi，第二轮不包含宿主重放历史或完整草稿快照。
- 使用第三种测试 Provider 验证业务/Runtime 无 Codex/Pi 固定分支；其引用格式无需修改统一数据库结构。未知 Provider/引用版本明确报错，不解析或迁移其 opaque 内容。
- 同 cwd 下准确恢复目标会话，缺失引用不恢复“最近会话”；删除单个会话后其他会话历史和工具授权不变。
- 单轮第二个逻辑 turn 被服务及数据库拒绝；再次发起新 ID/原生上下文，按需分配独立 operation runtime。
- 空闲进程回收和服务重启后恢复同一原生 session；永久失败只有新建，没有历史重建路径。
- CLI 管理压缩/裁剪；平台不存在摘要压缩任务；当前知识更新后所有旧 multi 只读。
- 取消、发送接受状态未知、断线重连、晚到事件不重复调用模型或应用提案。

### 17.2 知识、工具和写保护

- npm pack 后完整包含隐藏目录及文档，新安装无源码也能初始化。
- 初始化原子、可重复；损坏包、路径穿越、并发初始化和知识被篡改有确定错误/恢复行为。
- 设置无知识编辑入口/API；知识全部可追溯至安装包。
- 三维护 Agent 都能查询已有工作流、脚本、浏览器工具的完整定义/源码及引用关系。
- 分页/分文件读取明确，截断不伪装完整；权限、owner、版本正确。
- 不能通过平台工具执行源码、调用浏览器业务工具、读任意路径、读跨资源运行数据或泄漏凭据。
- 用户未选中的测试记录不可读取；明确选择也不能绕过敏感禁存策略。
- 提案目标与 revision 强制校验，页面并发修改后旧提案不能覆盖；查询依赖变化触发应用校验。
- 宿主事实正确投递、去重、不卡死；不自动启动额外收费模型轮次。

### 17.3 模型切换与直接删除

- 同 Provider 空闲切换模型保留 session/thread；每轮实际模型可核对，失败保持旧状态。
- 运行/排队/删除中/只读状态拒绝切换；不能改 Provider。
- 删除成功后平台消息、未应用提案和原生上下文不可再查看/继续，无归档及恢复入口；已应用业务资产与运行记录保留。
- 删除前任务必须停止；删除失败/响应丢失/服务崩溃有精确状态核对与幂等重试，Provider 不可访问不能视为已不存在。
- 覆盖原生已删而平台事务未完成的重试，不遗失唯一引用、不重新创建上下文；并发应用旧提案被阻止。
- releaseSession 与 deleteSession 调用在测试中区分，不能用关闭连接伪造删除成功；备份/WAL 不宣称安全擦除。

### 17.4 工作区、存储与升级

- 多个维护对话共用相同 cwd；创建 N 个会话不增加 N 份 AGENTS/Skills；共享读租约允许多对话并发，升级等待读者退出。
- 同 Provider、跨 Provider、跨场景并发不串历史/工具身份；准确恢复、删除或切模型不影响其他对话。
- 对话操作锁阻止同会话并发删除、切模型和执行；single 私有资源正常释放，永不删除共享 workspace；multi 历史不按时间/容量自动删除。
- 不扫描删除未知孤儿；PID 复用、symlink、伪造 manifest 不造成越界操作。
- 存储展示当前范围和时间，外部不可归属部分明确未知，无清理按钮/API。
- 升级前确认与备份齐全；重置旧 Agent 记录不影响已应用业务资产和运行记录。
- 项目准备/SHA pin/原生工具策略和敏感节点禁存行为保持不变。
- 类型检查、单测、API/交互测试、构建打包、真实 CLI 多轮/模型切换/原生删除验收及实际页面主题/窄屏检查都有记录；未执行项目明确标注未验证。

## 18. 当前状态和关联文档

产品行为已确认；独立 P0 模块与原生删除基本实测进展见[完整实施清单](./implementation-status.md)。内置知识资源、manifest、打包及共享 workspace 安装恢复已实现，详见[知识实施记录](./knowledge-implementation.md)，不代表 Provider 已实际加载知识或查询工具已开放。具体九表/索引/触发器与重置方案已获[schema review](./schema-review.md) 批准，SQL、AgentStore 与 DB 重置步骤已编码并通过相关测试。未接入统一生产运行时，剩余协议和全场景验收尚未完成，不能宣告整个 feature 已交付。

- [原 Agent 对话设计](../2026-11-04-agent-conversations/design.md)：复用协议经验；本需求替换跨场景模式与生命周期。
- [Git 项目 Agent](../2026-11-10-git-project-agent/design.md)：保留项目工具和临时资源约束。
- [配置 Git 存储](../2026-11-06-config-git-storage/design.md)：本需求不新增知识同步类别。
- [数据迁移](../2026-11-06-data-migration/design.md)：沿用审核、备份与升级框架。
- [公共 Agent UI 架构](../../wiki/architecture/agent-chat.md)：复用现有组件，不混淆 UI 复用与运行时统一。
