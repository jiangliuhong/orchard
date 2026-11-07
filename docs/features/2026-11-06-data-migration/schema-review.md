# 数据迁移数据库结构与执行协议审核记录

状态：已审核。用户于 2026-11-06 在本会话明确回复“确认”，批准下述 SQL、v6 初始化及执行与恢复协议。

本材料按根目录 [AGENTS.md](../../../AGENTS.md) 和 [设计第 11.1 节](./design.md#111-数据库审核材料与真实状态)准备。本次结构迁移接入与初始化调整须先获得独立审核批准；审核记录仅填写真实的评审人、日期、范围与结论。

## 审核范围与摘要

申请审核既有 v1 → v6 精确 SQL、新库 v6 初始化、application_id 1331110449、各 user_version 更新，以及 [执行与恢复协议](./execution-protocol.md)。不新增 v7 或迁移业务表，不改变既有映射。

原始获批候选：[schema-approval.json](./schema-approval.json)；最终可执行发布清单：[migration-manifest.json](./migration-manifest.json)。

候选内容摘要（SHA-256）：

`b4ab6ac54d809210022ed6e304de944931b2512388dae89933bc8962120d34a4`

每项摘要覆盖规范声明及列出的精确 SQL / 协议 / 配置转换源码字节；不在启动时重算后替换锁定值。以下 SQL 直接取自现有 src/persistence/schema.ts 导出的展开字符串，保留原始字节存入 sql/，包括 RUN_SCHEMA 和 SCHEMA_VERSION 的实际展开结果，送审时未执行 SQL；批准后的实现与演练仅使用临时数据目录。execution-protocol.md 保留送审原始字节，其中“待审核/未实施”是当时快照，实际批准与实施状态以本文及验证记录为准。

上述摘要保留原始结构与协议审批证据。最终发布清单另外锁定副本执行器、类型映射、校验器、本地依赖、问题定义、历史夹具和构建脚本，生成冻结 bundle；发布构建还记录编译产物校验和。两个摘要分别表示结构审批与发布完整性，不互相替代。步骤 checksum 绑定其原始声明、SQL/协议和迁移执行模块；UI、业务源码、独立夹具和构建配置另外进入发布文件校验表及发布摘要。后续仅调整 UI 的合法发布会改变发布摘要，但不会改写已执行步骤的 ID/checksum；隔离发布测试验证这一点。requires 代表版本链顺序；源版本已验证包含的前置步骤由 baseline 满足，不伪造其历史执行记录。

| 条目 | 源 → 目标 | 候选 checksum | 本次审核 |
| --- | --- | --- | --- |
| db.v1-v2 | 1 → 2 | `2a55b9affd2d3eff5094d9fc26a310a73468232c48aefd9d02ce5d10244c061f` | 已批准 |
| db.v2-v3 | 2 → 3 | `6fb2249b4f40d5ac8eb4695158ecb93006edbdc17242d469ebe550704e26f2bc` | 已批准 |
| db.v3-v4 | 3 → 4 | `16f8b6353a628480addfe90c0bcdd8fbfddd6919f9d5062d609437288388f6e1` | 已批准 |
| db.v4-v5 | 4 → 5 | `ae2542c9fcec7c6b52a5fc9108558d98dd162235d1bf1e4393a4576b09dd4711` | 已批准 |
| db.v5-v6 | 5 → 6 | `74ab4c12daf027cac9be5940cd9e64b717d04535d389f1511903a1d78b470421` | 已批准 |
| db.initialize-v6 | 空目录 → 6 | `39ae7a98a754e2c341e32ec616aa357711a08105daca0d92443c0944218660fc` | 已批准 |
| config.web-bridge.v0-v1 | 0 → 1 | `1b70fb75ea55d7ffc29f73b84573a0e51baaebb49eb1790b0aeb4af22c028538` | 已批准（含协议） |

## 源与目标结构、历史行映射及校验

SQL 的 CREATE / ALTER / DROP / INDEX / TRIGGER 语句是下列结构差异的完整定义；最终当前结构见本文末尾的 v6 初始化 SQL。独立 v1～v6 基线及具有实际引用的数据夹具已建立；历史提交与 v5 中间格式的来源见 [provenance.json](../../../tests/fixtures/migrations/database/provenance.json)。测试先从历史声明式结构建库，再执行迁移。

### db.v1-v2

源：身份 1331110449、版本 1 的已验证工作台；目标版本 2。

逐列复制既有 runs 的 11 个字段；draft_id、draft_revision、snapshot_path 保持 NULL。保留 runs 主键、workflow_version_id、状态和所有引用；重建 queued_runs 索引。

校验要求：runs 行数及旧列逐值相同；新列均为 NULL；node_runs 等既有引用仍有效；queued_runs 存在；版本 2。

精确 SQL 文件：[db.v1-v2.sql](./sql/db.v1-v2.sql)

```sql


CREATE TABLE runs_v2 (
 id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),
 status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),
 input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,
 created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
 draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,
 CHECK (
  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)
  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)
 )
);

INSERT INTO runs_v2(id,workflow_version_id,status,input_ref,output_ref,active_node_id,cancel_requested_at,error_json,created_at,started_at,ended_at)
 SELECT id,workflow_version_id,status,input_ref,output_ref,active_node_id,cancel_requested_at,error_json,created_at,started_at,ended_at FROM runs;
DROP TABLE runs;
ALTER TABLE runs_v2 RENAME TO runs;
CREATE INDEX queued_runs ON runs(status,created_at);
PRAGMA user_version = 2;
```

### db.v2-v3

源：身份 1331110449、版本 2 的已验证工作台；目标版本 3。

新增空 agent_conversations；authoring_turns 和 authoring_messages 保留旧行。新增关联字段为 NULL，submission_state 为 not_sent。调整 one_active_turn 并增加对话关联索引。

校验要求：所有既有表行数及既有列相同；旧关联保持 NULL；submission_state 为 not_sent；新增对话表为空；唯一索引和关联索引准确；版本 3。

精确 SQL 文件：[db.v2-v3.sql](./sql/db.v2-v3.sql)

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
PRAGMA user_version = 3;
```

### db.v3-v4

源：身份 1331110449、版本 3 的已验证工作台；目标版本 4。

重建 agent_conversations；原 archived 转为 idle，title 为 NULL，原 archived 的 archived_at 取 updated_at，其余 archived_at 为 NULL。其他列逐值复制，包括 rebuild_from_id 自引用。唯一 current 约束不再包括 needs_rebuild。

校验要求：对话行数和主键相同；验证全部状态映射、时间映射、title 和其他列不变；自引用和轮次/消息外键有效；索引条件准确；版本 4。

精确 SQL 文件：[db.v3-v4.sql](./sql/db.v3-v4.sql)

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

### db.v4-v5

源：身份 1331110449、版本 4 的已验证工作台；目标版本 5。

新增空 scripts、script_versions、script_tests；新增三个索引和两个触发器。旧表与旧业务行不变。不补写默认脚本。

校验要求：既有表逐值、逐行不变；三个新表为空；唯一草稿索引、归属插入触发器和发布版本不可变触发器存在且定义匹配；版本 5。

精确 SQL 文件：[db.v4-v5.sql](./sql/db.v4-v5.sql)

```sql

CREATE TABLE scripts (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),
 status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
 current_draft_version_id TEXT, current_published_version_id TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
);
CREATE TABLE script_versions (
 id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
 entry_file TEXT NOT NULL, input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,
 source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,
 UNIQUE(script_id,version_no)
);
CREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft';
CREATE TABLE script_tests (
 id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),
 draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,
 duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
 CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)
   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))
);
CREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC);
CREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC);
CREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts
WHEN NEW.current_draft_version_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END;
CREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions
WHEN OLD.status='published'
BEGIN SELECT RAISE(ABORT,'published script version is immutable'); END;
PRAGMA user_version = 5;
```

### db.v5-v6

源：身份 1331110449、版本 5 的已验证工作台；目标版本 6。

script_versions 新增 NOT NULL timeout_ms，旧行填充 300000；范围 CHECK 为 1000～300000。既有发布版本源码、摘要及其他列不变。

校验要求：所有旧表行数和既有列相同；每个旧 script_versions.timeout_ms 为 300000；目标约束准确；发布内容保持不变；版本 6。

精确 SQL 文件：[db.v5-v6.sql](./sql/db.v5-v6.sql)

```sql

ALTER TABLE script_versions ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000);
PRAGMA user_version = 6;
```

### db.initialize-v6

源：经原始目录清单、身份检测和独占锁核验的空目录；目标：全新 v6 工作台，不接管未知或混合数据。SQL 定义全部表、字段、约束、索引、触发器及两项 PRAGMA。数据目录初始化必须使用 initialization.json、临时目标和刷新协议，不直接在正式位置执行本 SQL。

校验要求：全部表为空、结构匹配本 SQL、identity/version 正确、完整性与外键校验通过；中断可幂等完成且不删除来源不明的文件。

精确 SQL 文件：[db.initialize-v6.sql](./sql/db.initialize-v6.sql)

```sql

CREATE TABLE provider_settings (
 id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,
 models_json TEXT NOT NULL, default_model TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL
);
CREATE TABLE workflows (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version_id TEXT REFERENCES workflow_versions(id),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE workflow_versions (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), version_no INTEGER NOT NULL,
 definition_json TEXT NOT NULL, layout_json TEXT NOT NULL, artifact_path TEXT NOT NULL, content_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(workflow_id,version_no)
);
CREATE TRIGGER version_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END;
CREATE TRIGGER current_version_owner BEFORE UPDATE OF current_version_id ON workflows
 WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workflow_versions WHERE id=NEW.current_version_id AND workflow_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'version owner mismatch'); END;
CREATE TABLE drafts (
 id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(id), base_version_id TEXT REFERENCES workflow_versions(id),
 revision INTEGER NOT NULL, artifact_path TEXT NOT NULL, validation_json TEXT NOT NULL,
 published_version_id TEXT REFERENCES workflow_versions(id), status TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE authoring_turns (
 id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), provider_id TEXT NOT NULL REFERENCES provider_settings(id),
 model_id TEXT NOT NULL, provider_revision INTEGER NOT NULL, native_session_id TEXT, status TEXT NOT NULL,
 base_revision INTEGER NOT NULL, error_json TEXT, created_at INTEGER NOT NULL, ended_at INTEGER,
 conversation_id TEXT REFERENCES agent_conversations(id), backend_turn_id TEXT, connection_generation INTEGER,
 submission_state TEXT NOT NULL DEFAULT 'not_sent'
  CHECK(submission_state IN ('not_sent','sending','accepted','settled')),
 input_ref TEXT, result_ref TEXT
);
CREATE TABLE authoring_messages (
 id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), turn_id TEXT REFERENCES authoring_turns(id),
 sequence INTEGER NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 conversation_id TEXT REFERENCES agent_conversations(id),
 UNIQUE(draft_id,sequence)
);
CREATE TABLE agent_conversations (
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
 rebuild_from_id TEXT REFERENCES agent_conversations(id),
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
CREATE UNIQUE INDEX one_current_conversation
 ON agent_conversations(draft_id)
 WHERE status = 'current';
CREATE INDEX conversations_by_draft
 ON agent_conversations(draft_id,created_at,id);
CREATE INDEX conversations_by_activity
 ON agent_conversations(draft_id,updated_at DESC,id);
CREATE UNIQUE INDEX one_active_turn
 ON authoring_turns(draft_id)
 WHERE status IN ('queued','running','cancel_requested');
CREATE INDEX turns_by_conversation ON authoring_turns(conversation_id,created_at,id);
CREATE INDEX messages_by_conversation ON authoring_messages(conversation_id,sequence);

CREATE TABLE runs (
 id TEXT PRIMARY KEY, workflow_version_id TEXT REFERENCES workflow_versions(id),
 status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),
 input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,
 created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
 draft_id TEXT REFERENCES drafts(id), draft_revision INTEGER, snapshot_path TEXT,
 CHECK (
  (workflow_version_id IS NOT NULL AND draft_id IS NULL AND draft_revision IS NULL AND snapshot_path IS NULL)
  OR (workflow_version_id IS NULL AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND draft_revision >= 0 AND snapshot_path IS NOT NULL)
 )
);

CREATE INDEX queued_runs ON runs(status,created_at);
CREATE TABLE node_runs (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, type TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped','interrupted')),
 input_ref TEXT, output_ref TEXT, route_json TEXT, skip_reason TEXT, error_json TEXT,
 started_at INTEGER, ended_at INTEGER, UNIQUE(run_id,node_id)
);
CREATE TABLE node_attempts (
 id TEXT PRIMARY KEY, node_run_id TEXT NOT NULL REFERENCES node_runs(id), attempt_no INTEGER NOT NULL,
 status TEXT NOT NULL, execution_json TEXT NOT NULL, input_ref TEXT, output_ref TEXT, error_json TEXT,
 started_at INTEGER NOT NULL, ended_at INTEGER, UNIQUE(node_run_id,attempt_no)
);
CREATE TABLE stream_events (
 stream_type TEXT NOT NULL CHECK(stream_type IN ('run','authoring_turn')), stream_id TEXT NOT NULL, sequence INTEGER NOT NULL,
 event_type TEXT NOT NULL, node_id TEXT, attempt_id TEXT, payload_ref TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(stream_type,stream_id,sequence)
);
CREATE TABLE artifacts (
 id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,
 byte_size INTEGER NOT NULL, media_type TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE command_receipts (
 scope TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
 created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id)
);
CREATE TABLE scripts (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),
 status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
 current_draft_version_id TEXT, current_published_version_id TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
);
CREATE TABLE script_versions (
 id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), version_no INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
 entry_file TEXT NOT NULL, timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000), input_schema_json TEXT NOT NULL, output_schema_json TEXT NOT NULL,
 source_ref TEXT NOT NULL, content_hash TEXT NOT NULL, validation_json TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER,
 UNIQUE(script_id,version_no)
);
CREATE UNIQUE INDEX one_script_draft ON script_versions(script_id) WHERE status='draft';
CREATE TABLE script_tests (
 id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id), script_version_id TEXT REFERENCES script_versions(id),
 draft_revision INTEGER, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 input_ref TEXT NOT NULL, output_ref TEXT, error_json TEXT, stdout_ref TEXT, stderr_ref TEXT, exit_code INTEGER,
 duration_ms INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
 CHECK ((script_version_id IS NULL AND draft_revision IS NOT NULL AND draft_revision >= 0)
   OR (script_version_id IS NOT NULL AND draft_revision IS NULL))
);
CREATE INDEX script_versions_by_script ON script_versions(script_id,version_no DESC);
CREATE INDEX script_tests_by_script ON script_tests(script_id,created_at DESC);
CREATE TRIGGER script_draft_owner_insert BEFORE INSERT ON scripts
WHEN NEW.current_draft_version_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM script_versions WHERE id=NEW.current_draft_version_id AND script_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'script draft owner mismatch'); END;
CREATE TRIGGER script_published_version_immutable BEFORE UPDATE ON script_versions
WHEN OLD.status='published'
BEGIN SELECT RAISE(ABORT,'published script version is immutable'); END;
PRAGMA application_id = 1331110449;
PRAGMA user_version = 6;
```

## 历史证据与本次批准范围

- db.v1-v2 与 v6 初始化：现有 SQL 本次逐字节冻结，纳入上述会话批准。
- db.v2-v3：[会话设计第 20 节](../2026-11-04-agent-conversations/design.md#20-精确持久化提案与迁移)记录过历史批准；本次执行协议变更已纳入上述会话批准。
- db.v3-v4：[历史对话审核记录](../2026-11-04-agent-conversations/history-schema-proposal.md#10-审核记录)有历史结论；本次执行协议变更已纳入上述会话批准。
- db.v4-v5、db.v5-v6：[脚本库结构申请](../2026-11-06-script-library/schema-review.md)的历史状态不作为本次授权依据；本次精确 SQL 已纳入上述会话批准。
- 本次快照、安装、账本和恢复协议：已批准，原文与获批摘要保持一致。

## 审核记录

| 评审人 | 审核日期 | 审核范围及候选内容摘要 | 结论 |
| --- | --- | --- | --- |
| 用户（本会话明确确认） | 2026-11-06 | 上述 6 项数据库候选、配置转换及执行协议；摘要 `b4ab6ac54d809210022ed6e304de944931b2512388dae89933bc8962120d34a4` | 已批准 |

批准仅覆盖上述原始结构和协议字节。后续 SQL 或结构范围变更仍须重新审核。发布检查分别核验获批证据、全部实现依赖、冻结 bundle 和构建完整性；运行时发现包内容变化会保持业务门禁并报告 MIGRATION_PACKAGE_CHANGED。

## 当前可运行检查

```sh
node scripts/check-migration-manifest.mjs
node scripts/check-migration-manifest.mjs --require-review
```

两条检查均不执行数据库操作；第二条额外要求有效审核引用。本次均应通过，且已接入 npm run build、npm test 与 npm run dev。结构 SQL、执行依赖、历史基线或生成 bundle 的未登记变化会导致检查失败。验证结果另见 [验证记录](./verification.md)。
