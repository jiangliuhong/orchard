# 配置 Git 存储实施记录

日期：2026-11-06。按用户已确认的 [数据库审核](./schema-review.md) 实施。验收结果与限制见 [verification.md](./verification.md)。

## 实现范围

| 模块 | 职责 |
| --- | --- |
| `src/config-git/snapshot*.ts` | 五类配置 DTO、静态 TypeScript 解析、严格字段校验、manifest 摘要、依赖闭包及本机映射占位符；不执行配置或业务代码 |
| `repository.ts` | SSH/HTTPS 托管副本、固定 SHA、历史、脏工作区保护、提交预览、推送、分叉备份与重生成、崩溃回执 |
| `restore*.ts` | 兼容既有数据库约束的导入、完整不可变版本校验、独立恢复点、事务回执、文件向前补齐、浏览器常规偏好投递 |
| `coordinator.ts` | 单实例共享协调器，覆盖同步定义写入、完整异步活动周期、清理与恢复排他状态 |
| `service.ts`、`operations.ts`、`routes.ts` | API 编排、持久化操作状态、预览分页及脱敏、缺失映射与版本冲突、恢复/提交确认重放 |
| `cli.ts` | 服务端操作入口和纯文件离线校验；刷新 manifest 时保留其他文件原字节 |
| `ConfigGitSettings.tsx`、`theme.tsx` | 设置页面、操作轮询、完整差异分页、客户端身份与偏好修订、显式领取和冲突确认 |

业务服务接入共享协调器。服务器启动先恢复 Git 及配置事务，再执行业务恢复、实例缓存初始化及队列启动；失败时不激活业务服务。直接调用 app 的测试必须先等待 `app.ready()`。

新增 `rolldown@1.2.16` 作为静态解析运行依赖。保留原 lockfile 的平台依赖集合，只增加根 importer 引用。

## 持久化约束

未修改 `src/persistence/schema.ts`、已审核迁移 SQL、schema approval 或数据库版本；无新表、列、索引、触发器及新迁移声明。数据库写入继续使用现有表、事务与 request ledger。

Git 和恢复的运行状态位于隔离的 `config-git/` 文件树，恢复材料不依赖普通运行 staging 或将被清理的历史产物。数据库提交后的恢复只向前补齐文件，绝不拷贝旧数据库覆盖新事务。

`commit-intents/` 保存确认请求摘要、原始配置修订和常规主题，用于 API 回执未完成时跨实例恢复 Git 提交回执；正常完成后标记 completed，重放不会覆盖后来保存的主题。恢复确认可从持久化恢复回执继续，不依赖进程内预览 Map。

## 发布完整性

现有迁移发布工具锁定全部可执行依赖和本地源码，新模块与运行依赖加入后必须执行：

```sh
node scripts/lock-migration-release.mjs --refresh-unpublished
npm run migration:check
npm run build
```

该操作仅刷新未发布版本的依赖/源码完整性封套与生成文件，不修改已经审核的 schema 范围及迁移身份。最终 schema approval digest 保持 `b4ab6ac54d809210022ed6e304de944931b2512388dae89933bc8962120d34a4`。并行修改源码时完整性检查会主动失败，最终构建和验收必须在源码冻结后执行。

## 验证中修复的问题

- 启动恢复改为异步屏障后，11 处旧测试直接访问尚未初始化的服务；统一等待 `app.ready()`，新增成功和失败屏障验证。
- Git `push --porcelain` 的拒绝信息可能写到 stdout；同时检查两个有界输出流，实际 SSH hook 拒绝正确分类为 `PUSH_REJECTED`。随后补充真实 HTTPS 403 拒绝分类，修复后用严格 TLS 链路复测通过。
- API 原始差异可能绕过脱敏；返回结构只包含规范化的 `diffs/cumulativeDiffs`，历史和异常消息也经过处理。
- 分页需要同时追加当前差异与累计差异，UI 不能只追加一个集合。
- 固定 SHA 恢复预览只绑定本地 HEAD 和仓库身份，不因远端单独前进失效。
- 显式导出常规主题后持久化最新快照，其他浏览器才能主动领取。
- Git 提交和恢复确认通过持久化回执跨服务实例重放，保持同一 SHA 和操作结果；不同参数复用请求 ID 会被拒绝。
