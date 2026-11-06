# 历史对话功能：数据库结构变更提案（v3 → v4）

状态：**已审核通过并实施**。本提案记录 v3 → v4 的数据库结构变更及审核结论；实施前已按根目录 `AGENTS.md` 与 `history-feature.md`「实施边界」完成审核。

对应 feature：[history-feature.md](./history-feature.md)。基础契约：[design.md](./design.md) §11、§20、§25（「若评审调整字段或约束，先同步本文件」）。

## 1. 变更范围

本 feature 需要三处结构变更，其余需求（resume / restore / archive 接口、列表派生字段、前端交互）均为纯代码增量，不涉及结构：

| 变更 | 原因 |
| --- | --- |
| `status` CHECK 增加 `'idle'` | 区分「轮换产生的可继续历史对话」与「用户主动归档」；现有 CHECK 无法 ALTER，需重建表 |
| 新增 `title TEXT` 列 | 标题需持久化用户手动修改；`updated_at` 会被覆盖，无法承载 |
| 新增 `archived_at INTEGER` 列 | 归档时间用于展示与审计，现有列无法推导（见 §4） |

不需要变更：`authoring_turns`、`authoring_messages`、`command_receipts`、`one_current_conversation` / `one_active_turn` 唯一索引（`idle` 不占用当前对话名额，语义不变）。

## 2. 现状与依据

- 现网 `SCHEMA_VERSION=3`，`agent_conversations.status CHECK('current','archived','needs_rebuild')`（`src/persistence/schema.ts`）。
- 现网 `archived` 状态只有一个写入口：`Store.archiveCurrentConversations()`，仅在「创建新对话 / 配置轮换」时由 `ConversationService` 调用（`src/authoring/conversations.ts` 两处）。`markConversation(id, "archived")` 无生产调用方（仅 `needs_rebuild` 在 `service.ts:244` 使用）。**因此存量 `archived` 行全部是轮换产物，语义上就是新方案的 `idle`**。
- `archived_at` 无法从现有数据精确推导：`archived` 行自归档起无后续写入，`updated_at` 即归档时刻（近似值，见 §4.2）。

## 3. 精确 DDL 提案

### 3.1 增量迁移 `MIGRATE_V3_TO_V4`

沿用 v1→v2 的表重建模式（`PRAGMA foreign_keys=OFF` 期间 DROP + RENAME，自引用指向 `_v4` 临时名，RENAME 后由 SQLite ≥3.25 自动改写回 `agent_conversations`）：

```sql
CREATE TABLE agent_conversations_v4 (
 id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES drafts(id),
 mode TEXT NOT NULL CHECK(mode IN ('single','multi')),
 context_mode TEXT NOT NULL CHECK(context_mode IN ('isolated','native','reconstructed')),
 status TEXT NOT NULL CHECK(status IN ('current','idle','archived','needs_rebuild')),
 provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),
 model_id TEXT NOT NULL,
 transport TEXT NOT NULL CHECK(transport IN ('legacy','native')),
 connection_fingerprint TEXT NOT NULL,
 cli_version TEXT,
 backend_ref_json TEXT,
 backend_generation INTEGER NOT NULL DEFAULT 0 CHECK(backend_generation >= 0),
 synced_revision INTEGER CHECK(synced_revision >= 0),
 rebuild_from_id TEXT REFERENCES agent_conversations_v4(id),
 title TEXT CHECK(title IS NULL OR (length(title) BETWEEN 1 AND 200)),
 archived_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 last_used_at INTEGER,
 CHECK (
  (mode='single' AND context_mode='isolated')
  OR (mode='multi' AND transport='native' AND context_mode='native')
  OR (mode='multi' AND transport='legacy' AND context_mode='reconstructed')
 ),
 CHECK (status != 'archived' OR archived_at IS NOT NULL)
);
INSERT INTO agent_conversations_v4(
 id,draft_id,mode,context_mode,status,provider_id,provider_revision,model_id,
 transport,connection_fingerprint,cli_version,backend_ref_json,backend_generation,
 synced_revision,rebuild_from_id,title,archived_at,created_at,updated_at,last_used_at)
 SELECT id,draft_id,mode,context_mode,
   CASE status WHEN 'archived' THEN 'idle' ELSE status END,
   provider_id,provider_revision,model_id,transport,connection_fingerprint,cli_version,
   backend_ref_json,backend_generation,synced_revision,rebuild_from_id,
   NULL,
   CASE status WHEN 'archived' THEN updated_at ELSE NULL END,
   created_at,updated_at,last_used_at
 FROM agent_conversations;
DROP TABLE agent_conversations;
ALTER TABLE agent_conversations_v4 RENAME TO agent_conversations;
CREATE UNIQUE INDEX one_current_conversation
 ON agent_conversations(draft_id)
 WHERE status = 'current';
CREATE INDEX conversations_by_draft
 ON agent_conversations(draft_id,created_at,id);
CREATE INDEX conversations_by_activity
 ON agent_conversations(draft_id,updated_at DESC,id);
PRAGMA user_version = 4;
```

要点：

- `authoring_turns.conversation_id` / `authoring_messages.conversation_id` 的外键按名称解析，DROP + RENAME 后自动指向新表，无需改写（v1→v2 对 `runs` 已验证同一模式，迁移后现有 `PRAGMA foreign_key_check` 校验覆盖）。
- 重建不改各行 `updated_at`：状态标签翻译不构成新活动，保持「最近活动时间」排序语义。
- 新索引 `conversations_by_activity` 服务历史列表「按最近活动时间倒序」；单草稿行数少，属可评审取舍项，可去掉。

### 3.2 新库 SCHEMA 等价调整

`SCHEMA`（全新安装）中 `agent_conversations` 定义同步为 v4 形态（`idle`、`title`、`archived_at`、两条新 CHECK、`conversations_by_activity` 索引、自引用仍写 `REFERENCES agent_conversations(id)`），`SCHEMA_VERSION = 4`。**新库与 v1/v2/v3 升级后的 schema 必须等价**（沿用现有 `sqlite_master` 比对测试思路）。

## 4. 数据映射决策（需审核确认）

### 4.1 `archived` → `idle`

依据见 §2。迁移后用户看到的差异：原「已归档」列表中的会话变为「历史对话（可继续）」，符合 history-feature.md 的状态表（`idle`：先切换后可发送）。无用户主动归档数据存在，不存在误映射。

### 4.2 `archived_at` 取 `updated_at`（近似值）

存量 `archived`（→`idle`）行取迁移前 `updated_at` 作为 `archived_at`，仅用于「已归档」列表展示排序；该值是归档时刻的最佳近似，不保证为真实归档时间。若评审认为不该近似，可改为统一置 NULL（展示时退化为 `updated_at` 排序），二选一需在审核中确认。

### 4.3 `title` 置 NULL，展示时推导

不在迁移中回填标题（避免在 SQL 中解析 `content_json` 的复杂回填逻辑）：

- 存量行 `title = NULL`；展示规则：`displayTitle = row.title ?? 确定性摘录(首条用户消息)`。
- 摘录规则（确定性，无模型调用）：取该对话按 `sequence` 最小的 `role='user'` 消息 `content_json.$.text` 前 80 个 Unicode 码点，截断时追加 `…`；无用户消息时显示「未命名对话」。
- 新对话落库首条用户消息时，若 `title IS NULL` 则同步写入该摘录（同一事务）；用户手动改名后不再覆盖。列上 CHECK 限长 1–200 字符，API 层同样限制。

## 5. 不变量

- 每草稿至多一个 `current`/`needs_rebuild`（`one_current_conversation` 不变）；`idle` 不占名额。
- `archived` 行必有 `archived_at`（表级 CHECK）；`current`/`idle`/`needs_rebuild` 行的 `archived_at` 保留上次归档时间作审计（恢复不清空，再次归档时覆盖）。
- 活动轮次约束不变：`one_active_turn` 仍是草稿级唯一；「有活动轮次时禁止新建/切换/归档/恢复/删除」由服务层在事务内校验，不新增数据库约束。
- 对话状态与轮次状态继续相互独立（design.md §18.1）。

## 6. 迁移执行与回退

沿用现有机制，无需改执行框架：

1. 启动时检测 `user_version=3` → WAL checkpoint（TRUNCATE）→ 关闭连接复制主文件至 `backups/workbench-v3-<uuid>.db` → `quick_check` + 版本校验。
2. `PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE` → 执行 §3.1 → `foreign_key_check` → 全表行数比对（重建表行数不变）→ `COMMIT` → `PRAGMA foreign_keys=ON`。
3. Store 版本接受列表由 `[1,2,SCHEMA_VERSION]` 扩为 `[1,2,3,SCHEMA_VERSION]`。
4. **回退**：停服，用 `backups/workbench-v3-*.db` 整库恢复并回退到 v3 匹配代码（v4 代码打开 v3 库会因版本检查拒绝，不存在半升级状态）。v4 期间产生的数据（`idle` 标记、标题修改、归档记录）会丢失，回退前需导出说明。

## 7. 审核通过后的代码变更范围

| 文件 | 变更 |
| --- | --- |
| `src/persistence/schema.ts` | `SCHEMA_VERSION=4`、`MIGRATE_V3_TO_V4`、`SCHEMA` 同步 |
| `src/persistence/store.ts` | 版本列表扩容；新增 `demoteCurrentConversations`（轮换写 `idle`）、`resumeConversation`（`idle`→`current` + 原当前→`idle`）、`archiveConversation`（写 `archived_at`）、`restoreConversation`（`archived`→`current`）、`renameConversation`；`conversationView` 追加 `title`/`archivedAt` 及派生字段 |
| `src/domain/types.ts` | `ConversationStatus` 加 `"idle"`；`ConversationView` 追加历史字段（枚举沿用 design.md §18.1，见 history-feature.md 修订） |
| `src/authoring/conversations.ts` | 状态机命令编排：活动轮次检查、事务边界、receipt scope 复用 `conversation:<draftId>`（`POST /:id/rebuild` 复用 create+`rebuildFromId` 同一实现与幂等语义） |
| `src/server/app.ts` | 新路由：resume / rebuild / archive / restore |
| `src/web/features/DraftPage.tsx`、`src/web/lib/api.ts` | 对话选择器、历史/归档分组、活动轮次锁定 |
| `tests/store.test.ts` 等 | 见 §8 |

## 8. 测试计划

- **迁移**：v3 库升级后 schema 与新库等价（列、CHECK、索引、user_version）；行数一致；`foreign_key_check` 通过；`archived→idle`、`archived_at≈updated_at`、`title NULL` 映射断言；v1/v2 顺序升级至 v4 不回归；迁移失败注入后回滚、库未被破坏。
- **Store**：resume/restore/archive/rename 状态表全覆盖（含非法转换拒绝且库不变）；并发 resume 仅一个成功（唯一索引 + 事务）；跨草稿 `404`；`archived` 必有 `archived_at` 约束生效。
- **服务/API**：活动轮次期间四类命令全部拒绝；`rebuild` 与 `create+rebuildFromId` 幂等等价；receipt scope 一致性；错误码按 history-feature.md（`CONVERSATION_CONFLICT` / `SESSION_REBUILD_REQUIRED` / `REQUEST_CONFLICT`）。
- **回退演练**：v3 备份恢复后旧版本代码可正常打开（至少一次人工验证）。

## 9. 审核确认点

1. `archived → idle` 存量映射（§4.1）。
2. `archived_at` 取 `updated_at` 近似 或 置 NULL（§4.2，二选一）。
3. `title` 懒推导 + 首条消息落库策略与 80/200 字符限制（§4.3）。
4. 新索引 `conversations_by_activity` 是否保留（§3.1）。
5. DDL 本身（§3.1 / §3.2）。

## 10. 审核记录

| 日期 | 结论 | 备注 |
| --- | --- | --- |
| 2026-11-06 | **审核通过，授权实施**（会话内评审） | 按提案推荐默认执行：§4.1 `archived→idle`；§4.2 `archived_at` 取 `updated_at` 近似；§4.3 `title` 懒推导 + 首条消息落库（80/200 字符限制）；保留 `conversations_by_activity` 索引 |
| 2026-11-06 | **已实施**（`SCHEMA_VERSION=4`） | v3→v4 迁移、Store/服务层/API/UI 与测试均已交付，见 implementation-status.md Phase G；待真实 Provider 专项验收 |

**评审修正（实施前同步入 DDL）**：`one_current_conversation` 唯一索引谓词由 `status IN ('current','needs_rebuild')` 改为 `status = 'current'`。原因：feature 状态表要求"`needs_rebuild` 重建后原会话保留为诊断历史"，与新的 `current` 并存；若沿用旧谓词，重建后同一草稿会出现两行命中唯一索引导致约束冲突。`needs_rebuild` 不再占用当前对话名额（design.md §18.1 注释相应失效）；"无 current 且存在 needs_rebuild"时受理提交返回 `SESSION_REBUILD_REQUIRED`（见 history-feature.md）。

