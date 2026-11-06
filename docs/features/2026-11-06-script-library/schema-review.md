# 脚本库数据库结构审核申请

状态：待审核

日期：2026-11-06

本文只申请审核数据库结构，不执行迁移。根据仓库根目录 `AGENTS.md`，涉及表、字段、索引、外键或迁移的实施必须在审核通过后进行。

## 目标

为脚本库保存脚本稳定身份、可编辑草稿、不可变发布版本和测试记录，同时保证工作流发布版本引用的脚本版本不会被修改或删除。

## 拟新增表

### `scripts`

```sql
CREATE TABLE scripts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  runtime TEXT NOT NULL CHECK(runtime IN ('nodejs','shell')),
  status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
  current_draft_version_id TEXT,
  current_published_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
```

### `script_versions`

本次审核追加字段 `timeout_ms`，使每个不可变脚本版本携带正式运行时限。取值范围为 1 秒至 5 分钟；未显式指定时写入现有执行器默认值 300000 毫秒。工作流节点可以进一步缩短这个上限，但不能放宽它。

```sql
CREATE TABLE script_versions (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL REFERENCES scripts(id),
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','published')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  entry_file TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000),
  input_schema_json TEXT NOT NULL,
  output_schema_json TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE(script_id, version_no)
);
```

`source_ref` 指向宿主管理的不可变文件树，不接受前端任意路径。源码内容继续使用现有受控文件存储的路径和摘要机制；如果审核认为源码应直接落库，再调整为受限 JSON 或 BLOB 字段。

建议约束：

```sql
CREATE UNIQUE INDEX one_script_draft
  ON script_versions(script_id) WHERE status='draft';

CREATE TRIGGER script_published_version_immutable
BEFORE UPDATE ON script_versions
WHEN OLD.status='published'
BEGIN SELECT RAISE(ABORT,'published script version is immutable'); END;
```

`scripts.current_draft_version_id` 和 `scripts.current_published_version_id` 需要通过应用事务校验属于同一 `script_id`；如果 SQLite 外键无法表达该组合约束，使用触发器补充校验。

### `script_tests`

```sql
CREATE TABLE script_tests (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL REFERENCES scripts(id),
  script_version_id TEXT REFERENCES script_versions(id),
  draft_revision INTEGER,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  input_ref TEXT NOT NULL,
  output_ref TEXT,
  error_json TEXT,
  stdout_ref TEXT,
  stderr_ref TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
```

草稿测试使用 `script_version_id IS NULL` 和 `draft_revision >= 0`；已发布版本测试使用非空 `script_version_id` 和 `draft_revision IS NULL`。建议增加 CHECK，确保两种记录形态互斥。输入、输出和日志使用现有 artifact/reference 存储，避免将大字段直接写入业务表。

## 工作流引用

工作流版本中的 `definition_json` 保存明确的 `scriptId` 与 `scriptVersionId`，以保持整个工作流定义快照自包含。第一阶段不新增工作流引用表，发布工作流时由应用校验脚本版本存在、属于指定脚本且状态为 `published`。

如果后续需要查询“哪些工作流引用了某个脚本版本”，再新增反向索引表；当前通过版本定义扫描即可满足功能需求，避免首期扩大迁移范围。

## 本次追加迁移申请

- schema 版本从 5 升至 6。
- 对新库在 `script_versions` 中直接创建 `timeout_ms` 字段。
- 对已有 v5 数据库执行 `ALTER TABLE script_versions ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000)`；历史版本使用现有执行器默认上限 5 分钟，不改变已发布脚本的行为。
- 更新 `ScriptVersion`、创建/编辑/发布和测试执行读取逻辑，并在工作流运行时使用 `min(version.timeoutMs, node.config.timeoutMs ?? version.timeoutMs)`。
- 增加迁移等价性、范围校验、工作流节点不能放宽脚本超时的测试。

## 迁移和删除规则

- 新增 schema 版本，沿用现有 `src/persistence/schema.ts` 的迁移模式。
- 新库和旧库升级后的 `sqlite_master` 结构必须一致。
- 删除脚本采用归档；脚本版本只允许在没有工作流版本引用、没有测试保留要求时清理。
- 脚本库删除不能级联删除工作流版本或运行记录。
- 迁移前备份数据库，迁移失败必须保持原数据库可恢复。
- 补充 Store 测试覆盖外键、唯一草稿、已发布版本不可变和升级等价性。

## 审核重点

1. 是否同意 `scripts`、`script_versions`、`script_tests` 三张表的职责拆分。
2. 是否同意源码通过现有文件存储引用保存，而非直接写入数据库。
3. 是否同意工作流首期只在 `definition_json` 中保存脚本版本引用，不新增反向引用表。
4. 是否需要保留测试日志和输出的引用，及其清理周期。
5. 是否接受使用部分唯一索引保证一个脚本最多一个草稿版本。
