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

## 已交付（Phase G 历史对话，2026-11-06）

数据库结构变更已按 [history-schema-proposal.md](./history-schema-proposal.md) 审核通过并实施（`SCHEMA_VERSION=4`：`idle` 状态、`title`、`archived_at`；存量 `archived` 映射为 `idle`，`archived_at` 取迁移前 `updated_at` 近似；`one_current_conversation` 谓词收窄为仅 `current`，`needs_rebuild` 重建后保留为诊断历史）：

- **Store**：`demoteCurrentConversation` / `resumeConversation` / `archiveConversation` / `restoreConversation` / `renameConversation` / `setTitleIfUnset` / `userMessageText` / `lastTurnStatus` / `activeTurnId`；`currentConversation` 仅返回 `current`；列约束（archived 必有 archived_at、标题 1–200 字符）。
- **ConversationService**：resume / rebuild / archive / restore / rename 命令（receipt scope `conversation:<draftId>`，事务内校验草稿修订号、可编辑与无活动轮次）；`ensureForTurn` 新语义（空草稿懒创建、无 current 且最新对话 needs_rebuild → `SESSION_REBUILD_REQUIRED`、无 current 且有存量对话 → `CONVERSATION_CONFLICT`、显式 idle/archived 提交拒绝）；标题确定性生成（80 码点截断）与首条用户消息回填。
- **API**：`/api/drafts/:id/conversations/:cid/{resume,rebuild,archive,restore,rename}`；列表按最近活动倒序并携带派生字段（title/archivedAt/lastUserMessage/lastTurnStatus/activeTurnId）。
- **UI**：DraftPage 对话选择器（当前/历史/需要重建/已归档分组、继续/归档二次确认/恢复/重建/内联改名、按选中会话过滤消息、无 current 禁用发送、重建提示条）。
- **测试**：`tests/conversations.test.ts`（状态机、幂等、活动轮次阻塞、跨草稿 404、ensureForTurn 语义、标题回填、HTTP 错误码）；`tests/store.test.ts`（v3→v4 迁移映射、结构等价、状态机与约束）；`tests/interface.test.ts`（面板交互、重建横幅、发送锁定）。
- 已知存量失败（与本 feature 无关，clean HEAD 同样失败）：`draft output configuration applies to workflow.json…`。

## 真实 Provider 验收（Phase G，2026-11-06）

环境：codex-cli 0.165.0、transport `native`、模型 `gpt-6-luna`、真实账号付费调用（共 6 次成功轮次 + 1 次 resume 失败，无重试发费）。脚本：`/tmp/orchard-accept/acceptance.py` + `scenario5.py`（临时，未入库；场景与断言与 `tests/conversations.test.ts` 模拟版一一对应）。

| 场景 | 结果 |
| --- | --- |
| 同一对话多轮原生上下文续接（暗号记忆） | ✅ 两轮均召回暗号 |
| 新对话上下文隔离（不引用旧对话） | ✅ 回复“不知道” |
| 归档 → 消息仍可查询 → 恢复 → resume 历史 | ✅ 消息完整，状态机正确 |
| 服务重启后 current 可继续、thread/resume 上下文保持 | ✅ 重启后继续且仍召回暗号 |
| 失效引用懒发现：resume 永久失败 → SESSION_REBUILD_REQUIRED → 会话 needs_rebuild → 409 拒直接提交 → 重建新 current + 诊断历史保留 + 全新上下文 | ✅ 全链路 |

验收中发现并修复两个真实环境问题（模拟测试无法覆盖）：

1. **Codex 严格结构化输出拒绝宿主 schema**：`response_format` 要求 `required` 覆盖全部 `properties` 且不支持 `maxLength` 等关键字，`AUTHORING_SCHEMA` 被拒（`PROVIDER_FAILED: Invalid schema for response_format`）。修复：`codex-app-server.ts` 新增 `strictOutputSchema()` 兼容性检查，仅完全兼容时随 `turn/start` 发送 `outputSchema`，否则省略并依赖宿主 `assertSchema`（与 `capabilities.structuredOutput: "validated"` 一致）。新增契约测试。
2. **永久性 resume 失败误分类**：codex-cli 0.165.0 对格式非法 threadId 报 `"invalid session id: …"`，原 `classifyResumeError` 只识别 "not found" 类文本，被归为临时 `PROVIDER_FAILED`。修复：正则扩展 `invalid (session|thread)`，归为 `SESSION_REBUILD_REQUIRED`（§19.4 明确不存在或不兼容）。新增 fixture 场景与契约测试。

Pi 后端本机无认证，未做真实调用；模拟协议测试已覆盖同一状态机与消息契约，待有账号时按同样场景补录（Phase F 双后端专项仍待做）。

## 当前编码状态（2026-11-10 补齐）

- 单次／多轮选择已接入工作流 UI。模式变化准备新对话，保留未发送输入；活动任务与未保存草稿锁定切换。
- ConversationView 从活动轮次和 Provider 当前句柄派生 absent／starting／ready／stopping／broken；生产适配器检查代次与空闲回收，不把已回收连接显示为 ready。
- 文本在宿主持久化边界按 50 ms 或 4 KiB 合并，保留 UTF-8 offset 与 itemId，非文本事件和所有终态前刷新；定时落库失败终止生成并按失败处理。
- turn.succeeded 增加 conversationId／appliedRevision；失败／取消携带 conversationId，单次调用也记录 sending／accepted／settled，终态仍与草稿更新共同提交。
- 会话选择／懒创建、上下文构造、轮次、用户消息和回执在同一受理事务中完成；上下文失败回滚新会话。延迟到达的同请求回执重放不重新派发模型。
- 前端去除 4000 字符截断，按 SSE sequence 去重并保留完整当前轮文本；服务端继续支持 Last-Event-ID 持久化补读。
- 已有历史管理、显式重建和重启中断语义保留。

专项测试：`tests/feature-completion.test.ts` 覆盖批量计时／阈值／UTF-8、落库失败、取消、单次／多轮受理状态与安全回执重放；`tests/interface.test.ts` 覆盖模式、输入保留、活动锁定及长流式回复去重。完整检查结果见[补齐验证记录](./completion-verification.md)。

## 当前协议与验收边界

仅支持 native；缺省 transport 也按 native 处理，不再提供 legacy 或回退。旧兼容对话按 [native-only 迁移](../2026-11-06-native-only/design.md)显式重建。上文 Phase A–G 是历史实施记录，不能据其 legacy 说明判断当前行为。

Codex 的真实历史场景已在上文记录；Pi／Codex 项目工具分析的真实验证见[项目分析实施记录](../2026-11-10-git-project-agent/implementation.md)，它不等于完成两种后端创作的三轮／取消／重启专项。此轮不调用真实付费模型，不把新增确定性测试或编码完成声明为全部外部环境验收通过。数据库结构、迁移身份和历史审核资源均无变更。
