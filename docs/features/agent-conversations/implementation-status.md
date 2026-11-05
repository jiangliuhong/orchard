# Agent 单次与多轮对话：实施状态

对应设计：[design.md](./design.md)。本文件记录分阶段交付状态，实施顺序与验收要求以设计 §14、§24、§25 为准。

## 已交付（Phase A–E，2026-11-04）

已完成协议/传输、审核后的持久化迁移、对话生命周期、上下文 envelope、原生多轮基础编排与 API/UI 基础接入：

### Phase A 契约固定
- `src/domain/types.ts`：新增对话公共 DTO（ConversationMode、ContextMode、ConversationStatus、ConnectionState、AuthoringTurnStatus、SubmissionState、ConversationView）；`ProviderCapabilities` 增加可选 `sessions`（旧 Provider 由 registry 规范化为 `"none"`）。
- `src/providers/session.ts`：§18.1 完整会话契约（BackendRef、ProviderSessionHandle、SessionOpenRequest、SessionTurnRequest、SessionProvider、NativeAdapter）与连接指纹（§17.1 白名单 canonical SHA-256）。
- 协议基线与 CLI 版本矩阵：[protocol-baselines.md](./protocol-baselines.md)（codex-cli 0.165.0 / pi 1.3.0 实测）。
- 假协议进程：`tests/fixtures/codex-server.mjs`、`tests/fixtures/pi-server.mjs`（可控场景、记录收到的命令供断言）。

### Phase B 传输与调度
- `src/providers/transport/jsonl.ts`：字节级 LF 分帧（多字节安全、CRLF、U+2028/U+2029 不分隔）、有界写背压队列、进程组生命周期（SIGTERM→SIGKILL 宽限）、协议记录上限、损坏记录视为连接错误。
- `src/providers/transport/pending.ts`：请求 ID 关联、独立确认超时、关闭统一 reject。
- `src/providers/session-manager.ts`：全局进程配额（含探测/验证/单次/多轮）、FIFO 有界等待队列（超时/取消）、无空槽先回收最久空闲连接、idleTtl 定期回收、连接代次递增与旧代次拒收。
- `src/providers/agent-limits.ts`：§23.1 全部运行时参数集中，可覆盖用于测试。

### Phase C Provider
- `src/providers/codex-app-server.ts`：握手、thread/start|resume（ephemeral 按持久性）、turn/start 先注册事件、响应前通知暂存与归属校验、completed item 覆盖增量、turn.status 终态区分、服务端请求应答（工具请求拒绝 + TOOLS_DISABLED、未知 -32601）、线程级 usage 范围标注、中断（turn/interrupt → 宽限 → 回收）、无模型探测。
- `src/providers/pi-rpc.ts`：受控启动参数、get_state 校验（模型/sessionId/isStreaming）、disposition=started 才接受、agent_settled 边界、重试中间错误不当最终错误、clear_queue→abort 中断顺序、会话文件 realpath 校验（缺失/越界 symlink/目录冒充/超预算拒绝）、首轮接受后刷新会话引用。
- `src/providers/registry.ts`：`transportOf` 读取规范化（缺省 legacy，不自动切换已有配置）、config 部分字段合并保存、`capabilitiesFor` 按配置输出实际能力、`registry.run()`/`verifyModel()` 按能力分派（native 临时句柄 persistent=false，finally 释放并等待进程退出；legacy 单次进程同样占用调度槽位）、原生探测缓存 60s（连接指纹键控，配置变化未命中）、provider.started 事件携带 transport、readiness 携带 transport/errorCode。
- `src/server/app.ts`：装配 SessionManager 与两个原生适配器；关闭顺序按 §23.2（preClose 停接收/关 SSE/取消验证 → onClose 创作与运行任务 → Provider 连接 → Store）。

### 测试
- `tests/agent-transport.test.ts`、`tests/agent-sessions.test.ts`、`tests/codex-app-server.test.ts`、`tests/pi-rpc.test.ts`（场景覆盖设计 §24 矩阵：拆包/粘包/CRLF/U+2028/U+2029/背压/非法 JSON/残缺 EOF/pending 关闭；max=1 无死锁/FIFO/回收/取消/配额/独立句柄/旧代次拒收；握手顺序/先通知后响应/完整文本覆盖/failed/interrupted/未知请求/工具拒绝（命令/文件/MCP/审批分别模拟）/usage 范围/恢复失败分类/多轮同进程/中断与下一轮/单次上下文隔离/legacy 回归；accepted≠completion/临时重试/queued/handled 违规/clear_queue→abort/会话文件恢复与拒绝/超时清理）。
- 真实 CLI 无模型冒烟通过（见 protocol-baselines.md §4）。

### Phase D 持久化（数据库审核通过后实施）
- `SCHEMA_VERSION=3`：新增 `agent_conversations`、轮次/消息关联列、submission state、后端轮次与连接代次、当前会话/活动轮次索引。
- v1→v2→v3 顺序迁移；迁移前 checkpoint + 独占备份、备份完整性检查、行数与 foreign key 校验、失败事务回滚；不执行逆向 DROP COLUMN。
- Store 增加对话查询/创建/归档/后端引用/轮次 CAS API；显式列名新插入、跨草稿/跨会话归属检查；删除清理自引用；启动恢复将未结束轮次标记 interrupted，并对不确定后端会话标记 needs_rebuild。
- 迁移测试覆盖新库、v1/v2 升级、回滚、旧行 NULL 关联、唯一活动轮次、跨草稿隔离、恢复和删除。

### Phase E（2026-11-04 第二批）
- `src/authoring/context.ts`（§23.3 全量）：context envelope（contextVersion:1、initial/continuation、previousOutcome、确定性历史摘录 ≤64 KiB/≤20 条/≤8 KiB、合法 UTF-8 边界截断、availableAgents 目录）、固定创作规则常量、512 KiB prompt 预算拒绝（不截规则/schema）。**接入受理事务等待 Phase D。**
- `src/authoring/service.ts`（§19.3）：`applyAuthoringChanges` 纯准备阶段提取（重复路径/safeFile/create-update-delete 状态/checkFiles），generate() 改用该函数，语义不变。
- §22.3 错误状态码：`check()` 支持可选 statusCode；app.ts 错误处理器优先 AppError.statusCode（NOT_FOUND 除外，旧码字符串匹配兼容）；PROVIDER_UNAVAILABLE / PROTOCOL_UNSUPPORTED 显式 503，AGENT_QUEUE_FULL 503，SESSION_REBUILD_REQUIRED 409。
- `tests/context.test.ts`：UTF-8 截断边界、摘录预算与顺序/条数/角色过滤、initial/continuation/single 形状、512 KiB 拒绝、纯准备阶段语义回归。

## 待实施

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| E 完整语义 | 完整受理事务幂等/崩溃窗口、全部 SSE payload 字段、事件批量持久化与断线补读细化 | 继续完善 |
| F UI 与验收 | 历史对话筛选/连接状态细化、真实双后端三轮/取消/重启恢复专项验收 | 待真实环境验收 |

数据库方案已在本次会话获审核通过后实施；若后续调整字段或约束，先同步 design.md。

## 行为说明（当前状态）

- 所有现有安装的 Provider 配置缺少 `transport`，读取时按 `legacy` 处理，默认行为与升级前完全一致（§17.1）。
- 用户在设置中将内建 Provider 的 `transport` 切为 `native` 后：节点调用与模型验证走原生协议单次调用；创作可创建持久逻辑会话，并在 native multi 模式下复用后端上下文。
- `native` 模式探测失败时 readiness 为 unavailable 并携带错误码（PROTOCOL_UNSUPPORTED/TIMEOUT），可切回 legacy；不自动回退或静默重试（§13）。
- 已实现 `/api/drafts/:id/conversations` 创建/重置、会话列表、显式消息过滤与创作提交的 `conversationId`；needs_rebuild 会话禁止继续生成并提供重建入口。
