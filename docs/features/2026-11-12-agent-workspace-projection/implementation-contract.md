# 实施契约 v1

状态：实施基线，数据库结构设计已获用户确认，见[批准记录](./database-approval.json)与[数据库审核稿](./database-review.md)；不是已上线协议，实际迁移执行仍需独立预览确认。

本文落实主设计第 12 节确认项，并明确调整原布局与应用时机。当前编译器/收集器尚未实现以下全部约定，不能直接据此启用生产。

## 1. 稳定身份与草稿

### 1.1 工作流

- `resourceId` 取平台创建时确定的 `workflow.json.id`，发布前后不变；`draftId` 仅标识编辑分支，不能当作工作流资源 ID。
- 新建/复制由平台分配 resourceId。Agent、文件补丁、导入不得修改已绑定的身份；复制必须分配新 resourceId。
- 通过受审的 `agent_workspace_workflow_bindings` 持久绑定 `(draftId, resourceId)`。新建、复制、编辑历史版本、导入均在草稿落库的同一事务建立绑定。
- 旧数据回填顺序：已绑定 `draft.workflow_id` 与文件声明必须一致；未绑定时使用可验证的文件声明。已发布草稿同时核对 `published_version_id` 所属工作流。缺失、非法或不一致时列入迁移阻断清单，不猜测、不改源码、不默认为 draft ID。
- 首次发布创建同 ID 的 workflows 行，不重分配 ID；已确认提案固定 draftId。该草稿发布、删除或不可编辑后，旧提案失效，不自动应用到其他草稿。

### 1.2 多草稿及发现

工作流允许同时保留多个草稿，不引入“最近一个就是当前草稿”的推断。调整工作流布局为：

```text
workflows/<resource-id>/
├── resource.json                     # 资源身份、草稿清单、当前发布版本
├── drafts/<draft-id>/
│   ├── resource.json                 # resourceId、draftId、revision、状态
│   ├── workflow.json
│   └── scripts/...
└── published/                        # 仅当前生效版本
    ├── resource.json
    ├── workflow.json
    └── scripts/...
```

- 原设计的单个 `draft/` 改为 `drafts/<draftId>/`，所有可编辑草稿均呈现；旧 published draft 记录不再作为可编辑草稿重复导出。
- 页面选中的 draftId 是维护会话固定对象的一部分。读到其他草稿不授予其写权限。
- 根 `project.json` 作为派生索引，列出资源身份、状态、版本/revision、相对路径和依赖读取状态。不包含会话、确认、同步回执或凭据，也不在其中自嵌整个投影 hash。
- 不完整草稿仍输出原始文本及 `valid:false` / `dependenciesComplete:false` 元数据；不伪造可解析定义。不可解析的当前发布版本、缺失产物、敏感内容或预算超限仍阻断整个投影。
- 不完整草稿不等于文件未同步：文件就绪与业务有效性分开呈现。删除依赖检查遇到不可解析草稿必须拒绝，不能假设没有引用。

### 1.3 脚本和浏览器应用

- 脚本使用 scripts.id；只有一个当前草稿，固定维护对象包含 `draftVersionId`（允许明确为 null，表示在已发布脚本上新建草稿）。
- 浏览器应用使用 applicationId，工具身份为 `(applicationId, toolId)`。维护对象固定为应用；首版不允许 Agent 修改应用本身或环境绑定。
- ID 必须是安全路径段；路径大小写别名、文件/目录冲突仍拒绝，不静默编码成另一个身份。

## 2. 固定版本依赖

```text
scripts/<script-id>/
├── draft/...
├── published/...
└── versions/<version-id>/             # 仅被引用、且非当前发布版的不可变历史版本
    ├── resource.json
    ├── script.json
    └── src/...
```

- 以所有投影工作流草稿/当前发布版本的结构化引用为根，按 `(kind, resourceId, versionId)` 去重遍历。当前 published 已包含所需版本时索引指向该目录，不重复复制。
- 工作流脚本库引用必须有准确 `scriptVersionId`，并属于该脚本的已发布版本；不能以草稿或同名当前版替代。归档脚本若仍被引用，其准确版本以只读依赖导出，但不伪装成可编辑资源。
- 第一版脚本契约没有跨脚本库引用，源码相对 import 仅在本版本源码树解析；不扫描注释/文本猜测资源引用。未来新增资源引用类型必须显式增加依赖解析器，不默认忽略。
- 索引提供每条依赖的目标版本、路径和只读范围。历史依赖目录禁止作为提案目标。
- 浏览器工具引用是当前配置（`versionPolicy: live`），记录当前 revision，不虚构历史发布版本。字典/模型/外部项目仅保留业务定义中的引用身份，不导出值、凭据、源码快照或宿主路径。
- 限制：最多 2,000 个资源快照（含历史依赖）、10,000 个文件；单文件 1 MiB；最终输出及累计序列化输入分别最多 32 MiB；单资源沿用现有最多 100 个源码文件、4 MiB 源码预算。遍历上限 8 层，使用 visited/visiting 检测循环。
- 缺失、归属不符、无权限、循环或超限明确失败，不截断依赖清单。不可解析草稿的未知依赖单独标记，不宣称完整。

## 3. 资源级不可变提案

### 3.1 公共信封

```ts
// 示意类型；后续须以严格 JSON Schema 实现，禁止额外字段。
type ProposalInput = {
  contractVersion: "orchard.maintenance.v1";
  requestId: string;
  summary: string;
  target: WorkflowDraftTarget | ScriptDraftTarget | BrowserApplicationTarget;
  baseline: WorkflowBaseline | ScriptBaseline | BrowserBaseline;
  change: WorkflowReplace | ScriptReplace | BrowserToolBatch;
};
```

- requestId：1–200 字符；summary：最多 4,000 字符；序列化输入最多 8 MiB，源码单资源沿用 4 MiB/100 文件限制。JSON 转义膨胀也计入预算，不因原始源码未超限而豁免。
- 一份提案只有一个固定维护目标；不允许跨工作流、跨脚本或跨应用原子变更。一个浏览器应用内最多 20 个工具变更，同一工具最多一次，整批事务提交。
- 宿主取得固定目标的安全 before 快照、生成 after 与 diff，并保存 before/after/基线、内容 hash、diff hash、主体及来源。模型不能提供 before 作为权威事实。
- hash 使用现有 canonicalJson + SHA-256，覆盖 contractVersion、主体、固定目标、基线、before 和 after；展示摘要也固化。确认绑定 proposalId、内容 hash、diff hash，而非任意一句自然语言。
- 提案有效期 7 天；确认有效期最多 24 小时且不超过提案有效期。过期、撤销、冲突或原对象失效须重新生成提案，不能在旧确认下换正文。
- 单主体最多 20 份未终结提案、256 MiB 未清理提案数据；达到上限明确拒绝，不自动删掉未确认内容。

### 3.2 目标、基线与字段白名单

| 目标 | 基线（事务内再次检查） | 允许变更 |
|---|---|---|
| workflow_draft：resourceId + draftId | draftId + revision + 当前 artifact 内容 hash；绑定关系和可编辑状态 | 完整替换该草稿业务文件集：workflow.json 和内嵌 scripts；工作流 id 固定，layout 不由 Agent 改写 |
| script_draft：scriptId + draftVersionId/null | 当前 draftVersionId/null、revision（无草稿为 0）、当前 publishedVersionId 和基线内容 hash | 完整 ScriptDefinition；id/runtime 固定；name、description、entryFile、inputSchema、outputSchema、timeoutMs、resultMode、dictionaryBindings 和 files 按现有验证器校验 |
| browser_application：applicationId | 数据库配置全局 revision + 应用配置 hash | 工具 create/update/delete；工具完整定义按现有 WebBridgeTool/prepareBridgeProposal 验证器白名单，application/toolId 固定 |

- 工作流完整文件集是资源相对逻辑文件名，不是宿主文件补丁；保留页面 layout。脚本完整文件集里的缺失文件是该次明确替换的一部分，diff 必须显示删除，不根据 workspace 磁盘缺失推断删除。
- 浏览器工具定义可包括现有参数/schema、path/method、fields、risk、approval、timeoutMs、catalogVersion、enabled、execution 等受验证字段；不允许写入 profile、Cookie、凭据值、环境或宿主路径。敏感声明/引用需结构化筛选，不将现有正则扫描当成最终白名单。
- 第一次新建脚本草稿时必须 CAS 当前草稿仍为 null 且发布基线未变；不能只检查 revision=0。
- 提交基线须与宿主当前任务租约保存的固定目标基线匹配，并与数据库核对。原生读文件本身不构成授权；磁盘 resource.json 和模型回传 revision 都不是事实源。
- Agent 首版不创建/删除整个工作流、草稿、脚本或浏览器应用，不归档、发布、恢复历史版本或执行业务。浏览器工具删除须展示后果；扫描保留的草稿和工作流版本引用，不能证明无依赖时拒绝。
- 新的候选业务定义必须通过 schema、源码及依赖校验；平台不执行候选脚本来“验证”。页面手工保存不完整草稿沿用原边界，不因此放宽 Agent 应用契约。

## 4. MCP、授权与应用返回值

- 第一版选择 **MCP stdio**，不同时实现通用 shell CLI。由平台随包安装的可信 Pi 桥接扩展显式注册唯一 Orchard MCP server；扩展和 MCP server 可执行文件来自安装包，不从 workspace 发现或下载安装。
- MCP server 提供 `submit_proposal`、`apply_proposal`、`proposal_status`。它们与页面入口调用同一个提案/应用服务，不能另写业务 SQL。未知工具和额外字段拒绝。
- 平台为每个运行任务签发随机不透明 grant，绑定 actor、conversation、turn/operation、provider generation、固定目标、允许动作、projection generation、租约和期限。最长 30 分钟，到期停止工具调用，长任务必须由宿主显式续租。
- grant 仅经受控子进程环境传给 MCP bridge，再经平台本地受控 IPC 校验。共享文件、消息、CLI 参数、日志和原生历史不得包含 grant；模型工具参数中也无 grant 字段。受控环境不继承宿主的全套凭据/扩展配置。
- MCP 初始化不是用户确认。confirm/revoke 只存在于经现有页面身份/Origin/请求校验的用户 API，不出现在 Agent 工具清单。
- grant 在取消、回收、代次变化、主体失效、超时和进程断连时撤销。只凭本机运行身份或 proposalId 不能查询/应用他人提案。
- `apply_proposal(proposalId, requestId)` **先登记已确认提案的应用请求**。有活动维护进程时只返回 `queued`，不等待业务写锁，不声称应用成功；空闲时可直接完成并返回回执。
- apply 请求的幂等范围为 `(actor, action=apply, requestId)`，相同 ID 不同 proposal/hash 返回冲突。每份提案最多成功应用一次；不同 requestId 也不能重复变更。
- 结果区分 `queued`、`applied`、`applied_projection_pending`、`conflicted`、`rejected`；`proposal_status` 和页面可查询。文件失败不能返回“业务未应用”。

## 5. 生命周期、用户确认与安全边界

1. 一次只准入一个共享维护任务；页面业务写入遇到活动任务返回 `WORKSPACE_BUSY` 并保留编辑，不静默排队无限等待。提案/确认/应用请求的登记不改业务配置或 workspace，可在任务期间进行。
2. 首版 **每个逻辑轮次结束均关闭 Provider 进程**，保留准确原生历史引用。Pi 等待 agent_settled，再关闭 stdin，确认进程及受管子进程退出、工具调用结束、grant 撤销后才释放读取边界。仅 abort ACK/agent_end/kill 发送成功都不够。
3. 未确认的提案只展示；页面确认后登记应用请求。若当前任务仍在运行，显示 queued，当前轮次仍读取旧的完整投影；不在模型工具调用里等待自己的轮次读锁。
4. 空闲或原生进程已回收时，平台直接消费已确认请求并应用，不启动模型。single 同样如此；multi 用户无需让 Agent 再说一次“同意应用”。
5. 应用 worker 在独占边界下重新检查用户确认、权限、固定目标、有效期和 revision；同一事务更新业务、成功回执、提案状态并递增目标投影 generation，之后同步文件。完成挂起应用/投影修复后才准入下一任务或页面写入。
6. 模型任务被取消只撤销其工具访问；已经真实确认并登记的应用请求仍可在安全边界执行。用户可在业务提交前通过页面撤销，worker 在事务内再次校验。进程退出不确定则保持阻断，不强行假设安全。
7. 当前轮次后的真实结果由平台 UI 展示；后续人工消息可继续准确原生 session，并查询 proposal_status。禁止把“已应用”伪造成先前工具成功、重放模型历史或隐式启动收费轮次。

### 文件与工具边界

- Pi 1.5.2 原生 read 实测可越过 cwd，见[CLI 验证](./cli-verification.md)。因此不允许直接使用 `--tools read,grep,find,ls` 作为生产隔离方案。
- 生产必须只加载安装包显式指定的可信桥接扩展：范围受限的 read/grep/find/ls 包装器使用 Pi 工具实现/受控只读操作，拒绝 workspace 外路径、绝对外部路径、链接、硬链接、非常规文件和未登记文件。任何最终文件读取/遍历操作都必须经过边界，不能只做字符串前缀检查。更新和读取不得交叉。
- 禁用原生 bash/edit/write、powershell、codemode、tool_search、第三方 MCP、工具动态扩展、自动扩展/包/祖先规则加载。可信扩展只显式加载包内规则及已校验 Skills；无必要的 @file、系统提示文件、技能引用或媒体读取不能成为旁路。
- 配置目录、session 目录、数据库、secrets、runs、project-git、环境凭据及受控 IPC 均不向文件工具暴露。RPC 控制连接只对平台开放，不能透传 Agent 提供的 RPC 命令。
- 上述包装器、MCP 同时启用、规则加载、链接负例和完整工具调用尚未实测通过；通过前 Pi 维护新模式保持关闭。Codex 首版也保持关闭，不能以其 readOnly sandbox 字段或 runtimeWorkspaceRoots 证明读取隔离；若需 shell 才能读文件，不为达成功能而开放任意 shell。
- 版本变化重新验证。没有通过的 Provider 明确报能力不可用，不降级成历史重放或无约束工具。

## 6. 浏览器配置事实源与数据库提交

选择将浏览器声明配置迁入受审的 `bridge_configuration` 单例数据库记录，先迁移事实源，再启用统一应用：

- 包含 applications/environments/tools/enabledTools 等声明配置，保留本机 profile/extension 引用，但不向 workspace 投影；运行 bound/tabAvailable、心跳和连接状态不持久化为配置。
- 通过一个 SQLite 配置 revision 提供保守 CAS；其他应用的配置改动也会使旧浏览器提案冲突。不要使用可随连接变化的旧 authoringSnapshot hash 作为唯一 revision。
- WebBridgeConfig 成为数据库适配 facade，所有保存/启用/删除/绑定/Agent 应用都调用统一变更服务。内存状态与 DB 提交后刷新，不再写权威 config/web-bridge.json。
- 旧 JSON 只作为独立备份/迁移输入。数据库已迁入后禁止双向同步或读取 JSON 自动回退；配置 Git 导入、导出、恢复和备份均改读写数据库快照。
- 迁移失败不开放业务；SQLite 事务提交后只剩 workspace 这一派生文件同步边界，不把旧文件写入包装成原子事务。

## 7. 审核与交付门槛

- 数据库、旧数据导入和目录迁移分别有审核/确认。本文及“先完成第一项”不等于批准数据库结构或重置操作。
- 首项可交付：本契约、写入口审计、CLI 协议/负例证据、数据库审核材料。数据库结构审核已完成；生产迁移执行确认与后续真实模型工具链安全验收仍为独立门槛，不能把材料/独立 SQL 完成标成生产能力完成。
