# 字典功能数据库结构 v9 审核记录

状态：已审核冻结。本文为 v9 结构审核的独立归档，批准后不再修改；功能设计的后续演进在 [design.md](./design.md) 进行，不改变已获批的 DDL 与迁移身份。

## 审核记录

- 审核人：用户
- 日期：2026-11-09
- 方式：用户在本会话对第 9 节审核候选明确回复"确认"
- 审核前设计文档基线（SHA-256）：`6ccda119039ea7bd42aa9eceb4af6cd8820cb5c95b886e16e95faa1ceb3ea7d6`
- 审核范围：[design.md 第 9 节](./design.md#9-数据库结构审核候选)完整 DDL 候选（四张表、两个显式索引、三个触发器）、第 9.3 节事务/迁移/清理执行契约、发布清单计划
- 结论：**通过**。实现与第 9.2 节候选原样一致，未修改外键、触发器或删除语义

## 获批条目

| 条目 | 源 → 目标 | 摘要 |
| --- | --- | --- |
| `db.v8-v9` | 8 → 9（requires `db.v7-v8`） | 字典、加密字典与运行/测试字典绑定四张表；延迟当前指针外键、版本不可变触发器与对象身份不可变触发器 |
| `db.initialize-v9` | 空目录 → 9 | 已审核 v9 结构的新库初始化（含字典表） |

精确字节以 [schema-approval-v8.json](../2026-11-06-data-migration/schema-approval-v8.json) 条目 checksum 为准；SQL 文件为 [`db.v8-v9.sql`](../2026-11-06-data-migration/sql/db.v8-v9.sql) 与 [`db.initialize-v9.sql`](../2026-11-06-data-migration/sql/db.initialize-v9.sql)，分别与 `src/persistence/schema.ts` 导出的 `MIGRATE_V8_TO_V9`、`SCHEMA` 字节一致。

## 结构与语义验证（2026-11-09 实测）

- 新建库（`db.initialize-v9.sql`）与 fixture 基线（v8 累加迁移）产生一致的 44 个 schema 对象；`integrity_check` ok，`foreign_key_check` 空。
- 延迟当前指针外键：同事务创建对象与首版提交成功；悬空 `current_version_id` 在 COMMIT 拒绝；对象 `name`/`kind` 与指针目标不一致在 COMMIT 拒绝。已知 SQLite 行为：autocommit 单语句不触发延迟外键检查，全部字典写入必须经 Store 显式事务（设计 §9.3 契约），不提供 autocommit 写路径。
- 版本不可改写：`UPDATE`/`DELETE dictionary_versions` 触发 `DICTIONARY_VERSION_IMMUTABLE`；对象身份不可变：改 `id`/`kind` 触发 `DICTIONARY_IDENTITY_IMMUTABLE`。
- 跨表 kind 一致外键：版本 kind 与对象不一致拒绝。
- 名称唯一性：NOCASE 重命名/插入冲突拒绝，未 trim 名称拒绝。
- 绑定表：伪造 `run_id` 拒绝；`keys_json` 必须为非空数组；`entries_json` 必须为对象。
- 指针回切：新版本仅分配 `version_no=MAX+1`，恢复旧版本仅 UPDATE 对象并递增 `revision`。
