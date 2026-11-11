# 实施状态与生产激活边界

本文件区分代码完成、假协议测试、真实 CLI 证据与生产接入；不将独立模块或通过单测等同整个 feature 完成。

## 已完成编码

| 模块 | 文件 | 范围 |
|---|---|---|
| 必需能力与引用边界 | src/agent/provider-contract.ts | 九项 multi 门禁；ProviderSessionLifecycle、状态与结果、不透明引用严格 JSON/版本/大小校验 |
| 对话操作互斥 | src/agent/locks.ts | 按 conversation 分键串行，不同会话并发；支持取消等待、异常释放 |
| 共享知识读写锁 | src/agent/locks.ts | 多读者并发、FIFO 写者公平；升级等待所有读者，持有 action 不因 signal 取消而被提前释放 |
| 删除前置 guard 核心 | src/agent/session-lifecycle-guard.ts | 在共享锁内验证持久绑定/代次/active turn、授权、停止确认，并二次读取/授权；持久化绑定已由 AgentStore 提供，进程/权限宿主端口待生产 Runtime 接入 |
| 受管存储持久身份 | src/providers/managed-session-store.ts | 只在空平台私有根创建 marker；Provider/storeId 绑定；重启后拒绝替换根，不把新空目录误判为原历史已删除 |
| Codex 删除适配 | src/providers/codex-session-lifecycle.ts | 正确 CODEX_HOME、统一调度、独立无工具控制连接、精确 read + 全分页核对、原生 delete、失败/未知/响应丢失处理 |
| Pi 删除适配 | src/providers/pi-session-lifecycle.ts | 原生 v3 JSONL 精确身份、UTF-8 header/路径/链接检查、unlink 确切受管文件，不动共享知识或其他会话 |
| 服务端编译入口 | tsconfig.server.json | agent 模块纳入编译；未接入启动路径，因此不会改变现有生产行为 |
| 已批准统一 SQL | src/agent/schema.ts | 九表及部分唯一索引、复合外键、JSON/引用大小、身份不可变、single/活动轮次/操作互斥与删除确认触发器 |
| 统一持久化 | src/agent/store.ts | 创建/提交幂等、同 Provider 模型确认、generation/revision CAS、查询 revision 证明、应用/outbox 同库事务、事件游标、最小删除回执与重启中断核对 |
| 轮次执行内核 | src/agent/runtime.ts | 复用持久化和对话锁，协调幂等提交、原生绑定、接受确认、提案基线与取消；未确认停止时保留原生提交待核对。已使用内存 SQLite 和测试 Provider 验证，生产宿主尚待接入 |
| 单轮原生 Provider 宿主 | src/agent/single-provider-host.ts、src/providers/registry.ts | 复用 Codex/Pi 原生一次性会话入口，统一 Runtime 接收原生提交确认，结果记录前等待释放；已通过两个协议夹具，业务入口切换待完成 |
| 多轮 Runtime 宿主 | src/agent/multi-provider-host.ts | 按已验证的 Provider 版本和知识契约放行，在共享工作区读租约内创建或准确恢复原生引用；连接关闭后再完成轮次。Codex 原生适配器已在协议夹具中跑通两轮，Codex/Pi 均已通过两轮协议夹具；Pi 保存 get_state 声明的真实延迟持久化路径，引用与删除适配器一致。真实完整能力验证及业务入口切换仍待完成 |
| 平台只读查询契约与网关 | src/agent/query-gateway.ts、asset-query-host.ts | 八项严格 Schema；短期、可撤销且绑定 actor/conversation/turn/generation 的授权；逐次 owner/资源检查、版本绑定、真实 current revision 证明、分页和源码行预算、敏感内容拒绝。业务读适配器已测试；CLI 传输与生产 authorizer 尚未接入 |
| 删除调度 | src/agent/control.ts | 共用会话锁、明确确认、持久操作、引用/代次二次校验、进程停止端口、受保护原生删除、原生成功后的平台重试、最小幂等回执；不提供虚假的默认停止证明 |
| 模型切换调度 | src/agent/model-control.ts | 同 Provider 契约、空闲互斥、确认后更新、失败确认旧模型、未知状态阻止新轮次并先 inspect；生产原生控制端口仍待实现 |
| 宿主反馈调度 | src/agent/feedback.ts | 外部投递前持久化 unknown，丢响应后先精确核对，不盲目重发；未知前序阻止后序，不创建模型轮次。原生反馈通道待接入 |
| 只读知识设置 | src/agent/settings.ts、src/server/app.ts、src/web/features/AgentKnowledgeSettings.tsx | 已接入 GET /api/settings/agent-knowledge 及设置侧栏；显示安装包 hash/文件和未激活边界，无写 API/按钮。交互测试通过，未完成实际浏览器主题/窄屏视觉验收 |
| v10→v11 重置 DB 步骤 | src/agent/legacy-reset.ts | 显式预览 token/停机证明、未知依赖拒绝、精确 Agent receipts 范围、业务逐表指纹保留、DDL 故障回滚；未注册到生产迁移链 |
| 重置预览命令 | src/cli/index.ts | `orchard agent-reset preview --data-dir <dir> --pretty` 在只读 SQLite 事务内预览旧 Agent 数据和受管目录，文件内容变化会使确认令牌失效。已在隔离测试库验证；备份、停机证明及迁移执行尚待接入 |
| 审批证据 | schema-approval.json、schema-review-approved.md | 用户明确“批准”，不可变审核快照 SHA-256 可验证；不授权自动重置已有数据 |
| 内置知识与 manifest | src/agent/knowledge/**、knowledge-bundle.ts | 公共规则/三场景文档/Skills/只读工具声明；精确文件/UTF-8/字节哈希/预算/路径/重复键校验，模块相对资源定位 |
| 共享知识安装/恢复 | src/agent/knowledge-service.ts、knowledge-store.ts | 读租约并发、跨实例写锁公平、CLI 停止端口、原子切换日志与 DB operation 归属、五边界故障恢复、同 hash 修复/新 hash 旧 multi 只读 |
| 构建和 tarball | scripts/agent-knowledge.mts、package.json | 开发/测试/构建前校验，包含隐藏目录的复制及 npm tarball 无源码/异 cwd 加载测试 |

不能使用测试中的最简 guard 作为生产停止证明。真实 Runtime 必须使用已登记 delete operation 的持久状态、数据目录单写者租约、准确进程退出证明及 Binding CAS。

## 真实 CLI 验证

- Codex 0.167.0：在全新临时 CODEX_HOME 创建原生持久会话，用官方 inject_items 写入测试数据（不触发生成），关闭创建连接，再由独立适配器准确读取、原生 thread/delete、核对消失、重复删除。
- Pi 1.5.1：官方 SDK SessionManager 写入合成测试会话，CLI 精确 --session 文件打开并 get_state 核对身份，退出 CLI 后由适配器删除文件并幂等重试。
- 两项均通过；不发送 prompt 或 turn/start，不使用已有用户会话，不调用收费模型。
- 本轮在 Codex 0.167.1、Pi 1.5.2 上重新执行两项原生删除测试，均通过。
- **实测修复**：Codex thread/list 可以隐藏仍能 thread/read 的目标，不能只凭“列表里没有”判 absent。已改为先精确 read；只有已验证的精确缺失错误后才进行列表核对，其他原生/权限错误均 unknown/失败。新增假协议回归覆盖。

复核命令（路径需换成本机已安装 CLI/SDK，所有资源只在测试临时目录内创建和删除）：

```sh
ORCHARD_NATIVE_CODEX="$(command -v codex)" \
ORCHARD_NATIVE_PI="$(command -v pi)" \
ORCHARD_NATIVE_PI_MODULE="/absolute/path/to/pi-coding-agent/dist/index.js" \
node --import tsx --test tests/agent-native-lifecycle.test.ts
```

未设置环境变量时，原生测试明确 skip，不伪装通过。原生基本流程通过不代表附件、派生范围、未知进程恢复或全部 P0 能力已验收。

## 验证结果

- 上轮相关 15 个测试文件：153 passed，2 个 opt-in 原生测试默认 skip；本轮新增 28 项知识/安装/打包测试通过，先前 schema/持久化/重置/审批 29 项保持通过。原生两项此前已通过上面的显式命令单独执行。
- `npm run typecheck`、`npm run migration:check`、`npm run build` 通过；构建仅保留既有大 chunk 警告。`git diff --check` 通过。
- 使用现有 `lock-migration-release.mjs --refresh-unpublished` 刷新开发中依赖完整性锁，解决 pretest 阻塞；已核对 14 个历史迁移 ID/checksum 完全不变，旧 schema approval archive 未修改。新 v11 步骤尚未加入生产声明链。
- 上轮全量测试使用 macOS 物理 TMPDIR，`npm test -- --test-concurrency=4` 完整运行：840 项中 834 passed、1 failed、5 skipped。失败仍为原有 `tests/interface.test.ts` 的工作流脚本选择器期望省略 inputSchema、实际含 inputSchema:true；此前在单独解包的 HEAD 基线复现相同失败，未改动该 UI/测试。不是全量绿灯。
- 默认 macOS TMPDIR 含 /var 别名，会触发现有 Git/密钥安全测试的祖先 symlink 检查；使用 `TMPDIR=\"$(cd \"${TMPDIR:-/tmp}\" && pwd -P)\"` 后相关 19 项既有测试通过，没有放宽安全实现。
- 新 schema/reset 只在测试内存数据库执行；未对已有用户数据库执行升级/重置，未调用收费模型，未进行新 UI 视觉验收。

## 本轮增量验证与明确阻塞

- 当前工作树 `npm run typecheck`、`npm run migration:check`、`npm run build`、`git diff --check` 通过；构建仍有既有大 chunk 警告。
- 使用 macOS 物理 TMPDIR 完整执行 `npm test -- --test-concurrency=4`：**889 tests，883 passed、0 failed、6 skipped**。该结果涵盖当前工作树，包括其他并行 UI 改动，不仅是本 feature。
- Codex 0.167.1 / Pi 1.5.2 的显式 opt-in 原生测试 **3 passed**：两项既有原生删除，加一项 Pi 首次生成前声明稳定时间戳路径。全部在新临时目录内操作，不发送 prompt/turn/start，不调用收费模型。
- Pi 协议夹具验证两轮、关闭进程后准确恢复、错误/缺失路径拒绝；最终引用与 PiSessionLifecycle 统一，不再保存猜测的 `<sessionId>.jsonl`。
- 新查询/调度测试覆盖 allowlist、路径穿越、版本、过期/撤销/取消授权、敏感源码切片绕过、真实查询 revision 证明、受管停止失败、原生成功后平台失败重试、模型切换未知状态核对和反馈丢响应核对。
- 知识设置已接入现有生产设置导航，但只展示经过校验的**安装包资源**，明确标识新 Runtime 未激活；无知识写 API。已有交互测试，**未完成真实浏览器浅/深主题、长内容和窄屏视觉验收**。
- 已刷新未发布开发 release 的依赖完整性锁，14 个历史迁移声明保留原身份；未改已批准 SQL/审批快照，未注册 v11 生产迁移。

**未跨越的生产门槛**：当前 Pi RPC 基础命令没有无生成宿主事实注入命令；单纯 `prompt`/`follow_up` 会启动或排队生成，不能拿来冒充 hostFeedback。必须完成受控原生扩展/SDK 等真实通道及其验证，Codex 也须完成工具/反馈与隔离接线。查询网关和三个调度器目前提供宿主端口，不提供默认放行 authorizer 或虚假的停止证明；协议夹具证据不写成生产能力 verified。

因此本轮仍未完成全场景生产接入、统一对话 API/事件/UI、旧旁路移除和完整升级重置流程。新 schema 与旧业务入口不兼容，不能为了缩短清单而先激活生产迁移。用户本次要求完成编码，不等于确认对现有数据执行重置。

## Review 问题修复

已修复本轮 review 的五项问题，回归测试见 `tests/agent-review-regressions.test.ts`：

1. Pi 初始化失败后，确认进程退出，仅通过 inode/dev 校验并移除本次创建的空目录；已有目录、非空目录和持久历史保留，不递归删除或接管未知资源。
2. 反馈入队在现有事务中分配每对话严格递增的逻辑时间，防止同毫秒或系统时钟回退造成后序越过 unknown 前序；跨 Store 重建及幂等重试均有测试。无表结构变更。
3. 已发送但未确认的模型切换，重试只走 inspect，不因目标模型后续禁用而跳过核对；新切换仍需模型选择校验，身份授权仍然检查。
4. `current.get` 返回有界元数据/revision，并记录真实基线；完整定义通过虚拟资源文件 `$definition.json` 读取。`assets.read_file` 支持行分页或 Unicode 字符分页，超长单行亦能完整读取；大定义不再阻止生成提案。
5. 引用扫描容忍缺失/不完整 nodes 和 config；保留可解析关系，同时返回 incomplete、incompleteSources（最多 10 项）与 incompleteSourceCount，不把不完整扫描伪装成无引用。草稿详情保留 validation。

内置知识同步更新为 `2026.11.11.2`，明确元数据/定义读取、分页游标和不完整引用结果语义。只更新源码及安装包 manifest，未操作用户运行目录。

最新验证：类型检查、migration:check、构建及 diff --check 通过；完整测试 **895 tests，889 passed、0 failed、6 skipped**。没有数据库表结构变更，没有启用 v11 迁移；这些修复不改变下列未完成生产接入边界。

## 尚未完成（不得宣告 feature 全部交付）

| 阶段 | 待办/阻塞 |
|---|---|
| P0 剩余协议 | 受控只读查询工具、无额外生成的宿主反馈、知识加载与祖先/全局隔离、共享只读 cwd 并发、同会话模型切换/失败保持；删除附件/派生范围与真实故障负例 |
| P1 数据库 | **用户已批准并完成 SQL、AgentStore 与 DB 重置步骤编码/测试**；生产迁移注册、文件/journal 阶段与全局版本切换需与新 Runtime 切换一同完成，不能提前让旧服务打开新表 |
| P2 知识/工具 | **源码知识、manifest/安装包复制、共享工作区初始化/恢复、八项查询契约/敏感过滤/业务读适配器与只读知识设置 API/UI 已编码并测试**；仍需 CLI 受控工具传输、生产身份/owner authorizer、所选测试安全端口及初始化端口接入 |
| P3 统一内核 | AgentStore 状态/幂等/恢复/取消/outbox、删除/模型切换/反馈调度已实现；仍需原生控制/反馈通道、可靠进程/权限端口、知识/工具/资源租约与业务场景接入 |
| P4 全场景 | 三维护场景原生 multi、single 场景、revision 查询证明与应用校验、统一 API/事件/UI，移除旧重放/重建旁路 |
| P5 发布 | 经确认的升级重置、迁移 release 归档与完整构建打包、真实模型与工具交互、UI 主题/窄屏验收 |

本轮知识实现、构建命令和安全/恢复边界详见 [knowledge-implementation.md](./knowledge-implementation.md)。

## 当前激活边界

[schema-review.md](./schema-review.md) 已获用户明确批准，后续编码不再等待同一审批。审批快照与证据见 schema-approval.json。

当前全局 SCHEMA_VERSION/生产迁移链仍为 v10，避免旧服务读到新表；v11 DB 步骤仅供新运行时切换时注册，不能作为单独可发布升级。没有启用 JSON sidecar 或旧/新双写。

批准 schema 只授权实现，不等于允许立即重置已有数据。实际升级时仍须展示破坏性预览并确认、备份并核实所有受管进程停止；文件重置和完整发布验收尚未完成。
