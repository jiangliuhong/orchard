# 业务写入口与事实源审计

状态：静态审计及首批生产事务接线完成，以下仍是完整业务语义验收清单，**不是维护 Runtime 已交付的报告**。范围是会改变维护投影、其授权/依赖，或绕过数据库事实源的生产路径；纯运行日志、测试输出和用户界面偏好不作为项目配置导出。

## 1. 当前事实源

| 资产/记录 | 当前权威位置 | v1 决策 |
|---|---|---|
| 工作流身份、草稿 revision、发布指针 | SQLite workflows/drafts/workflow_versions；源码位于 FileStore 内容寻址树 | 继续复用；补草稿稳定身份绑定，业务事务同时 markDirty |
| 脚本身份、草稿/发布指针和 revision | SQLite scripts/script_versions；源码/元数据快照位于不可变产物 | 继续复用，CAS 同时核对 draftVersionId、revision、发布基线 |
| 浏览器应用/环境/工具定义、enabledTools | 完整迁入 8 表后，生产工厂选 bridge_configuration；无新表的旧安装仍读 JSON | DB 模式不双写/回退；部分新表阻断启动，不能读旧文件兜底 |
| 浏览器运行连接/标签页/心跳 | gateway/browser runtime；部分 bound/tabAvailable 目前混入配置对象 | 与声明配置分离，不触发资源 revision 或投影更新 |
| 工作流 Agent 会话/轮次/消息 | 旧 SQLite agent_conversations/authoring_turns/authoring_messages | 不自动升级为新共享 cwd 会话；旧历史保留展示 |
| 脚本 Agent 轮次/提案 | ScriptAgentJournal 文件，业务回执在 command_receipts | 新提案走统一 DB 服务；旧提案不承接新确认 |
| 浏览器 Agent 轮次/提案 | BridgeAgentService 的 FileStore journal | 同上，不把旧 JSON 记录视为真实用户确认 |
| 内置规则/Skills | 安装包 + 旧 KnowledgeService 安装状态 | 包仍为源；改为与业务文件统一投影所有者，不能整目录重装互相覆盖 |
| 配置 Git / 恢复点 / 备份 | 配置交换、恢复输入与备份，不是运行中的并行事实源 | 转换为同一数据库命令后更新投影；workspace 不加入配置 Git 权威内容 |

## 2. 写入口替换清单

“统一变更服务”指持有维护独占边界、执行业务事务并在同一事务 markDirty 的内部服务。Agent 还需经不可变提案/真实确认；页面直接编辑沿用用户授权与表单/CAS，不为每次手工保存强制制造 Agent 提案。

| 当前入口/证据 | 当前修改范围 | 必须接入/改造的内容 |
|---|---|---|
| `src/authoring/service.ts`：create、editVersion（edit/copy/restore） | 新草稿、复制身份、历史版本编辑与恢复 | 同事务建立稳定绑定；保留多个草稿；新源码产物先准备，草稿提交与 markDirty 原子 |
| 同文件 update；`PATCH /api/drafts/:id` | 直接替换草稿文件/布局及 revision | 业务 CAS + markDirty；页面 layout 保留；Agent 只改允许的业务文件 |
| 同文件 generate；`POST /api/drafts/:id/turns` | 旧 Agent 在模型返回后直接 applyAuthoringChanges、改草稿 | 新模式替换为 submit_proposal，不可直写；旧路径未替换时不得与新模式并存写同一对象 |
| 同文件 publish；`POST /api/drafts/:id/publish` | 版本产物、workflow_versions、workflows 指针、draft published 状态 | 身份绑定核对、业务提交和 markDirty；发布独立于 Agent apply，不隐式发布 |
| 同文件 deleteDraft/deleteWorkflow；Store 对应删除函数 | 草稿、工作流、版本及关联记录 | 依赖检查、固定对象失效、待确认提案撤销/queued 请求拒绝、同事务 markDirty；不删共享目录 |
| `src/authoring/script-library.ts` create/update/copy/restore/publish | scripts/script_versions、源码和元数据、草稿/发布指针 | 复用 Store 校验，拆出可加入统一事务的内核；新/空草稿 CAS；业务提交与 markDirty |
| `POST /api/scripts/:id/archive` → Store.archiveScript；ScriptLibrary.delete | 归档/删除脚本，删除相关测试/回执 scope | 依赖与固定维护对象校验；投影剔除普通入口但保留仍被引用的固定版本；保护 maintenance 回执 |
| `src/authoring/script-agent.ts` apply；`POST /api/scripts/:id/agent/apply` | 从文件 journal 提案直接 updateScriptDraft | 新模式必须只接收已确认 proposalId；不可把旧 turn.proposal 当作新确认后的可变正文 |
| `src/persistence/store.ts` createScript/updateScriptDraft/publishScript/archiveScript/deleteWorkflow/deleteDraft | 可被 HTTP 以外代码直接调用的实际数据库写内核 | 新服务之外调用也受同一维护 gate；内部方法不能允许嵌套提前提交后再标 dirty |
| `src/web-bridge/config.ts` saveApplication/deleteApplication | JSON 应用级配置及级联工具/环境 | 改为 DB 配置事务；全局 revision CAS + markDirty；应用删除使固定对象/提案失效 |
| 同文件 saveEnvironment/deleteEnvironment | origin、enabled、本机 profile/extension 引用 | DB 声明配置；只投影公开字段；任何影响工具/应用基线的变化使旧提案冲突 |
| 同文件 saveTool/deleteTool/setToolEnabled/applyProposal | 工具定义、enabledTools；旧 hash CAS 和文件 flush | DB 事务内校验、依赖检查、revision CAS、markDirty；统一应用只调用资源内核，不再写 JSON |
| `src/web-bridge/agent.ts` apply/deleteApplication；Agent HTTP apply 路由 | 从文件 journal 执行提案、级联删除应用记录 | 统一提案服务/应用服务；原 apply(application,turnId) 不再作为新模式授权入口 |
| `src/web-bridge/gateway.ts` save*、setToolEnabled、registerProfile 内的旧绑定修正 | facade 写入；profile 注册可能把 extensionId 旧映射转为 profileId | 保留 facade 但调用同一 DB 变更服务；绑定自动修正也是配置变更，活动维护任务期间明确拒绝/延后，不能旁路直接 flush |
| `src/config-git/restore-import.ts` importDefinitions / prepareImport；`restore.ts` apply/recover | 批量 SQLite 变更，同时把浏览器 JSON 列为待安装文件 | 浏览器配置改入相同数据库事务，绑定表同步更新，批量 markDirty 一次；恢复日志需与新事实源相容，禁止旧文件恢复覆盖 DB |
| `src/config-git/snapshot.ts` exportSnapshot；restore-import captureSnapshot/rawBridge/targetFingerprint | 当前导出/恢复点/指纹直接读 web-bridge.json | 改读数据库权威快照；不因迁移后旧文件存在而导出过期配置；继续排除派生 workspace |
| `src/config-git/cli.ts`、routes/service 的 restore/recover、远程配置同步导入 | HTTP 外批量配置应用路径 | 与页面复用受控恢复服务；执行前独占、预览和确认，提交后同步投影，不能走文件覆盖旁路 |
| `src/server/bootstrap.ts`、migrations runner、备份恢复 | 初始化/迁移/恢复整份数据 | 先停 Provider 和 MCP，迁移预检、版本化事务、登记 pending，恢复后核对/重建，未就绪不开放新任务 |
| `src/agent/knowledge-service.ts` initialize/recovery | 当前把整个 agent/workspace 当纯知识包切换/清理 | 移交单一投影服务；规则升级登记目标代次；旧 tree 文件数量/目录深度预算不能直接复用业务项目 |

对应 HTTP 路由集中于 `src/server/app.ts` 的 `/api/drafts`、`/api/workflows`、`/api/scripts` 和 `/api/web-bridge/applications`，不是只替换新的 MCP 入口即可。

## 3. 关联但不导出的写入

- provider/model config、字典定义/版本、密钥变更、外部项目映射会影响授权、可用性、依赖校验或敏感值集合。它们本身不自动作为维护文件导出；变更时须失效相关 grant/基线、重新核对投影安全性，不能让旧授权继续读取新敏感内容。
- tests/runs/日志/浏览器业务调用不写入维护投影，也不能因为共享 workspace 而获得读取/运行权限。测试/运行队列与配置恢复已有 activity 协调，接线时须避免将 maintenance 任务全局 gate 错套到无关 single 分析。
- 历史源码产物清理须保留当前投影引用的固定版本；文件缺失不是用户批准删除数据库资源。
- 删除会话、清理展示历史不删除已应用回执/未处理 queued 请求。原生历史删除与平台审计保留按不同所有者执行。

## 4. 统一事务接线规则

1. 单一维护 gate 排斥活动文件读取与所有配置写入；页面忙时拒绝并保留输入。不能只依赖收集器短时 ConfigWriteCoordinator.withRead。
2. 校验/准备产物可在事务外，但基线、依赖、确认、CAS、业务更新、markDirty 和成功回执必须在同一 SQLite 事务中复核/提交。
3. 提案/用户决定/queued 请求的登记不改变业务文件，可在轮次期间执行；apply worker 等完整进程关闭后执行，不能工具内自等待。
4. 批量恢复将所有受影响资产当作一批提交，投影目标代次只需推进一次；无法读懂/转换的新旧格式应拒绝，不能只安装部分文件后开放。
5. 任何仍绕过该内核的旧页面/CLI/Agent 路径都必须切断或保持新模式关闭。架构不能宣称“所有入口已统一”而只给 MCP 加锁。

## 5. 已接线边界

- `server/app.ts` 在旧恢复、缓存构造和队列激活之前识别完整 8 表并安装 `workspace-business-hooks.ts`；持久化任务仍活动或停止未确认时拒绝启动，不清空状态冒充停止证明。
- Store 外层事务比较已登记资源/权限元数据（不比较日志/运行记录），提交前共同检查配置 reader/admission、维护任务和数据目录租约；普通 `Store.exec` 自动加入该边界。新草稿绑定、业务提交、回执和 dirty 同事务，内层显式 dirty 不重复计数；回滚不发同步唤醒。事务外直接 `db.exec/prepare.run` 只准由独立审核、停机的迁移引擎使用。
- 生产 WebBridgeConfig 构造方统一使用 `configuredWebBridge`。Git export/capture/rawBridge/targetFingerprint/localSecrets 从 DB 读取；restore 的浏览器声明使用同一数据库事务 CAS，不生成 web-bridge.json 安装项。已有旧文件恢复日志与 DB 模式不兼容时明确阻断，不能反向导入。
- 旧三类维护 Agent 的开始/应用入口在新结构存在时明确禁用，不保留历史提案或幂等回放的写旁路；新 Runtime 尚未接线，因此维护生成尚不可用。
- 纯 profile 心跳/连接 Map 不取得配置 writer；真正 extensionId → profileId 自动绑定仍取维护 gate，忙时不修改配置和连接 Map。bound/tabAvailable 不进入 DB revision/hash。
- 固定对象失效已接 Store 提交观察器：草稿删除/发布、脚本删除/归档/固定草稿切换、浏览器应用删除在同一事务写入 `command_receipts` 的 `maintenance.owner.retired` scope（request_id=sessionId）。同 ID 重建、恢复或重新启用不自动恢复旧会话写权；不删除原生历史。旧确认/新应用被拒，已排队请求处理为 OWNER_UNAVAILABLE 冲突；成功回执和历史保持可读。会话保留期间不得清理该 scope。
- 新 `MaintenanceSessions` 存储内核强制已安装业务观察器和目录租约；single 不存原生引用，multi 只接受本 owner 验证过的准确引用；宿主 claim/started/attach/settle/reconcile 是内部 capability API，禁止注册为 HTTP/MCP。真实 Provider/进程证明/派发器仍未接线。
- queued 应用优先 gate 已接普通配置 writer、页面和 Store 提交观察器；页面直接保存/删除和 raw Store 业务命令均明确拒绝，纯元数据仍可用。apply/已提交恢复使用内部意图，不能从 HTTP/MCP 选择。纯投影同步即使嵌套于应用独占范围也不能更新业务定义。
- worker 生命周期已接提交后 work/dirty 事件与 createApp 条件装配：事务回滚不唤醒、后台剥离发出者的写权限、恢复 DB 队列、等待维护任务结束、同步失败不重放业务、关闭等待并保留队列。factory 必须来自平台可信代码；没有真实 authority 的默认入口遇到 queued 请求拒绝就绪，不猜测授权或静默忽略。
- 真实 authority/安装器/进程 registry、删除依赖、非 DB 权限变更、API/页面和实际迁移仍须继续验收。元数据观察器不是语义校验、OS 沙箱或真实进程停止证明，不能据此宣称全项目已经上线。

## 6. 后续接线验收

- 为上表每类入口建立业务提交 + target_generation 变化测试；无修改和纯运行状态变化不无故递增。
- 在维护读取期间分别调用页面写入、旧 Agent apply、profile 自动绑定和配置恢复，验证拒绝且无部分数据库/文件修改。
- 模拟 DB 提交成功、workspace 同步失败；原入口返回真实“已应用待同步”，重复请求不重新创建版本。
- 检查迁移后不存在 WebBridgeConfig.flush、rawBridge 或备份恢复继续把旧 JSON 当权威的生产路径。
- 对直接 Store 内核调用、异常、取消、重启和 bulk import 建立测试，避免只测路由 happy path。
