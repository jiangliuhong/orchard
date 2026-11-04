# Design

2026-11-04 根目录切换补充：用户已确认新工作台验证通过，并授权替换仓库根项目、commit / push。下文 workbench/ 路径保留为初始实施阶段的设计记录；最终实现使用根目录对应路径，数据库结构、端口及 ~/.orchard-workbench 数据目录不变。切换记录见 tasks 第 10 组与 docs/verification.md。

## Context

动机及用户确认见 `proposal.md`。本设计覆盖新的独立应用，既有源码仅作参考，不作为运行依赖。

已检查的现状：

- `src/core/contracts.ts` 用 `run()` 函数定义流程，`src/authoring/source-descriptions.ts` 扫描步骤，缺少显式拓扑。
- `src/integrations/pi/cli-client.ts` 已有两类 CLI 的一次性执行，历史通过宿主拼接，不等于原生会话管理。
- `src/runtime/workflow-execution.ts` 采用成功步骤缓存及重入；新项目不沿用这套恢复模型。
- `src/web/App.tsx` 的运行详情以事件列表为主；新项目从版本流程和节点状态构建视图。
- 根目录已有大量未提交改动，`pnpm-workspace.yaml` 未配置 packages；新项目不可改写这些工作来完成隔离。
- 仓库规则要求数据库结构先审核；此文档属于待审材料，不包含可执行 DDL。

## Goals / Non-Goals

**Goals**

- 流程定义、执行计划、页面节点始终使用稳定 ID 对应。
- Provider 与执行引擎隔离，业务层使用字符串 Provider ID，不依赖固定的二选一枚举。
- 先实现可理解的串行和条件路径，控制重启、取消与副作用语义。
- UI 组件、接口契约、业务模块分层，独立测试核心行为。

**Non-Goals**

- 不继承旧 SDK、API、迁移、历史数据或 Inngest 兼容目标。
- 不把 React Flow 数据结构当作领域协议，不从脚本反推控制流。
- 第一版不提供自动重试、崩溃续跑和并行执行，不保证外部操作 exactly-once。
- 可信本地脚本按当前用户权限运行；独立进程用于执行控制，不宣称提供操作系统级隔离沙箱。

## Decisions

### D1. 单一独立包与模块化后端

拟采用以下结构，不拆多服务或多个内部发布包：

```text
workbench/
  package.json
  pnpm-lock.yaml
  src/
    domain/          # JSON contracts, validation, state transitions
    providers/       # registry, adapters, normalized events
    authoring/       # conversations, revisions, candidate changes
    runtime/         # graph runner, node executors, processes
    persistence/     # repositories, transactions, schema after approval
    server/          # HTTP, SSE, local startup
    web/
      components/ui/
      features/
  tests/
  docs/
```

使用 Node.js 24+、TypeScript、Fastify 和 SQLite；实际依赖版本在实现时核对官方文档并锁定。新目录具有独立安装与构建入口，不加入旧 workspace 的依赖图；实施时验证 pnpm 的独立安装方式，不修改根包或根锁文件。

默认地址拟为 `127.0.0.1:7441`，开发前端使用单独端口代理本地 API。默认数据目录拟为 `~/.orchard-workbench`，显式拒绝指向旧默认数据目录。首期进程组管理目标为当前 macOS/Linux 环境；不支持的平台清晰报错。

备选：原地替换、完整 monorepo 或多服务。选择独立单包是为了隔离旧改动并减少第一版部署和依赖维护成本。

### D2. UI 采用用户已确认的组合

- React + TypeScript + Vite：构建浏览器单页应用，由本地服务提供构建资源。
- shadcn/ui + Tailwind CSS：只加入实际使用的组件，统一设计变量、表单、弹窗、状态提示和布局，不混用 Ant Design。
- React Flow：流程投影、节点选择、缩放、平移和运行状态叠加；首版关闭编辑连线等编排行为。
- Monaco：代码区按需加载，不阻塞列表、设置和运行状态展示。
- 先使用 React 的局部状态与领域事件归约，避免提前引入额外全局状态框架。

应用导航：工作流、运行记录、设置。创作入口进入三栏工作区：对话、流程、节点详情；窄屏改为可切换面板。运行详情复用流程画布，但数据固定到该运行引用的版本。状态同时用文本与视觉标识表达，不能只依赖颜色。

备选：Ant Design、Next.js、首版拖拽设计器。前者更偏标准管理页，后两者对本地工作台首版引入的复杂度暂不必要。

### D3. Provider 按能力注册而非按名称分支

Provider 描述包括 `id`、显示名称、配置 Schema、能力声明及适配器版本。配置实例保存 `enabled`、本地连接参数、配置修订号、默认模型和补充模型目录；首版各内建 Provider 一个配置实例，未来可扩展实例而不改变图节点的引用规则。

内部契约覆盖以下操作：

- `detect`：检查本地连接，返回 ready、unavailable 或 unknown 及原因；不以执行付费模型调用作为默认检测。
- `listModels`：返回稳定模型 ID、名称、目录来源与警告，允许用户补充模型 ID；目录不是模型实际可调用的保证。
- `startTurn`：接收明确模型、消息、输出约束、工作目录、能力需求和取消信号，产生真实事件及最终结果。
- `cancel` / `close`：终止活动调用并等待资源清理。
- 可选原生恢复：仅在适配器确实支持时提供，应用对话 ID 与原生 session ID 分开保存。

标准事件区分 started、text delta、tool activity、usage、completed、failed、cancelled；能力不足时不伪造事件。结构化输出可以原生支持，也可以解析最终响应再用宿主 Schema 校验，界面准确区分。

Codex 与 Pi 的协议适配必须在实现时核对本机 CLI 版本、帮助与官方文档；优先使用验证后的结构化 CLI 模式，不预先承诺所有后端支持常驻进程或原生续聊。应用持久化完整创作历史作为最低共同能力。

创作 Agent 通过宿主提供的流程/脚本候选变更协议工作。第一版不授予创作过程任意业务脚本执行能力；生成与发布仅校验，不自动运行。

每次调用捕获配置修订及有效路径。禁用只阻止后续调用，包括已排队但尚未启动的节点；活动调用不中途热替换。替换 Provider 配置后，历史版本仍固定 Provider ID、模型与能力要求，具体本地路径可更新，其实际修订记录在尝试中；不保证环境完全可复现。

### D4. 模型选择先解析再发布

创作每轮保存 Provider 与明确模型。流程默认值仅是草稿便利功能，各 Agent 节点逐项覆盖 Provider 与模型；更换 Provider 时清除与新后端不匹配的继承模型。

发布时优先采用节点值，再采用适用的流程默认值，最后采用该 Provider 的设置默认模型。结果必须得到明确 Provider ID 和模型 ID，写入版本内的有效配置。模型目录未知时可以使用设置中补充的明确 ID，不静默使用未知 CLI 默认模型。

运行开始及节点启动前检查启用状态和能力。原模型不可用时失败，实际返回模型若与请求不同则记录并诊断，不掩盖后端的实际选择。

### D5. 显式 JSON 流程和版本内脚本

草稿目录包含 `workflow.json`、`scripts/` 下的 `.js`、`.mjs`、`.ts` 和 `.sh` 文件，以及独立的 `layout.json`。限制文件数量和大小，拒绝绝对路径、路径穿越、符号链接、重复文件操作和身份修改。

`workflow.json` 的主要字段：

| 字段 | 含义 |
| --- | --- |
| `formatVersion`, `id`, `name` | 格式版本与工作流身份 |
| `inputSchema`, `outputSchema` | JSON Schema 输入输出契约 |
| `defaults.agent` | 草稿层 Provider 与模型默认值 |
| `entryNodeId` | 唯一入口 |
| `nodes[]` | 稳定 ID、类型、配置、输入绑定、输出 Schema |
| `edges[]` | 稳定 ID、起点、终点与 Switch 分支标签 |
| `result` | 工作流最终输出绑定 |

输入绑定只支持字面量或结构化引用 `{source, nodeId?, pointer}`；pointer 使用 JSON Pointer，禁止 `eval` 和任意 JS 模板。引用只能来自工作流输入或必经前置节点；用可达性和支配关系校验，不能只检查“拓扑上排在前面”。允许可选分支汇合，但汇合后不能直接引用非必经分支的结果。

图为 DAG。普通节点至多一条出边，Switch 的 cases 匹配 JSON 标量且值不可重复，并要求默认路由；终点用明确的 end 路由或无后继表示。所有图节点必须从入口结构可达。默认路由、终点和输出绑定一并校验，避免选择路径结束后无法产出最终输出。

节点校验不导入或执行脚本。TypeScript 脚本在发布时转换为 JS 并校验语法；第一版只允许版本内相对脚本依赖与 Node 内置模块，不下载任意 npm 包。发布保存原始文件和执行产物摘要，启动节点前校验摘要。

布局属于展示数据，可以在未发布草稿中调整；发布后随版本固定，运行历史不随最新布局漂移。

### D6. 单活动路径执行器

每个 Run 预创建该版本所有节点的记录，初始 pending。首版最多同时运行一个 Run，其余排队；每个 Run 仅有一个活动节点，沿已选路径推进。内存队列只是唤醒机制，排队与终态以数据库为准。

Node.js、Agent、Shell 和 Switch 各自实现执行契约。Switch 也有输入、输出和尝试记录，其结果包含匹配值、路由、连线和理由。若 Agent 输出 reason，按数据记录，不作为引擎指令执行。

节点完成、节点输出引用、路由决策、下个节点及事件在同一事务提交。由于一次只有一条活动路径，不需要实现并行 join。结束时将剩余 pending 节点终结为 skipped，并保存 `branch_not_selected`、`upstream_failed` 或 `run_terminated`；不可在 Switch 选路时错误地跳过仍能通过选中分支到达的汇合节点。

运行状态：queued、running、cancel_requested、succeeded、failed、cancelled、interrupted。节点状态：pending、running、succeeded、failed、cancelled、skipped、interrupted。第一版一次节点执行对应一次 attempt，保留尝试实体以记录实际调用配置，不暴露自动重试或从节点续跑。

排队取消直接终结；活动取消通过事务抢占最终提交权，触发进程/Provider 清理并禁止下游。成功先提交则取消返回已结束；取消先提交则迟到输出不可成为成功。超时记录失败而非用户取消。

服务异常退出后，重启将遗留 running / cancel_requested 运行标记 interrupted，其活动节点亦中断，剩余节点跳过；queued 保持待执行并在调度前重新校验 Provider。不自动重放已中断脚本。进程组和服务退出钩子尽力清理；对于无法确认是否完成的外部副作用明确保留不确定性。

### D7. 脚本执行协议

- 脚本固定来自版本产物，不把输入拼接进命令文本。
- Node.js：单独 Node 子进程加载固定入口；输入通过 stdin JSON，结果写入每次尝试专属的 JSON 结果文件。stdout/stderr 专用于日志，避免日志混入结果。
- Shell：使用设置中受信的 Bash 绝对路径显式执行版本脚本；输入通过 stdin JSON，输出固定为 `{stdout, stderr, exitCode}`。声明结构化业务结果时通过尝试专属结果文件写 JSON，保留进程结果元数据。
- 每次运行创建独立工作目录；JSON 结果文件位置由宿主设置，子进程结束后读取、限制大小并校验输出 Schema。退出非零时不得因为存在结果文件而判成功。
- 支持节点超时、日志与输出上限、取消信号、SIGTERM 后 SIGKILL；等待进程清理完成再提交取消终态。
- 默认不自动重试，即使脚本声称幂等。用户重新运行会创建新 Run，并可能重复外部副作用。

### D8. 创作与版本提交协议

每个草稿保持修订号、基线版本、消息与轮次记录。生成开始捕获修订号和能力目录，Provider 返回 summary 及文件 changes；宿主在 staging 中校验路径及整体文件树，原子保存新修订与诊断。图无效的候选可保存为不可发布草稿；越界操作整轮拒绝。取消、重复请求和旧修订结果不能覆盖新修订。

保存等于显式发布，不隐式运行。发布先在不可变产物目录完成复制、转换和摘要，再以事务校验修订号、基线与 Provider 有效配置，创建版本、激活版本并记录请求幂等结果。数据库提交前失败只产生可清理的孤立文件，不产生可运行的半版本。

编辑已发布工作流从版本复制，不原地修改版本文件。服务重启保留最后提交草稿，将活动轮次标记 interrupted；未发布草稿不得作为运行入口。

### D9. API 与事件投影

API 以领域 DTO 返回数据，不向浏览器导出仓储类或后端实现类型：

| 范围 | 端点草案 |
| --- | --- |
| Provider | `GET /api/providers`、`PATCH /api/providers/:id`、`POST .../detect`、`POST .../models/refresh` |
| 草稿 | `POST /api/drafts`、`GET /api/drafts/:id`、`POST .../turns`、`POST .../turns/:turnId/cancel`、`POST .../publish` |
| 工作流 | `GET /api/workflows`、`GET /api/workflows/:id`、`GET .../versions/:versionId`、`POST .../runs` |
| 运行 | `GET /api/runs`、`GET /api/runs/:id`、`POST .../cancel`、`GET .../events?after=sequence`、`GET .../stream?after=sequence` |

草稿创建/轮次、发布和运行创建使用持久化请求幂等键，同键不同请求报冲突。Run 详情返回版本、节点结果和 `lastSequence`，事件保存 per-run 单调 sequence。SSE 先补读再订阅，客户端按 sequence 去重，快照与游标来自一致读；慢客户端从持久化游标重连，不以无限内存缓存保留日志。

事件发布必须在事务提交后，保证 SSE 与数据库终态一致。日志限流/分块持久化，超限明确标记；大输入输出写入带大小和摘要的本地产物，API 返回引用，读取限制在应用数据根目录内。

创作轮次使用相同的持久化事件机制但不同 stream 身份。绑定 Host/Origin、请求体限制与本地文件访问边界；浏览器构建产物中不包含本地凭据。

### D10. 数据库审核方案：approved

**提交日期：2026-11-04。批准日期：2026-11-04。状态：用户已批准。** 在提交本节十二表、约束、事务与回滚方案并询问是否批准及实施后，用户回复“可以，开始实施”。批准范围为本项目初始结构；无修订意见，方案保持一致；以后结构调整另行审核。

SQLite 单库，ID 使用 UUID，时间使用 UTC 毫秒，JSON 列进行 Schema 校验；启用外键，索引覆盖列表、状态恢复和事件游标。候选关系如下：

| 表 | 主要字段 | 关系与约束 |
| --- | --- | --- |
| `provider_settings` | id、enabled、config_json、models_json、default_model、revision、updated_at | id 为注册 Provider ID；配置变更 revision 单调递增；不保存 CLI 登录凭据 |
| `workflows` | id、name、current_version_id、created_at、updated_at | current_version 必须属于本工作流；新工作流在首次发布事务中创建 |
| `workflow_versions` | id、workflow_id、version_no、definition_json、layout_json、artifact_path、content_hash、created_at | FK workflow；unique(workflow_id, version_no)；发布后只读，定义含有效模型配置 |
| `drafts` | id、workflow_id nullable、base_version_id nullable、revision、artifact_path、validation_json、published_version_id nullable、status、created_at、updated_at | 新草稿无 workflow FK；定义内身份预分配；修改草稿检查基线所属工作流 |
| `authoring_turns` | id、draft_id、provider_id、model_id、provider_revision、native_session_id nullable、status、base_revision、error_json、created_at、ended_at | FK draft；单草稿至多一个活动轮次；记录请求配置与原生会话标识 |
| `authoring_messages` | id、draft_id、turn_id nullable、sequence、role、content_json、created_at | FK draft/turn；unique(draft_id, sequence)；消息按应用对话保存 |
| `runs` | id、workflow_version_id、status、input_ref、output_ref nullable、active_node_id nullable、cancel_requested_at nullable、error_json、created_at、started_at、ended_at | FK 不可变版本；状态与活动节点更新必须有事务条件 |
| `node_runs` | id、run_id、node_id、type、status、input_ref、output_ref、route_json、skip_reason、error_json、started_at、ended_at | FK run；unique(run_id, node_id)；节点必须属于运行版本 |
| `node_attempts` | id、node_run_id、attempt_no、status、execution_json、input_ref、output_ref、error_json、started_at、ended_at | FK node_run；unique(node_run_id, attempt_no)；实际模型、CLI 路径修订及进程元数据入 execution_json |
| `stream_events` | stream_type、stream_id、sequence、event_type、node_id nullable、attempt_id nullable、payload_ref、created_at | composite PK(stream_type, stream_id, sequence)；stream 只允许 run 或 authoring_turn，由仓储校验归属 |
| `artifacts` | id、relative_path、sha256、byte_size、media_type、created_at | unique(relative_path)；输入/输出引用指向不可变产物；路径限制在新数据目录 |
| `command_receipts` | scope、request_id、request_hash、result_json、created_at | composite PK(scope, request_id)；与资源创建同一事务提交，防重复发布和重复运行 |

`*_ref` 使用统一的内联 JSON / artifact 引用格式，仓储验证引用存在且摘要一致；不把日志输出存为任意可执行文件路径。事件 stream 的多态关系由事务和仓储验证，不伪造不存在的跨表外键。

审核需要覆盖：

1. 上述十二张表的职责、外键/应用约束、唯一键和不可变数据边界。
2. 初始建库只允许新数据目录；拒绝旧库或未知 schema，不自动“升级”旧库。
3. 事务边界：草稿提交、发布、Run 创建、节点完成/选路、取消竞争、命令幂等与事件。
4. 服务重启修复只调整遗留运行/轮次状态，不重写历史输出，不自动重做副作用。
5. 后续升级先备份；回滚停止服务并恢复匹配数据快照和应用版本，不能仅修改 schema version。

实施审核前可完成项目骨架、领域校验、Provider 接口、UI 和显式测试内存仓储；正式应用必须明确报告持久化未启用，不得以临时内存实现冒充完成的存储功能。审核通过后才添加持久化建表、仓储和相应数据库集成测试。

### D11. 分阶段验证与范围控制

功能实现阶段：类型检查、构建、图验证、分支/绑定/取消状态测试、模拟子进程协议和临时数据目录中的接口集成测试。数据库测试仅在初始结构审核通过后编写和运行。

后续真实验收：使用本机真实 Codex/Pi 完成多轮创建、发布、两次运行、不同分支、取消和刷新恢复；浏览器检查三栏与窄屏，逐节点核对实际输出。验收放在单独的后续变更中，不是本变更的完成门槛，也不提前打勾。

备选：先做全部真实验收再交付功能。用户已明确先实现后专门验证，故保留基础测试但延后此阶段。

## Risks / Trade-offs

- [CLI 协议随版本变化] → 适配器集中处理、记录本机版本、明确能力、保留协议样例与失败诊断；真实连接可信度留待独立验收。
- [shadcn/ui 组件进入源码后需维护] → 少量按需组件、统一设计变量、功能代码只依赖本地 UI 边界，避免散落改动。
- [脚本有本地权限及外部副作用] → 明确运行入口、固定版本、独立进程、默认不自动重试；进程控制不冒充安全沙箱。
- [单活动路径限制表达能力] → 明确拒绝并行/循环；格式版本预留升级，不以未定义语义偷偷执行。
- [Provider 环境或模型实际行为变化] → 固定所选模型并记录实际配置修订与返回信息，保持审计而不宣称结果确定。
- [SQL 与文件无法共用一个事务] → 文件先固化再提交引用，启动清理只删除确认无引用的 staging/孤立产物。
- [后续结构超出初始批准范围] → 数据库后续调整另行审核，不以本次初始批准自动覆盖；不更换为隐蔽文件数据库绕过审核。

## Migration Plan

1. 审阅本变更，单独明确初始数据库结构的批准或修改意见。
2. 在 `workbench/` 建立独立项目；旧目录只读参考，新服务不替换旧服务。
3. 实现领域、Provider、执行器、持久化（批准后）和 UI，完成功能检查。
4. 交付独立启动入口与开发验证记录；真实验收单独安排，不自动切换用户使用入口。
5. 后续由用户决定切换。失败回退只需停止新服务并继续使用旧服务；新应用升级回滚按匹配备份恢复，旧数据始终不迁移或删除。
