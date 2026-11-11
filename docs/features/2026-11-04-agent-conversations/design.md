# Agent 单次与多轮对话设计

状态：已完成编码。单次／多轮、历史管理、实时连接状态和批量事件持久化已实现；后续 native-only 需求已移除 legacy。实施与验证边界见 [implementation-status.md](./implementation-status.md)，历史阶段规格不代表当前待实施。

日期：2026-11-04

## 1. 目标与范围

Orchard 统一支持单次调用和原生多轮对话。业务层管理会话、轮次、消息和事件，Provider 适配器处理不同后端的协议：

- Codex 使用 `codex app-server`。
- Pi 使用 `pi --mode rpc`。
- 保留现有一次性 CLI 调用作为显式兼容路径。

第一阶段服务于现有流程创作、工作流 Agent 节点和模型验证，不新增独立聊天产品页面。流程创作支持多轮会话；节点与模型验证继续使用独立单次调用。

本设计不开放 Agent 工具权限，不引入 ACP，不允许跨工作流运行隐式共享上下文。运行中追加指令、分支会话和跨 Provider 原生会话迁移留待后续设计。

本文只提出数据库变更方案。根据根目录 `AGENTS.md`，表结构变更必须审核通过后才可编写和执行迁移；本 feature 不修改 schema 或现有数据库。

## 2. 当前实现

`src/providers/registry.ts` 中的 `AgentProvider` 以 `turn()` 为调用单位：

- Codex 每次执行 `codex exec --json --ephemeral`，从结果文件读取最终消息。
- Pi 每次执行 `pi -p --mode json --no-session`，从事件中读取最终消息。
- `src/runtime/process.ts` 管理一次性子进程的超时、取消、输出限制和清理。
- `src/authoring/service.ts` 将草稿快照及完整历史重新拼入每轮 prompt。
- `ProviderCapabilities` 已包含 `nativeResume`、`textStream`，当前两个适配器均未声明原生恢复。
- `authoring_turns.native_session_id` 已预留，但没有完整的会话实体或生命周期。

现有实现适合独立节点调用。多轮创作需要补充原生上下文、进程复用、会话恢复及事件归属，而不是仅增加一个 CLI 参数。

## 3. 核心模型

| 概念 | 含义 | 生命周期 |
| --- | --- | --- |
| Conversation | Orchard 管理的逻辑对话，拥有模式、来源和消息 | 可跨服务重启 |
| Backend session | Provider 原生上下文，如 Codex thread 或 Pi session | 可持久化及恢复，具体取决于后端能力 |
| Turn | 用户一次提交及其对应的 Agent 执行 | 从受理到明确终态 |
| Connection | Orchard 与一个后端子进程的协议连接 | 启动、就绪、退出 |
| Attempt | 一次实际提交到后端的执行尝试 | 不因网络重连而自动重复 |

逻辑对话与后端会话分开：重建上下文会生成新的后端会话，但可以保留同一个逻辑对话及其历史。后端引用使用带 Provider 类型的不透明数据，不把 Pi 文件路径当作 Codex thread ID 使用。

单次与多轮是上下文生命周期的区别，不是消息输出格式的区别。两者都能接收流式事件，也都必须在成功前完成最终结果校验。

## 4. 场景行为

| 场景 | 模式 | 上下文与释放规则 |
| --- | --- | --- |
| 流程创作 | 多轮 | 一个草稿可有多个历史对话，但最多一个当前对话；持续追加消息 |
| 工作流 Agent 节点 | 单次 | 每个节点 attempt 使用全新上下文，结束后释放 |
| 模型验证 | 单次 | 独立上下文，不带草稿、历史消息或节点数据 |
| 用户重置对话 | 新的多轮对话 | 保留当前草稿和旧历史，创建新上下文 |
| 切换 Provider、模型或连接配置修订 | 新的后端会话 | 从当前草稿及必要摘要初始化，明确标记上下文重建 |

单次上下文不得复用已有 thread 或已有 Pi 对话；允许复用底层进程时，必须证明后端上下文已隔离。第一版优先保证隔离，单次调用也可继续走兼容适配器。

发布工作流只固化模型选择与流程定义，不携带创作会话引用。不同运行、不同 attempt 之间不复用原生上下文。

## 5. 分层与接口

```text
创作服务 / 工作流运行器 / 模型验证
                 |
         ConversationService
     消息、互斥、幂等、状态、结果校验
                 |
          ProviderRegistry
          /              \
 CodexAppServerProvider   PiRpcProvider
          \              /
        后端进程与连接管理
```

保留 `AgentProvider.turn()` 作为单次调用入口。增加可选的会话接口，业务层不得根据固定 Provider ID 判断会话能力：

```ts
interface SessionProvider {
  createSession(options: SessionOptions): Promise<SessionRef>;
  resumeSession(session: SessionRef, signal: AbortSignal): Promise<void>;
  sendTurn(session: SessionRef, request: TurnRequest): Promise<ProviderResult>;
  interruptTurn(session: SessionRef, turnId: string): Promise<void>;
  releaseSession(session: SessionRef): Promise<void>;
}
```

以上为概念接口；实现必须使用第 18 节的完整契约，避免两套接口同时存在。`releaseSession` 释放连接或内存资源，不代表删除持久化历史；删除后端会话必须另设明确操作。

能力声明增加 `sessions: "none" | "memory" | "persistent"`，保留 `nativeResume` 和 `textStream`。能力按已验证的 CLI 版本和传输模式计算，不能仅凭可执行文件存在声明可恢复。结构化输出仍由宿主最终校验；后端原生约束只作为额外能力。

现有不支持会话的第三方 Provider 继续工作；需要持久多轮时，可显式使用历史重建模式，界面区分“原生恢复”和“历史重建”。

## 6. Codex 适配

Orchard 启动本机 `codex app-server` 并管理其生命周期，通过 stdio 进行双向协议通信。初始化、thread 和 turn 的具体消息以安装版本的官方 Schema 为准。

适配流程：

1. 启动并完成 `initialize` / `initialized` 握手。
2. 新对话使用 `thread/start`，恢复使用 `thread/resume`。
3. 先注册事件处理，再调用 `turn/start`。
4. 将增量消息、诊断和 usage 转换为 Orchard 事件。
5. 收到后端轮次终态后收集最终回复，并执行宿主结果校验。
6. 中断使用 `turn/interrupt`，等待终态或在宽限期后回收进程。

底层为 Codex App Server 协议，不视为 ACP 或 MCP。请求接受和任务完成分开处理；具体错误、终态、审批请求需要通过版本契约测试确认。

第一版每个活跃多轮会话独占一个子进程，降低事件路由与强制取消影响其他会话的复杂度。后续有实际资源压力时，再评估在一个进程内复用多个 thread。

保留本机 `CODEX_HOME`、认证、模型路由与自定义网关。现有 `exec` 的工具关闭参数不能直接假设适用于 App Server；实施时验证等效配置，无法确保限制时拒绝启动该模式，不静默扩大权限。

## 7. Pi 适配

Orchard 启动本机 `pi --mode rpc`，使用 Pi 自定义 JSONL 命令、响应和事件协议。它与 Codex 共享业务抽象，不共享协议解析器。

映射关系：

| Orchard 操作 | Pi 行为 |
| --- | --- |
| 创建会话 | 启动干净会话，必要时使用 `new_session` |
| 恢复会话 | 使用已保存会话文件启动，或经验证的 `switch_session` |
| 发送一轮 | 发送带唯一 `id` 的 `prompt` |
| 接收文本 | 处理 `message_update` 中的文本增量 |
| 取消 | 清理待处理队列并 `abort`，等待空闲 |
| 获取会话引用 | 从 `get_state` 等接口读取原生 ID 和文件信息 |

`prompt` 成功只表示接受、排队或处理，不表示生成完成。根据 disposition 判断是否启动运行；执行中的最终空闲边界使用 `agent_settled`，不能只根据一次 `agent_end` 结束 Orchard 轮次。

多轮持久会话启用受控的 session 存储目录；`--no-session` 仅用于不需要重启恢复的临时上下文。同一 Pi 进程第一版只承载一个活跃逻辑会话，避免切换会话时误归属事件。

继续关闭 tools、extensions 和 MCP。第一版自行实现薄协议适配器，与 Codex 共用 JSONL 传输基础设施，不引入 Pi SDK 依赖；安装版本的 `RpcClient` 仅作协议行为参考。

## 8. 进程、传输与资源管理

新增常驻连接组件，不把现有“运行到退出才返回”的 `executeProcess()` 直接用作会话连接：

- 使用绝对可执行路径与 `shell: false`，继承受控环境。
- stdout 严格按 LF 分割，允许 CRLF，不将 Unicode U+2028/U+2029 当作分隔符。
- 持续读取 stdout；stderr 作为诊断流处理，不参与协议解析。
- 请求 ID 唯一，响应按 ID 关联；事件另外关联会话和当前轮次。
- stdin 写入处理背压，维护有界队列；限制未完成请求数量。
- 请求确认超时、整轮执行超时和初始化超时分别设置。
- 限制单条协议记录、每轮累计结果和诊断缓冲，不按常驻进程终身累计 8 MiB。
- 第一版最终回复和每轮诊断各限制 8 MiB，单条协议记录也限制 8 MiB；超限明确失败并清理连接。
- 完整性损坏的协议记录视为连接错误；未知但格式有效的通知可记录后忽略。
- 空闲进程默认 10 分钟回收；设置全局活跃进程上限，超过上限进入有界队列。
- 回收只发生于空闲；关闭服务先停止接收任务，再中断活动轮次并清理进程组。

进程退出不能自动标记对话永久结束。持久会话可在下一次使用时重新启动进程并恢复；临时会话不能宣称可恢复。

## 9. 上下文同步与结构化结果

首次创作输入包含当前草稿、规则、模型目录和必要历史摘要。后续轮次只追加用户输入及草稿同步信息，不再重复发送完整历史。

每轮都带 `baseRevision`。第一版优先同步最新完整草稿文件快照，避免增量遗漏；对话历史仍由原生会话维护。每轮明确指出宿主实际接受的修订，模型上一轮建议不得被当作已应用事实。

后端完成后仍执行 JSON 解析、Schema 校验、文件路径与图结构验证，再以期望修订号原子应用修改。沿用当前语义：文件操作合法但流程诊断不通过时，允许保存为待修复草稿，轮次成功并附带 `validation.valid=false`，禁止发布。流式内容只用于展示，不能作为部分补丁提前应用。

若校验失败或修订冲突，将结果与失败原因反馈到下一轮上下文，防止模型基于未生效修改继续推理。第一版不自动发起付费修复轮次。

上下文超限时显示明确错误，并允许用户以当前草稿和摘要创建新后端会话。摘要重建不标为原生恢复，记录来源轮次及摘要版本。

## 10. 并发、幂等与状态

同一逻辑对话最多一个执行轮次，第一版对执行期间的新提交返回冲突，不隐式排队；不同对话受全局并发上限控制。保留现有草稿互斥，防止不同对话同时改同一草稿。

客户端 `requestId` 沿用 `command_receipts` 去重。宿主提交幂等不意味着后端恰好执行一次：后端可能已接受，但宿主尚未持久化响应时崩溃。

轮次使用 `queued → running → succeeded | failed | cancelled | interrupted`；取消中使用 `cancel_requested`。`succeeded` 必须同时满足后端完成、最终输出校验成功及宿主提交成功。现有轮次状态字段为 TEXT，需在实现中统一合法状态校验。

后端引用在获得后尽快持久化。对“已发送但结果未知”的轮次，重连后优先查询后端状态；无法确认则标记 `interrupted`，不自动重发 prompt。用户明确重试时创建新轮次，并保留前次不确定状态；节点仍沿用现有 attempt 模型。

取消先调用协议中断，等待后端停止；超时则终止专属进程。取消确认前不允许下一轮开始。未知延迟事件不能写入新轮次；以连接代次和后端轮次标识隔离，Pi 则等待 settled 后切换宿主轮次。

取消不回滚原生历史。下一轮前同步上一轮已取消及草稿未应用的事实。无法确认会话空闲时，重建连接或后端会话。

## 11. 持久化方案（待数据库审核）

现有 `authoring_turns.native_session_id` 不足以承载配置修订、Pi 文件引用、逻辑对话和恢复状态。建议新增 `agent_conversations`，保留现有消息和轮次表：

| 字段组 | 拟议内容 |
| --- | --- |
| 身份 | `id`、`draft_id`、`mode` |
| Provider 快照 | `provider_id`、`provider_revision`、`model_id`、`transport`、`cli_version` |
| 后端引用 | `backend_ref_json`，含引用版本、原生 ID、会话文件、工作目录及后端代次 |
| 上下文 | `context_mode`、`synced_revision`、`rebuild_from_id` |
| 生命周期 | `status`、`created_at`、`updated_at`、`last_used_at` |

初始持久化范围限于草稿创作会话，支持 `single` 与 `multi`；`single` 只保留宿主消息，每轮使用新后端上下文。单次节点与验证不新增持久对话行，执行信息沿用现有 attempt / 验证记录。

`authoring_turns` 和 `authoring_messages` 各拟新增可空 `conversation_id` 外键；轮次拟新增 `backend_turn_id` 与 `connection_generation`，用于诊断和关联。草稿最多一个当前对话，使用会话状态及唯一索引约束；活动轮次仍保留草稿级唯一约束。

`backend_ref_json` 不保存密钥或认证内容。Pi 文件路径只接受宿主管理目录中的引用，前端不得传入任意会话文件路径。

旧消息与轮次保留，关联为空时作为旧版历史展示。首次启用原生会话时，从当前草稿和已有历史创建新上下文，不伪造旧 thread ID。已有 `native_session_id` 保留兼容读取，新增字段稳定后另行评估清理。

精确 DDL、索引、旧数据映射、外键检查、备份和回退步骤见第 20 节；迁移版本按实施时实际最新版本递增，不执行任何结构变更。

## 12. API 与界面

保留现有创作提交、取消和事件订阅入口，新增可选 `conversationId`。旧客户端不传时，服务端解析当前草稿对话，不能每次意外新建原生会话。

新增创建／重置对话、查询当前会话状态的接口。重置需要期望草稿修订号和幂等请求 ID；有活动轮次时拒绝重置。历史消息 API 增加对话标识，默认显示当前对话并提供旧历史入口。

现有事件继续带 Orchard stream ID 和递增 sequence；归一化事件沿用 `provider.*` 与 `turn.*` 命名，精确 payload 见第 22 节。后端完成对应 `provider.completed`，宿主应用完成对应 `turn.succeeded`，禁止混为一个完成事件；不直接暴露后端原始协议作为前端契约。

页面断开不取消多轮创作，重连按 sequence 补读宿主事件，不再次提交 prompt。模型验证保留当前断开即取消的行为。

界面区分连接恢复中、执行中、已中断和需要重建上下文。Provider 设置显示实际传输模式和已验证能力；普通用户只需选择模型及新建／继续对话，不必选择 JSON-RPC 参数。

## 13. 兼容与降级

保留 Provider ID、模型目录、自定义网关和配置快照语义。进程以启动时配置运行，配置变化不改写正在执行的轮次；后续调用建立新的后端上下文，禁用 Provider 阻止新调用。

传输模式由 Provider 设置明确记录为原生会话或兼容单次模式。原生模式启动失败时返回具体错误，不在请求可能已提交后自动改用 `exec` 或重发。

旧 CLI 不满足协议要求时，可由用户显式选择兼容模式。兼容模式的多轮依赖宿主历史重建，能力显示 `nativeResume: false`。不支持的特性参数在启动检测时发现，不等待真实付费请求才暴露。

握手和模型目录检查不等于账号或模型可用性验证；真实模型验证仍是用户显式触发的独立调用。

## 14. 实施顺序

1. 审核会话业务语义、精确数据库方案与迁移回退方案。
2. 增加常驻传输层、会话接口与协议契约测试，保持现有默认行为。
3. 分别实现 Codex App Server 和 Pi RPC 的能力检测、单轮、流式与中断。
4. 在审批后的持久化模型上接入草稿多轮、事件补读和恢复。
5. 完成两个后端的真实环境验收，再将原生模式设为推荐路径。

第一版不做共享 Codex 进程池、Pi 会话并发切换、自动 prompt 重试或自动上下文摘要，先保证轮次归属和故障行为可预测。

## 15. 验收标准

- 同一会话连续三轮能引用前文；新建会话不会读取旧上下文。
- 同一输入重复运行工作流时，节点不会继承上次运行的模型历史。
- 两个后端均覆盖单轮、多轮、文本增量、最终校验失败和明确终态。
- 进程初始化失败、CLI 不兼容、错误响应、输出超限和非法协议均有明确错误。
- 覆盖拆包、粘包、CRLF、Unicode 分隔符、背压、事件早于请求响应及未知事件。
- 模拟后端接受请求后宿主崩溃，不自动重复调用；不确定轮次可见。
- 取消后无遗留执行；Pi 排队消息不会在取消后继续运行。
- 服务重启能恢复持久会话，不能恢复时提示重建；临时会话不宣称恢复。
- 草稿手动修改、修订冲突、重置会话和切换模型后，上下文与实际文件一致。
- 页面刷新和事件重连不重复提交，不重复应用最终变更。
- 保留 Magpie 路由和本机认证，确认两种后端均未获得额外工具能力。
- 若实施迁移，覆盖旧数据库升级、消息保留、外键校验和失败回滚。

模拟协议测试与真实账号验收分开记录。真实验收至少包括本机 Codex 与 Pi 各一次三轮创作、取消、重启恢复及两次独立节点调用；未经执行不得标记通过。

## 16. 协议依据

查阅日期：2026-11-04。在线文档可能变化，实施时必须记录实际 CLI 版本并固定测试样例。本机已检查 Pi 1.4.0 包内 RPC 文档；不据此宣称其他版本兼容。

- [OpenAI Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)：进程连接、初始化、thread/turn 和事件协议。
- [Pi RPC 官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)：常驻进程、JSONL framing、响应关联与完成边界。
- [Pi RPC Commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md)：prompt、abort、会话管理与状态命令。
- 项目当前行为参见 [Provider 文档](../../wiki/architecture/providers.md)、`src/providers/registry.ts`、`src/runtime/process.ts`、`src/authoring/service.ts` 和 `src/persistence/schema.ts`。

## 17. 实施决策与模块边界

本节起为实现约束，优先于前文的概念性描述。实施 Agent 不得自行省略异常分支或自动扩大范围。除数据库审核边界及协议安全能力验证外，常规实现无需再次询问产品选项。

### 17.1 固定决策

| 决策 | 第一版规定 |
| --- | --- |
| 创作对话模式 | `single`、`multi`；新对话默认 `multi` |
| 兼容调用 | 配置 `transport: "legacy"`，多轮通过宿主历史重建 |
| 原生调用 | 配置 `transport: "native"`，多轮使用后端原生会话 |
| 现有安装升级 | config 缺少 transport 时按 legacy 读取，不自动切换已有配置 |
| 模型变更 | 创建新的当前逻辑对话，保留旧对话及历史，不原地改变 Provider/model |
| 配置变更 | 下一次提交检测到快照变化时原子轮换对话 |
| Provider revision | 用作记录；模型目录刷新等无连接变化不触发轮换，以连接指纹判断 |
| 同会话重复提交 | 相同 requestId 返回同一受理结果；不同 requestId 且未结束则 409 |
| 中断重试 | 用户发起新轮次；不实现独立 authoring_attempts 表 |
| 自动恢复 | 仅恢复上下文；第一版不自动恢复未结束轮次的结果应用 |
| 会话摘要 | 第一版使用确定性历史摘录，不额外调用模型摘要 |
| 数据删除 | 删除宿主记录与宿主管理的 Pi 文件；不直接删除 Codex 用户全局历史 |

`transport` 属于 Provider `config_json`，不增加 Provider ID。对缺失字段的默认值必须在读取规范化层处理，不能只依赖 UI。

连接指纹对以下白名单字段做 canonical JSON SHA-256：Provider ID、绝对 executable、transport、规范化 CODEX_HOME 或 Pi 配置目录来源、工具限制策略版本。模型 ID 单独比较。不要散列或保存完整环境、config.toml 或认证文件。外部 CLI 配置变化无法只靠本地 revision 检出，界面提供“重建上下文”操作使新进程加载最新配置。

### 17.2 文件职责

| 文件或模块 | 职责 |
| --- | --- |
| `src/domain/types.ts` | 公共对话、轮次、能力及 API DTO，保持旧字段可读 |
| `src/providers/session.ts`（新增） | Provider 会话接口、句柄与事件类型 |
| `src/providers/transport/jsonl.ts`（新增） | 字节分帧、写入背压、有界缓冲与子进程生命周期 |
| `src/providers/transport/pending.ts`（新增） | 请求 ID 关联、请求超时、关闭时统一 reject |
| `src/providers/codex-app-server.ts`（新增） | Codex 握手、请求、通知及最终文本重建 |
| `src/providers/pi-rpc.ts`（新增） | Pi 命令、disposition、消息重建及 settled 判定 |
| `src/providers/session-manager.ts`（新增） | 会话专属进程、配额、空闲回收与连接代次 |
| `src/providers/registry.ts` | 保留注册、模型、验证与 legacy 入口，按能力分派，不继续堆叠协议解析 |
| `src/authoring/conversations.ts`（新增） | 对话创建、轮换、恢复决策及持久引用 |
| `src/authoring/context.ts`（新增） | 首轮／续轮输入、历史摘录、上一轮宿主结果 |
| `src/authoring/service.ts` | 创作任务编排、草稿 CAS、取消和成功提交 |
| `src/persistence/schema.ts` / `store.ts` | 审核后实施迁移、查询、约束、删除与重启恢复 |
| `src/server/app.ts` | 实际现有路由入口，新增 API Schema 与关闭顺序 |
| `src/web/features/DraftPage.tsx` | 会话选择、重置、忙状态和实时文本 |
| `src/web/features/SettingsPage.tsx` | 传输模式与检测结果 |
| `src/web/lib/api.ts` | DTO、SSE 去重与终态刷新 |

不得假设存在 `src/server/routes/authoring.ts`：当前路由集中在 `app.ts`。本 feature 不强制拆分全部路由或重构无关运行器。

## 18. TypeScript 契约

### 18.1 公共数据

```ts
type ConversationMode = "single" | "multi";
type ContextMode = "isolated" | "native" | "reconstructed";
type ConversationStatus = "current" | "archived" | "needs_rebuild"; // 已扩展 "idle"（history-feature.md，v4 迁移已实施）
type ConnectionState = "absent" | "starting" | "ready" | "stopping" | "broken";
type AuthoringTurnStatus =
  | "queued" | "running" | "cancel_requested"
  | "succeeded" | "failed" | "cancelled" | "interrupted";
type SubmissionState = "not_sent" | "sending" | "accepted" | "settled";

interface ConversationView {
  id: string;
  draftId: string;
  mode: ConversationMode;
  contextMode: ContextMode;
  status: ConversationStatus;
  providerId: string;
  providerRevision: number;
  modelId: string;
  transport: "native" | "legacy";
  cliVersion: string | null;
  syncedRevision: number | null;
  rebuildFromId: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  connectionState: ConnectionState;
}
```

`connectionState` 来自内存管理器，不落库。`current` 和 `needs_rebuild` 都占用草稿的“当前对话”名额；`needs_rebuild` 允许查看但不允许继续生成。

后端引用为内部类型，不直接包含在公开 DTO：

```ts
type BackendRef =
  | { version: 1; kind: "codex"; threadId: string; cwd: string }
  | { version: 1; kind: "pi"; sessionId: string; sessionFile: string; cwd: string };

interface ProviderSessionHandle {
  key: string;
  generation: number;
  ref: BackendRef | null;
}

interface SessionOpenRequest {
  key: string;
  modelId: string;
  cwd: string;
  persistent: boolean;
  signal: AbortSignal;
  resumeRef?: BackendRef;
}

interface SessionTurnRequest extends TurnRequest {
  hostTurnId: string;
  onAccepted: (backendTurnId: string | null) => Promise<void>;
}

interface SessionProvider {
  openSession(
    setting: ProviderSetting,
    request: SessionOpenRequest
  ): Promise<ProviderSessionHandle>;
  sendTurn(
    handle: ProviderSessionHandle,
    request: SessionTurnRequest
  ): Promise<ProviderResult>;
  interruptTurn(
    handle: ProviderSessionHandle,
    hostTurnId: string,
    signal: AbortSignal
  ): Promise<void>;
  releaseSession(handle: ProviderSessionHandle): Promise<void>;
}
```

用一个 `openSession` 表达创建／恢复，避免适配器靠全局“当前会话”找连接。`openSession` 返回后，调用方必须先持久化 `ref`，再发送第一条 prompt。Pi 在首轮前无法提供已存在文件时，持久化预分配的 session ID、受控目录及 cwd，首轮接受后通过 `get_state` 补充实际文件；恢复前必须验证文件存在，不能创建一个空同名会话冒充恢复。

`setting` 由 registry 解析并 `structuredClone` 为本轮快照。接口中的 `TurnRequest` 沿用现有 prompt/schema/signal/cwd/timeoutMs/emit；`ProviderResult` 增加可选 `backendTurnId`、`usageScope: "turn" | "session"`，保留 modelSource 语义。

`onAccepted` 必须 await。适配器已注册事件缓存后才能写 prompt；accepted 回调持久化失败时立即中断、将本轮归为不确定，不把后端结果继续应用。

### 18.2 单次入口

`registry.run()` 与 `verifyModel()` 签名保持兼容：

1. legacy 调用原 `CliProvider.turn()`。
2. native 创建临时专属句柄，`persistent=false`，发送一轮。
3. 不论成功失败，finally 中释放句柄并等待进程退出。
4. 节点与验证不查找或写入任何草稿会话。
5. Codex 临时 thread 明确设 `ephemeral=true`；Pi 明确 `--no-session`。

创作 `single` 模式同样使用临时句柄，但宿主消息归属于持久逻辑对话；每轮 prompt 只包含当前文件和本次请求，不含旧对话。`multi + legacy` 才重建历史。

### 18.3 能力与配置兼容

现有 `AgentProvider.capabilities` 保留为静态基础声明。增加可选 `sessionProvider?: SessionProvider` 和可选 `capabilitiesFor(setting)`；registry.views 使用后者输出实际模式能力，未实现时回退基础声明。新增 `sessions` 对旧 Provider 可缺省，registry 规范化为 none，避免强迫第三方实现会话。

两个内建 Provider 的 config Schema 增加可选 `transport` 枚举 legacy/native，继续 `additionalProperties: false`，禁止任意 argv。设置编辑保存必须合并现有 config，不能因 UI 只提交 executable 就意外清空 transport。

能力缺失与 readiness 不可混淆：native 适配器理论支持 persistent，但当前 CLI 版本或工具策略不支持时 readiness 为 unavailable，不把基础能力作为已经通过验证的证据。ProviderView 额外返回本次检测的 transport、版本和错误码，不覆盖旧的 state/version/reason。

内建 Provider 的模型刷新继续用现有 codex-config 和 Pi --list-models，不为目录刷新建立持久会话。verifyModel 绕过模型启用限制的现有约定保留，但仍要求 Provider 已启用。

## 19. 状态转换与算法

### 19.1 受理一轮

按以下顺序实现，任何 `await` 之后都不得假设草稿状态未变：

1. 校验请求形状、prompt ≤100 KiB、requestId 和显式 conversationId 的归属。
2. 查询 `turn:<draftId>` 的 command receipt；命中先校验输入 hash，返回原受理快照，不启动任务。
3. 解析模型和 Provider 快照、检查启用状态及 readiness；检测缓存规则见第 23 节。同步预留调度队列名额，满时返回 AGENT_QUEUE_FULL；若受理事务失败必须释放预留。
4. 生成输入快照，限制构造后 prompt ≤512 KiB；超限在入队前返回错误，不消耗模型。
5. 在一个同步 DB 事务中重新校验 revision、草稿可编辑、无活动轮次、Provider 未禁用且配置快照未变。
6. 解析或轮换当前对话，插入 queued 轮次、用户消息、`turn.queued` 事件及 receipt；原子提交。
7. 事务后登记内存 job 并尝试调度，HTTP 返回 202。一次受理最多登记一个 job。
8. 调度获得槽位后，将 queued CAS 为 running，分配并持久化 connection generation。
9. 建立／恢复会话，持久化 backend ref。对于 native 多轮，使用已有 backend ref 时不追加历史摘录；初次创建则发送 initial 输入。只有创建失败且从未发 prompt，才可以安全再尝试打开连接；第一版仍不自动重试，交给用户重试。
10. 持久化 submission_state=sending，再写入 prompt；接受回调写 accepted 和 backend_turn_id。
11. 处理事件并等待后端 settled；写 submission_state=settled，再进行结果校验和文件准备。
12. 事务内检查状态仍 running、取消未生效、baseRevision 未改变，再提交草稿、assistant 消息、turn.succeeded。

若步骤 6 后服务在登记 job 前退出，启动恢复会将 queued 标为 interrupted；不自动调用模型。受理 receipt 保留，客户端重复提交同 requestId 只看到原任务。

`ConversationService` 必须返回本轮实际选用的对话；不能先计算 prompt、再无提示地换到不同上下文。步骤 4 可预构建 initial 与 continuation 两种输入并校验预算，步骤 6 持久化实际选用的输入；首次 backend ref 在打开后才确定时，使用保守 initial 输入，但不得塞入整个历史。配置轮换时在同一受理事务中决定新对话，并用对应的首轮 context 输入发送。

### 19.2 状态表

| 当前状态 | 触发 | 新状态及动作 |
| --- | --- | --- |
| queued | 获得资源 | running；开始总执行时限 |
| queued | 用户取消 | cancelled；从队列删除，不启动子进程 |
| running | 用户取消 | cancel_requested；停止接收可应用结果，启动中断 |
| running | 后端完成且提交成功 | succeeded |
| running | 输出非法或明确后端失败 | failed；记录错误及宿主未应用结果 |
| running | 接受／执行状态未知、进程异常退出 | interrupted；对话 needs_rebuild |
| cancel_requested | settled 或专属进程已确认退出 | cancelled |
| queued/running/cancel_requested | 宿主异常重启 | interrupted；绝不重发 |
| 任意终态 | 重复事件／取消 | 保持终态，不重复消息、补丁或终态事件 |

取消与成功提交以 DB 事务先后决定：先成功则取消返回 succeeded；先写 cancel_requested 则后到结果不得修改草稿。超时主动中断并清理后落 failed/TIMEOUT；用户取消落 cancelled/CANCELLED；无法确保停止则 interrupted/INTERRUPT_UNCONFIRMED。

所有数据库转换使用带当前状态条件的 UPDATE，并检查 changes 数量。所有 busy 检查统一使用 `queued/running/cancel_requested`，包括手动编辑、发布、删除、运行测试和唯一索引。

### 19.3 结果校验

把当前 `AuthoringService.generate()` 的文件变更应用提取为纯准备阶段，保持已有语义：

- 检查 AUTHORING_SCHEMA、重复路径、safeFile、create/update/delete 与原文件状态。
- 检查单文件／总文件限制、工作流身份不可变。
- 执行现有 validateFiles；业务诊断不通过可保存待修复草稿。
- 保存不可变文件树后，事务内执行草稿 revision CAS、终态、消息及事件提交。
- 没有 changes 时 revision 不变，仍写成功消息和后端宿主结果。
- 废弃的文件树可按现有存储清理规则回收，不让存储失败造成“轮次成功但文件未提交”。

### 19.4 恢复规则

第一版采用保守恢复：启动时所有未结束轮次都变为 interrupted。`submission_state=not_sent` 的会话可继续；sending/accepted 且没有可靠 settled 边界的会话标 needs_rebuild。

后端状态查询只用于判断会话是否安全和展示诊断，不在重启时重新应用旧结果。已成功的轮次也不重新应用。空闲、已完成会话在下一次提交时懒恢复。

`thread/resume`、Pi 会话文件打开失败时：

- 明确不存在或不兼容：needs_rebuild + SESSION_REBUILD_REQUIRED。
- 临时启动故障、资源不足：本轮失败，保留引用，用户可再次提交。
- 恢复成功但无法确认空闲：中断并回收连接，仍需重建。

## 20. 精确持久化提案与迁移

本节为待审核 DDL 提案，不能仅凭存在于文档就执行。总体方案已确认不代表已执行或已验收结构迁移。

更新：本节 v3 方案已审核通过并实施（`SCHEMA_VERSION=3`）；历史对话 feature 的 v4 增量（`idle` 状态、`title`、`archived_at`，含唯一索引谓词收窄为仅 `current`）已另行审核并实施，见 [history-schema-proposal.md](./history-schema-proposal.md)。

### 20.1 新表与列

```sql
CREATE TABLE agent_conversations (
 id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES drafts(id),
 mode TEXT NOT NULL CHECK(mode IN ('single','multi')),
 context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native','reconstructed')),
 status TEXT NOT NULL CHECK(status IN ('current','archived','needs_rebuild')),
 provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),
 model_id TEXT NOT NULL,
 transport TEXT NOT NULL CHECK(transport IN ('legacy','native')),
 connection_fingerprint TEXT NOT NULL,
 cli_version TEXT,
 backend_ref_json TEXT,
 backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),
 synced_revision INTEGER CHECK(synced_revision >= 0),
 rebuild_from_id TEXT REFERENCES agent_conversations(id),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 last_used_at INTEGER,
 CHECK (
  (mode='single' AND context_mode='isolated')
  OR (mode='multi' AND transport='native' AND context_mode='native')
  OR (mode='multi' AND transport='legacy' AND context_mode='reconstructed')
 )
);
CREATE UNIQUE INDEX one_current_conversation
 ON agent_conversations(draft_id)
 WHERE status IN ('current','needs_rebuild');
CREATE INDEX conversations_by_draft
 ON agent_conversations(draft_id,created_at,id);

ALTER TABLE authoring_turns ADD COLUMN conversation_id TEXT REFERENCES agent_conversations(id);
ALTER TABLE authoring_turns ADD COLUMN backend_turn_id TEXT;
ALTER TABLE authoring_turns ADD COLUMN connection_generation INTEGER;
ALTER TABLE authoring_turns ADD COLUMN submission_state TEXT NOT NULL DEFAULT 'not_sent'
 CHECK(submission_state IN ('not_sent','sending','accepted','settled'));
ALTER TABLE authoring_turns ADD COLUMN input_ref TEXT;
ALTER TABLE authoring_turns ADD COLUMN result_ref TEXT;
ALTER TABLE authoring_messages ADD COLUMN conversation_id TEXT REFERENCES agent_conversations(id);

DROP INDEX one_active_turn;
CREATE UNIQUE INDEX one_active_turn
 ON authoring_turns(draft_id)
 WHERE status IN ('queued','running','cancel_requested');
CREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id);
CREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence);
```

`input_ref` 通过现有 Store.reference 保存实际发送的 context envelope，`result_ref` 保存后端最终文本、模型、usage 和宿主应用结果；沿用现有 artifact 引用格式，不手写另一个 blob 系统。JSON 文本转义后可能超过现有 16 MiB 引用上限，超限时明确 OUTPUT_LIMIT，不声称 8 MiB 原始文本一定能持久化。

不新增 authoring_attempts；每轮一次后端提交，显式重试创建新轮次。`native_session_id` 不删除；新实现读取 backend_ref_json 为准，该旧字段只保留历史兼容，不双写两个权威引用。

`synced_revision` 表示最近一次被后端接受输入所携带的草稿修订，不表示生成结果已应用。实际应用结果以轮次 result_ref 和 drafts.revision 为准。

跨表同属草稿在 Store 写入方法中强制校验：turn.conversation.draftId 与 turn.draftId 一致；message 同样检查，带 turnId 时还必须与该轮 conversationId 一致。保留旧 null 关联；不得在通用 SQL 中绕过方法写新记录。若实施时选择加 trigger，需把新增 DDL 纳入同一次结构审核。

### 20.2 Store 方法与 SQL 兼容

新增 `conversation(id)`、`conversations(draftId)`、`currentConversation(draftId)`、`createConversation(...)`、`archiveConversation(...)`、`saveBackendRef(...)` 和 `transitionTurn(...)`。公开返回值不带 backend ref。

`message()` 增加可选 conversationId；消息 sequence 继续按 draft 全局递增，不按对话重新从 1 编号。`messages(draftId, conversationId?)` 不传时保持原有全量语义；API 根据 query 明确过滤。

当前 Store 与测试有 `INSERT ... VALUES(...)` 不带列名的写法。扩列前必须将所有 authoring_turns / authoring_messages 插入改成显式列名，覆盖 fixtures 与恢复路径，避免迁移后列数错误。

删除先删除消息和轮次，再将该草稿 conversations.rebuild_from_id 置 NULL，删除会话，最后删草稿。扩充 command_receipts 清理 scope；事务提交后释放相应空闲连接并删除宿主管理的 Pi 目录，删除失败记录诊断但不恢复已删除 DB 行。

### 20.3 迁移与回退

1. 审核本节 DDL 及增量修订，获得授权后才编辑 schema/migration。
2. 服务停止并释放数据目录锁；使用 SQLite 备份 API 或已完成 checkpoint 且无连接的数据库副本备份，不能直接复制活动 WAL 数据库主文件。
3. 在事务内执行增量迁移，保留所有旧会话关联为 NULL，不自动创建对话或更改 Provider 配置。
4. 新库初始化 Schema 与升级后 Schema 必须等价；旧版本先运行已有 v1→v2，再运行本 feature 增量迁移。
5. 现有 Store 的允许版本检查需接受所有受支持旧版本，不能保持仅 `[1, SCHEMA_VERSION]` 导致 v2 被拒。
6. 校验 foreign_key_check、旧行数量及关键字段一致；写 user_version 后提交，失败回滚。
7. 首次提交再创建逻辑对话；旧消息只在 legacy 或显式迁移上下文时使用，不捏造原生历史。
8. 回退停止服务并恢复完整数据库备份及匹配代码；不执行逆向 DROP COLUMN。升级后产生的新数据必须先导出并说明回退会丢失的范围。

启动 Store.recover 扩展 active 状态处理和 needs_rebuild 标记，维持在同步事务中；不在 Store 构造函数中发 RPC 或网络请求。

## 21. 协议适配实施细则

### 21.1 Codex 0.166.0 核对基线

本次已读取本机 `codex-cli 0.166.0` 的 `app-server --help`，并用 `app-server generate-json-schema --out <临时目录>` 导出协议。该操作只生成本地 Schema，没有调用模型。实施时把最小协议类型和去敏测试样例提交仓库，不提交用户配置或全部生成文件。

基线字段：

| 方法／通知 | 必要处理 |
| --- | --- |
| initialize | clientInfo 必填；握手完成后发送 initialized |
| thread/start | 显式 model、cwd、ephemeral、sandbox、approvalPolicy；工具限制通过已验证 config 覆盖 |
| thread/resume | threadId 必填；重新指定模型与限制，不继承未知权限 |
| turn/start | threadId、input 必填；输入文本项结构从导出 UserInput 类型固定 |
| turn/start.outputSchema | 基线支持时传宿主 Schema，同时保留宿主校验 |
| item/agentMessage/delta | 校验 threadId、turnId、itemId、delta |
| turn/completed | 从 turn.status 区分成功、失败、中断，不能只看通知名字 |
| thread/tokenUsage/updated | 保存后端原始 usage 并注明范围，不能把线程总量冒充单轮用量 |
| thread/read | 可用于恢复诊断；不据此自动应用未完成旧轮次 |

请求例子为 Orchard 要发送的最小形状，最终以导出的基线 Schema 契约测试为准：

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"orchard","version":"0.1.0"}}}
{"method":"initialized","params":{}}
{"id":2,"method":"thread/start","params":{"model":"准确模型ID","cwd":"宿主管理目录","ephemeral":false,"sandbox":"read-only","approvalPolicy":"never"}}
{"id":3,"method":"turn/start","params":{"threadId":"返回的thread ID","input":[{"type":"text","text":"宿主构造的完整输入","text_elements":[]}]}}
```

最终消息按 `itemId` 保存已完成 agentMessage，增量仅用于显示。收到 completed item 时以完整 text 覆盖该 item 的增量缓冲，不能再拼一次造成重复；从当前轮最终 assistant 消息选取结果，不从推理摘要或 stderr 抽取 JSON。缺少最终消息时返回 INVALID_AGENT_OUTPUT。

同一 thread 一次只允许一个 turn。对 `turn/start` 响应之前到达的通知，在专属连接内暂存并按 thread/turn 校验；收到接受 ID 后关联，异 ID 不归入本轮。缓冲受每轮事件大小限制。

服务端发来的带 id 请求必须处理，不能当通知丢弃：已知审批／工具请求按基线定义返回拒绝或协议错误，终止本轮为 TOOLS_DISABLED；未知方法返回 method-not-found。不得默认批准、调用工具或无限等待。

### 21.2 Codex 权限验证门槛

`read-only` 和 `approvalPolicy=never` 不等于“无工具”。实施须复用当前禁用 features、MCP、notify、web_search 的策略，生成专门的 App Server 启动参数和配置覆盖。

契约测试需分别模拟命令工具、文件工具、MCP 和审批请求；本地真实 CLI 配合模拟 Responses 网关验证实际发出的工具列表为空且未启动预置 MCP。若安装版本不能满足现有无工具边界，native readiness 返回 unavailable/TOOLS_POLICY_UNSUPPORTED，保留 legacy 可用路径。不能仅因会话接口握手成功就通过此项。

### 21.3 Pi 1.4.0 固定流程

启动参数由数组构造，不拼 shell：

```text
pi --mode rpc --no-extensions --no-mcp --no-tools
   --thinking off --model <准确模型ID>
```

- 临时会话加 `--no-session`。
- 新持久会话加 `--session-dir <root>/agent-sessions/pi/<conversationId>` 与宿主 UUID `--session-id <id>`。
- 恢复使用已经验证的绝对 `--session <file>`，不使用“最新会话”或模糊 ID。
- cwd 固定 `<root>/agent-workspaces/<conversationId>`；节点／验证使用唯一临时目录。不要在用户仓库 cwd 中启动以免加载无关项目资源。
- 新进程先 `get_state`，确认模型、sessionId 与 isStreaming=false，恢复后也做同样检查。

```json
{"id":"r1","type":"get_state"}
{"id":"r2","type":"prompt","message":"宿主构造的完整输入"}
{"id":"r3","type":"clear_queue"}
{"id":"r4","type":"abort"}
```

prompt disposition=started 才接受为本轮执行；queued 或 handled 在关闭 extensions 且禁止并发的本 feature 中属于非预期，返回 PROTOCOL_STATE_INVALID 并清理连接，不等待永远不会到来的完成事件。accepted 后的模型错误通过消息和事件判定，不再期待第二个 response。

在 `agent_settled` 后检查最终 assistant 消息及 stopReason：error 为失败，aborted 按取消原因归类，正常结束但无文本为 INVALID_AGENT_OUTPUT。重试过程中的临时错误不能提前当最终错误。模型 reported/requested 规则沿用现有实现。

`clear_queue` 响应后才能 `abort`；即使 clear_queue 失败仍尝试 abort，最终无法确认 settled 时终止进程。中断用单独控制信号，不能复用已 aborted 的生成 signal。

Pi 的会话目录限制必须在 realpath 层校验，并拒绝越界 symlink、缺失文件、目录冒充文件和超出文件大小预算。Pi 延迟创建 sessionFile 时允许“尚未生成”状态，但服务重启后不能将缺失文件当作成功恢复。

## 22. HTTP、事件与 UI 精确约定

### 22.1 路由

所有路由沿用 `/api`、现有 Host/Origin 校验和 AppError 结构，不建立新的 SSE 服务。

| 方法与路径 | 输入／输出 |
| --- | --- |
| GET `/api/drafts/:id` | 保留 files/messages/turns；新增 currentConversation、conversations |
| GET `/api/drafts/:id/conversations` | `{ items: ConversationView[], currentId: string | null }` |
| POST `/api/drafts/:id/conversations` | 新建／重置，输入见下；返回 201 ConversationView，不调用模型 |
| POST `/api/drafts/:id/turns` | 保留原必填参数，新增可选 conversationId；返回 202 Turn |
| POST `/api/drafts/:id/turns/:turnId/cancel` | 202 返回当前轮次；终态重复取消返回 200 |
| GET `/api/drafts/:id/messages?conversationId=...` | 显式选对话；不传返回全部；`legacy` 返回 NULL 关联旧历史 |
| GET `/api/turns/:id/events` 与 `/stream` | 沿用 sequence 分页、Last-Event-ID、补读行为 |

新建请求：

```json
{
  "providerId": "codex-cli",
  "modelId": "准确模型ID",
  "mode": "multi",
  "expectedRevision": 3,
  "requestId": "客户端唯一ID",
  "rebuildFromId": null
}
```

`rebuildFromId` 缺省或 null 表示全新上下文，只带当前草稿；非空必须属于同一草稿且为当前对话，表示用户明确重建并携带确定性历史摘录。不得加载另一草稿的消息或后端引用。scope 使用 `conversation:<draftId>`；同 requestId 不同 body 返回 REQUEST_CONFLICT。

创建操作在事务内校验可编辑及无 active turn，将旧 current/needs_rebuild 归档再插入新行。它不提高草稿 revision、不调用模型；新 conversation 在首轮才创建后端进程。两个并发重置请求通过 DB 唯一索引和事务串行化。

提交轮次若显式 conversationId 已归档，返回 CONVERSATION_CONFLICT；若缺省，使用当前对话或首次懒创建。显式选择不同 Provider/model 但仍携带旧 conversationId 返回 CONVERSATION_CONFLICT，由新客户端先重置；旧客户端不传 ID 时允许原子轮换并在返回 Turn 附 conversationId。

快照默认继续返回全部 messages/turns，保持旧客户端兼容。新 UI 自行按 currentConversation.id 过滤并提供“历史对话”；未关联消息单列为旧版历史。

### 22.2 事件

每条 payload 以现有 Store.append 持久化，再对外发布；不得仅向 SSE 临时推送。字段除已有兼容字段外只追加。

| 类型 | Payload |
| --- | --- |
| turn.queued | `{ conversationId, mode, contextMode }` |
| turn.started | `{ conversationId, connectionGeneration }` |
| provider.session | `{ conversationId, state: "creating" \| "resuming" \| "ready" }` |
| provider.started | 保留 providerId/requestedModel/revision/executable，新增 transport |
| provider.accepted | `{ conversationId, backendTurnId: string \| null }` |
| provider.text | 保留 `{ text }`，新增 itemId（可选）、offset |
| provider.usage | `{ usage, scope: "turn" \| "session" }` |
| provider.diagnostic | 保留 `{ text }`，去敏并受限 |
| provider.completed | ProviderResult；仅表示后端结果已就绪 |
| turn.cancel_requested | `{ reason: "user" \| "shutdown" \| "timeout" }` |
| turn.succeeded | 保留 summary/validation，新增 conversationId、appliedRevision |
| turn.failed / turn.interrupted | `{ code, message }`，可追加 conversationId |
| turn.cancelled | `{ code: "CANCELLED", message }` |

每个 turn 的 provider.text offset 按 UTF-8 字节累计。UI 按 streamId+sequence 去重；不得仅按文本内容去重。同一轮的重连补读能重建完整显示；最终 summary 与临时 JSON 文本分开显示。

为避免每个 token 都执行 SQLite 事务，适配器每 50 ms 或累计 4 KiB 合并一次增量，终态前 flush。增量可在崩溃时丢失尚未持久化的最多一个批次，不能丢失已确认的宿主终态。

### 22.3 错误与状态码

| Code | HTTP／轮次行为 |
| --- | --- |
| CONVERSATION_CONFLICT / DRAFT_BUSY / REVISION_CONFLICT | 409，受理前无模型调用 |
| NOT_FOUND | 404，包含错草稿引用时不泄漏后端信息 |
| PROVIDER_UNAVAILABLE / PROTOCOL_UNSUPPORTED / TOOLS_POLICY_UNSUPPORTED | 503 或已受理轮次 failed |
| SESSION_REBUILD_REQUIRED | 409；已受理后恢复失败则 failed，并将对话 needs_rebuild |
| AGENT_QUEUE_FULL | 503，受理前拒绝 |
| TIMEOUT / OUTPUT_LIMIT / INVALID_AGENT_OUTPUT | 已受理轮次 failed |
| PROTOCOL_STATE_INVALID / PROCESS_EXITED_UNEXPECTEDLY | 执行是否明确结束决定 failed 或 interrupted |
| INTERRUPT_UNCONFIRMED | interrupted，不释放同对话并发锁直至进程确认退出或连接隔离 |

现有 error handler 对除 NOT_FOUND 之外错误优先使用 AppError.statusCode；新增代码必须显式设置正确状态码，不依赖字符串自动匹配所有情况。

### 22.4 UI

DraftPage 的 activeTurn 判定从仅 running 改为 queued/running/cancel_requested；这些状态均锁定编辑、发布、测试、新对话和重复发送。

增加“单次／多轮”模式展示、“新对话”“重建上下文”“历史对话”操作；模式变更创建新对话，不直接 PATCH 旧行。历史对话默认只读展示；继续、恢复与归档行为由 [history-feature.md](./history-feature.md) 扩展（`idle` 状态已随 v4 迁移实施）。

未保存修改时先保存再创建／重建；不得丢弃编辑器内容。模型选择变化在发送前创建新对话并明确提示上下文重新开始。无需向用户展示后端文件路径或 JSON-RPC 参数。

needs_rebuild 禁止继续发送，提供明确重建入口。queued 显示等待资源，cancel_requested 显示正在停止；只有确认终态才重新启用输入。取消请求本身不清空流式显示。

## 23. 资源、关闭和上下文预算

### 23.1 默认参数

参数集中在一个运行时常量模块，可经服务初始化参数覆盖以便测试；第一版不新增零散环境变量或 UI 配置。

| 参数 | 默认值 |
| --- | --- |
| maxAgentProcesses | 4，包含探测、模型验证、单次及多轮进程 |
| maxQueuedTurns | 32 |
| queueWaitTimeoutMs | 60,000 |
| initializeTimeoutMs | 10,000 |
| requestAckTimeoutMs | 15,000 |
| authoringTurnTimeoutMs | 600,000 |
| modelVerificationTotalTimeoutMs | 60,000，含排队／探测 |
| interruptGraceMs | 5,000 |
| terminateGraceMs | 300，SIGTERM 后 SIGKILL |
| idleTtlMs | 600,000 |
| maxPendingRequestsPerConnection | 16 |
| maxBufferedWriteBytes | 1 MiB |
| maxProtocolRecordBytes | 8 MiB |
| maxTurnTextBytes / maxTurnDiagnosticBytes | 各 8 MiB |
| maxTurnProtocolBytes | 32 MiB，包括未知通知和重复消息 |

调度器 FIFO，但先复用目标会话已就绪连接；无空槽时先回收最久空闲连接再启动，不等待所有 idleTtl 耗尽。保留单次 legacy 进程也必须申请同一槽位；禁止绕过限额。

检测 `--version` 与无模型握手使用相同资源池但不得占用当前轮次必须持有的第二个槽位。ready 的探测必须在申请执行槽前完成，或在同一个槽位内复用初始化结果，避免 max=1 死锁。

探测缓存按 executable、transport、连接指纹缓存 60 秒；Provider 配置变更立即失效。探测握手后不发 prompt、不初始化持久草稿对话，完成立即退出。

复用现有进程时沿用原 generation；每次启动新进程前在事务中递增 conversation.backend_generation，将值写到 turn.connection_generation。单次句柄使用内存单调代次，回收后不得重复 key+generation。所有回调先校验句柄未释放和代次一致，晚到通知只记录受限诊断。

### 23.2 关闭顺序

Fastify preClose 先拒绝新提交，关闭 SSE，再取消验证并停止调度新轮次。onClose 依次：

1. queued 任务取消并写终态。
2. 活动轮次进入 cancel_requested，调用协议中断。
3. 等待生成／运行器任务结束，期间 Store 保持打开。
4. 关闭所有 idle/active Provider 连接，必要时 kill 进程组。
5. 确认无事件处理器再写 Store 后，关闭 Store 并释放锁。

不得在 Store.close 后异步保存 usage/diagnostic。关闭时任一步失败也必须继续清理其他连接，最后汇总错误。

### 23.3 Context envelope

`context.ts` 输出结构化 JSON envelope，外面保留现有固定创作规则与 AUTHORING_SCHEMA。版本固定 `contextVersion: 1`：

```ts
interface AuthoringContext {
  contextVersion: 1;
  kind: "initial" | "continuation";
  draftId: string;
  baseRevision: number;
  files: SourceFiles;
  availableAgents: unknown[];
  previousOutcome: {
    turnId: string;
    status: AuthoringTurnStatus;
    appliedRevision: number | null;
    errorCode: string | null;
  } | null;
  historyExcerpt?: {
    source: "legacy" | "explicit_rebuild";
    messages: Array<{ role: string; text: string }>;
    truncated: boolean;
  };
  userRequest: string;
}
```

initial 用于新后端上下文；continuation 用于已创建／原生恢复的 multi。single 每次 initial，且不含 historyExcerpt。previousOutcome 从宿主轮次读取，不能信任模型关于“已改文件”的陈述。

历史摘录按全局 sequence 排序，从最近消息向前取 ≤64 KiB UTF-8，总计最多 20 条，最后恢复原顺序；每条最多 8 KiB，只摘取 user/assistant 的 text，不复制 files、provider diagnostic、隐藏推理或工具原文。截断必须按合法 UTF-8／字符串边界，记录 truncated。完整草稿不可截断；完整 prompt 超过 512 KiB 直接拒绝，不截掉规则或 schema。该限制按字节，不宣称等价 token 预算。

上下文不会插入“后台自动生成的摘要”；如果未来改为模型摘要，另开 feature 明确费用、失败与版本语义。

### 23.4 异常宿主退出与后端文件

正常关闭必须清理全部子进程。对于宿主 SIGKILL、断电等情况，不宣称一定能杀死脱离的子进程；启动恢复不读取旧 PID 后直接 kill，避免 PID 复用误伤其他程序。

旧轮次已发送但未 settled 时，对话 needs_rebuild，不重新打开相同 Pi 文件执行或复用同一 Codex thread。用户重建创建新后端上下文与新目录，旧会话文件留作诊断，不纳入可自动续聊集合。原生后端无工具，因此残留执行不会被授予业务脚本权限，但仍需提示用户检查 CLI 进程和可能用量。

Pi 会话文件由 Pi 管理格式，Orchard 不直接改写 JSONL 内容。工作目录与 session 目录使用 0700、内部元数据文件使用 0600。Codex thread 位于本机 CODEX_HOME 管理范围；宿主只保存 ID，不复制用户认证或自行编辑 rollout 文件。

## 24. 实施任务与测试矩阵

任务按以下顺序交付，每阶段可独立检查；不以文档描述代替已执行验证。

| 阶段 | 交付物 | 必须通过 |
| --- | --- | --- |
| A 契约固定 | session 类型、最小协议类型、CLI 版本矩阵、假协议进程 | 无模型握手；固定样例能被解析；安全能力门槛明确 |
| B 传输 | JSONL、pending map、调度器、连接管理 | 拆包／背压／退出／超时／配额与关闭测试 |
| C Provider | Codex、Pi 原生单次与内存多轮 | mock 三轮、取消、结果错误；legacy 回归 |
| D 持久化 | 审核后的迁移、Store API、恢复与删除 | 新库／v1／v2 升级、回滚、外键与跨草稿隔离 |
| E 创作与 API | 上下文、受理事务、轮换、恢复、SSE | 幂等、冲突、崩溃窗口、终态唯一与文件 CAS |
| F UI 与验收 | 模式／新对话／重建／历史、文档更新 | UI 行为、真实双后端专项验收 |

建议新增以下测试文件，沿用 node:test 和现有 helpers，不引入测试框架：

| 文件 | 最少场景 |
| --- | --- |
| `tests/agent-transport.test.ts` | 单 JSON 跨多字节拆包、一次多个记录、CRLF、U+2028/U+2029、空行、残缺 EOF、非法 JSON、写背压、pending 关闭 reject |
| `tests/agent-sessions.test.ts` | max=1 无死锁、FIFO、回收 idle 释放槽、queued 取消、资源上限、独立句柄、旧代次事件拒收 |
| `tests/codex-app-server.test.ts` | 握手顺序、先通知后 response、item 完整文本覆盖、turn failed/interrupted、未知请求、工具拒绝、usage 范围 |
| `tests/pi-rpc.test.ts` | prompt accepted 不是完成、临时 agent_end 后继续重试、settled、handled/queued 异常、clear_queue→abort、session 文件恢复 |
| `tests/conversations.test.ts` | single 不带历史、native 不重复历史、legacy 摘录、轮换指纹、重建和 reset 区别 |
| 扩展 `tests/store.test.ts` | 新库与升级等价、旧行 NULL 关联、唯一 active 约束、带列名插入、删除自引用、恢复状态 |
| 扩展 `tests/authoring.test.ts` | queued 阻止编辑、取消与提交竞态、非法补丁不应用、流程诊断失败可保存、拒绝重复文件 |
| 扩展 `tests/api.test.ts` / `events.test.ts` | 202/409、请求重放、错草稿引用、SSE 重连、唯一终态及先 provider.completed 后 turn.succeeded |
| 扩展 `tests/interface.test.ts` | queued/cancelling 锁定、重建入口、历史只读、模式切换不丢失未保存文件 |
| 扩展 `tests/deletion.test.ts` | 有 queued/cancel_requested 不可删除，归档会话删除顺序正确 |

故障注入必须覆盖四个窗口：受理事务后未登记 job、写 prompt 前、后端接受后未落 accepted、后端完成后未提交草稿。每个窗口都断言“不自动第二次调用模型”和“不重复应用文件”。

协议 fixture 放 `tests/fixtures/`，用 Node 子进程可控发送，记录收到的命令用于断言，不只 mock 函数返回值。无需真实账号的测试不得联网或读取用户认证。

常规完成检查为 `pnpm typecheck`、`pnpm test`、`pnpm build`。先运行新模块定向测试，再完整检查一次；记录结果，不修复本 feature 之外问题。

真实验收使用明确选择的账号和模型，记录 CLI 版本、transport、场景、结果、是否收费调用。不能把模拟 HTTP 网关验证写成真实模型成功。

## 25. 完成条件与审核边界

本 feature 实现完成必须同时满足：

1. 两种 Provider 的原生多轮、独立单次及显式 legacy 模式可用。
2. UI 状态、HTTP 状态、DB 状态一致，取消确认前不允许新轮次。
3. 原生会话可在空闲后和正常重启后恢复；不确定执行明确中断，不自动重发。
4. 无工具边界及本机认证／Magpie 兼容有对应验证记录。
5. 数据迁移按审核后的精确方案执行，旧消息、文件、运行记录保留。
6. 文档更新 `docs/wiki/architecture/providers.md`、`docs/wiki/product/authoring.md`、`docs/wiki/architecture/api.md`、`docs/wiki/operations/verification.md`，清楚区分已测能力与未测范围。

当前交付仅更新本设计。后续实施可先进行无需 schema 变更的协议与传输工作；进入第 20 节表结构实施前，应确认该精确提案已获审核。若评审调整字段或约束，先同步本文件，避免实现与批准方案分叉。
