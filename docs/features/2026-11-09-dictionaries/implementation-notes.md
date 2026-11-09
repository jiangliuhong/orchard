# 字典与加密字典实施记录

功能设计见 [design.md](./design.md)。本页记录实施进度与验证结果；v9 数据库结构已于 2026-11-09 审核通过（[schema-review-v9.md](./schema-review-v9.md)），任务 3 及任务 4 管理入口已实施；引用影响、执行与 Git 集成继续按 §12.1 推进。

## 任务 0：基线记录与发布完整性修复（2026-11-09）

实施前基线：

- 提交：`1c3758a28ab9eb23a99dae0fefb9f1f5a2a15ec6`
- 设计文档 SHA-256：`cd24b79a631feb51c57f92fa6a11e69eb2619728aba39a18e0b861f23bfae4e1`
- 数据库版本：`src/persistence/schema.ts` 为 v8，与设计 §1 一致

`npm run migration:check` 失败根因：提交 `1c3758a`（browser bridge 功能）修改了 `src/web/components/common.tsx` 等 9 个业务文件并向 manifest 补充了新增文件，但未同步刷新这些已改动文件的校验和（`common.tsx` 仍为旧字节摘要 `e1d9c666…`）。属设计 §12.2 所述"预期业务变动"，按既有未发布版本流程处理：

```bash
node scripts/lock-migration-release.mjs --refresh-unpublished
```

刷新只更新 fileChecksums、contentDigest 与 frozen.ts bundleChecksum；10 条迁移声明、审核记录与 schema approval 均未改动（逐行核对 diff 确认）。处理后 `npm run migration:check` 通过。

## 任务 1：基础契约（2026-11-09）

不涉及数据库结构的独立模块，与第 9.4 节审核并行：

| 契约 | 文件 | 说明 |
| --- | --- | --- |
| 规范化与严格解析 | `src/dictionaries/canonical.ts` | UTF-8 字节序排序对象键、无空白、负零归一、有限数字；`parseStrictJson` 拒绝重复对象键、深度超限与 BOM，未替换旧脚本/Git v1 算法 |
| 字典模型与限额 | `src/dictionaries/model.ts` | 名称/说明/键名/类型校验（码点计数）、单值 64 KiB、500 键、合计 1 MiB、JSON 深度 32、加密条目按密文字节计量、`portableContentHash` 排除本机 revision/versionNo/时间 |
| AEAD 封装与 AAD | `src/secrets/aead.ts` | AES-256-GCM、随机 12 字节 nonce、16 字节 tag；AAD 固定含 formatVersion/algorithm/keyId/dictionaryId/key/type；认证失败统一 SECRET_DECRYPT_FAILED，明文超限加密前拒绝 |
| 密钥材料校验 | `src/secrets/keys.ts` | keyId 规则、32 字节材料、规范 Base64 严格校验 |
| 密钥备份解析/合并 | `src/secrets/backup.ts` | formatVersion 1、未知字段/重复 keyId/非法编码整体拒绝、文件 ≤1 MiB、合并 ≤256 把、同 keyId 不同材料 SECRET_KEY_CONFLICT、序列化字节一致 |
| 同步入队保护 | `src/config-git/coordinator.ts` | `withAdmission(action)`：仅同步回调（Promise 返回视为编程错误）、与 activity 共存、与 reader/writer/另一入队/exclusive 互斥、不递增 generation；withRead/withWrite/withExclusive 增加入队占用检查 |
| prepare/attach 引用 | `src/persistence/store.ts` | `prepareReference` 事务外序列化，≤32 KiB inline，大值 staging 写入 + fsync + rename 安装到内容寻址路径 + fsync 父目录，复用已有文件校验字节与摘要；`attachPreparedReference` 仅在事务内校验描述并登记 artifacts 行；描述不含可变外部路径；原 `reference()` 未改动 |

新增测试 31 项：`tests/dictionaries-model.test.ts`、`tests/secrets.test.ts`、`tests/dictionaries-contracts.test.ts`。新增源文件已按流程刷新发布锁（迁移声明未变）。

## 验证结果（管理入口接入及复查后）

| 检查 | 结果 |
| --- | --- |
| `npm run migration:check` | 通过（12 条锁定声明，`a6d15b20…`） |
| `npm run typecheck` | 通过 |
| `npm test` | **492/492 通过**；0 失败、0 取消、0 跳过 |
| 字典专项测试 | 72/72 通过，覆盖领域/加密/迁移/服务/API/编辑器/密钥设置/CLI |
| `npm run build` | 通过（prebuild 含 migration:check；182 个编译产物锁定） |
| 编译后 CLI + 真实回环 HTTP | 两个隔离 data-dir：生成 → 导出 0600 文件 → 导入 → 状态/密钥材料一致性通过；终端输出不含材料；临时服务和文件已清理 |
| 历史身份 | 原有 10 条迁移声明逐项相等；v8 审核文件与原提交字节完全一致 |
| 文档与差异检查 | feature 相对链接有效；`git diff --check` 通过 |

早期全量运行出现的 Agent 失败进一步定位为测试注册与环境竞争：`agent-sessions.test.ts` 动态导入 `agent-transport.test.ts` 以复用夹具，导致其中测试嵌套注册并修改同一进程环境。已将夹具提取至普通辅助模块 `tests/agent-fixtures.ts`，更新全部复用位置。相关 53 项 Agent/Provider 测试通过；正常 `npm test` 随后全量通过。测试总数从该阶段的 504 减至 484，原因是移除了 20 次重复注册，未删除或跳过原有断言。数据库负向断言也改为直接 `assert.throws`，避免误捕获断言自身的错误。

## 任务 2：数据库结构审核（2026-11-09，已通过）

- 审核人：用户；日期：2026-11-09；审核前设计文档基线 SHA-256 `6ccda119…`；结论：**通过**
- 独立冻结审核记录：[schema-review-v9.md](./schema-review-v9.md)（含结构与语义实测结果）；审核归档：[schema-approval-v9.json](./schema-approval-v9.json) 新增 `db.v8-v9`、`db.initialize-v9` 两条已审核条目及本轮 review 记录；v8 原归档保持原始字节
- 归档条目钉定 `schema-review-v9.md` 与 SQL 文件字节；design.md 后续阶段演进不改变获批 DDL 身份

## 任务 3：增量迁移与持久化（2026-11-09）

| 变更 | 文件 | 说明 |
| --- | --- | --- |
| v8→v9 迁移与 v9 初始化 | `docs/features/2026-11-06-data-migration/sql/db.v8-v9.sql`、`db.initialize-v9.sql` | 与 `MIGRATE_V8_TO_V9`、`SCHEMA` 字节一致；DDL 按审核候选原样执行，未修改外键、触发器或删除语义 |
| schema 常量 | `src/persistence/schema.ts` | `SCHEMA_VERSION = 9`；新增 `DICTIONARY_SCHEMA`、`MIGRATE_V8_TO_V9`；`SCHEMA` 追加字典表 |
| 冻结基线 | `tests/fixtures/migrations/database/v9.sql` | fixture v8 累加迁移，两路径对象一致（44 个） |
| 发布封装 | `migration-manifest.json`、`src/migrations/frozen.ts`、`schema-approval-v9.json` | 12 条锁定声明；历史条目身份未变 |
| 迁移与结构验证 | `tests/dictionaries-schema.test.ts`（新增 5 项） | 冻结 SQL 常量一致；新建库与 v8 升级库一致（旧行保留、新表为空）；延迟指针外键同事务创建/悬空拒绝/名称不一致拒绝；不可变触发器；跨表 kind 一致；NOCASE 重命名冲突；绑定表伪造归属拒绝、keys_json 非空数组、script_tests 删除级联 |
| 链延伸适配 | `agent-model-configs`、`store`、`models`、`server`、`migration`、`migration-manifest` 测试 | 既有"链终点"断言从 v8 更新到 v9、表数 19→23、锁定声明数 10→12；历史版本库改用冻结 fixture v7 构造；验证内容未弱化 |

校正早期探针记录：SQLite 在显式 COMMIT 和 autocommit 语句提交时都会检查延迟外键。早期手工探针在失败 COMMIT 后未 ROLLBACK，后续语句仍处于未提交事务，因而误判为 autocommit 不检查；独立内存库已确认 autocommit 同样拒绝悬空外键。冻结审核记录保留当时记录，本段明确修正其测试结论；获批 DDL 和全部业务写入经 Store 显式事务的契约不变。

## 任务 4：密钥与字典管理（进行中）

### 本轮已实施：密钥环、HMAC 回执与管理服务（2026-11-09）

| 契约 | 文件 | 说明 |
| --- | --- | --- |
| 密钥环文件存储 | `src/secrets/keyring.ts` | `<data-dir>/secrets/keyring.json`（`ORCHARD_SECRET_KEYRING_FILE` 绝对路径覆盖，禁入 Git 目录）；目录 0700/文件 0600、拒绝符号链接与宽松权限；代次、活动密钥与本机操作记录一次原子替换；落盘前严格解析自检；写入幂等（同 requestId 同 HMAC 返回原结果，不先拒代次）、无变化不递增代次但持久化首次回执、只读存储拒绝新写入且不回退建环 |
| 敏感命令回执 | `src/secrets/command-hmac.ts` + `Store.sensitiveCommand` | HMAC-SHA-256(localKey, canonical({protocol, scope, request}))；scope 限定 `dictionary-secret:*`/`secrets:*`；HMAC 密钥文件首次敏感写入前在 withWrite 内原子创建，已有敏感记录而文件缺失/损坏返回 SECRET_RECEIPT_KEY_MISSING；密钥环回执存文件、字典加密写回执存数据库，两套不互相替代 |
| 密钥设置服务 | `src/secrets/service.ts` | 状态/生成/导入/备份/验证/切换活动密钥；expectedGeneration + requestId 幂等；导入合并语义（同材料无变化、异材料 SECRET_KEY_CONFLICT、空环须明确活动密钥）；验证逐条认证解密只返回成功数/缺失 keyId/失败位置，验证期间变化返回 PREVIEW_EXPIRED；常规响应只含安全元数据 |
| 字典管理服务 | `src/dictionaries/service.ts` | CRUD/禁用（§10.2 操作数组语义：未提及键保持原值、重复操作拒绝）；expectedRevision 并发冲突；完全相同保存无变化不产生修订；普通写走 SHA-256 命令、加密写走 HMAC 敏感命令；显式替换加密值生成新密文、未触及键复用封装；移除被引用键返回 CONFIRMATION_REQUIRED + 绑定请求/引用摘要的 10 分钟令牌；换钥先预览（token 绑定内容摘要/配置/密钥代次/文件指纹），全部认证成功才产生新修订，已匹配条目复用封装，同 requestId 回执优先；视图对加密条目只显示键名/类型/keyId，不出密文明文 |

新增测试 13 项（`tests/dictionaries-service.test.ts`）：密钥环原子写入/权限/代次/幂等/只读、HMAC 创建与缺失拒绝、敏感命令白名单与回执、密钥服务全操作与冲突、字典普通/加密 CRUD、无变化保存、明文不出库（含回执）、确认令牌、换钥全流程、验证安全诊断。

### 管理入口与复查修复

- `src/dictionaries/routes.ts` 在独立 Fastify 作用域注册管理路由。严格 JSON 解析在对象转换前拒绝重复键；旧接口保留原解析方式。未知请求字段/查询参数被拒绝，密钥错误响应不返回解析器原始消息或片段，敏感响应设置 no-store。
- 敏感变更、验证与备份要求完全相同的本地 Origin/authority（含端口）与一致的 Sec-Fetch-Site；无 Origin 时必须提供本机令牌。不使用转发头放宽边界。备份为同源 POST attachment，唯一返回密钥材料的专用端点。
- 主导航 `/dictionaries` 支持类型筛选和分页。详情提供名称/说明、键值编辑、启用/禁用、历史修订查看和换钥。普通值严格区分 string/number/boolean/json；敏感条目显式选择保持/替换/移除，允许替换为空字符串，提交后清空表单及请求重试缓存。
- 设置页增加“加密字典密钥”，支持生成、文件/文本导入、验证、切换以及确认范围后下载全部密钥。空环导入必须由请求显式选择活动密钥，备份 activeKeyId 只作建议。取消或成功导入时清空临时文本，不写浏览器持久化存储。
- CLI `orchard secrets keyring status|init|import|export|verify|activate` 调用已有服务的认证 API。导出读取实际 HTTP 备份 JSON，写 0600 文件，不覆盖已有文件或输出材料。真实 API → CLI 导出 → 隔离实例 CLI 导入测试通过。
- 修复跨字典更新请求的幂等摘要遗漏 dictionaryId、列表游标跳项、JSON 原型键处理/控制字符解析；密钥路径逐级拒绝符号链接，拒绝 config 与 config-git 目录覆盖，宽松权限文件/父目录在写入前拒绝。
- v9 审核移至独立 feature 归档；发布脚本显式引用该归档，逐项比对确认原有 10 条迁移声明及 v8 审核文件的原始字节均保留。

### Review 问题修复

- 条目编辑器统一保存新增键、已有修改和待移除键；有其他修改时按钮标明“添加并保存修改”。保存失败保留全部输入，新增同名键时提示编辑已有条目，避免覆盖。
- 字典列表与详情使用当前完整密钥快照逐条认证密文，只有认证通过才标记 ready；新增 authentication-failed 和 keyring-unavailable 状态及列表筛选，页面展示具体原因并链接密钥设置。密钥环异常只影响加密字典可用性，普通字典列表、读取和编辑继续可用。
- 新增 8 项回归测试，覆盖普通/加密条目合并保存、失败保留输入、同名键保护、错误材料及恢复、密钥环损坏/权限异常、状态展示与过滤；现有篡改密文测试增加就绪状态断言。相关 API、编辑器、服务和密钥设置测试 30/30 通过，类型检查通过。
- 刷新当前未发布版本的源码校验封装；刷新前后 12 条迁移声明及 review 记录逐项一致，未改动 DDL、SQL 或审核资源。最终迁移检查、类型检查、全量测试（492/492）、构建与差异格式检查通过。

### 待完成的集成与验收

- 真实引用扫描仍待任务 5 接入。`GET /references` 明确返回 `complete: false`，当前不声称已找到全部引用；移除键的影响确认已有可注入服务测试，但实际引用影响尚不可用。
- 工作流/脚本依赖、执行时绑定与敏感策略、Git v2 均未接入；本阶段管理页面不表示可以运行加密依赖。
- 故障注入（密钥文件替换前后中断恢复）、两设备真实浏览器与 Git 往返留待后续验收，本轮没有执行真实浏览器验收。

### 已知行为与边界

- 预览/确认令牌存于服务进程内存，服务重启后失效需重新预览（与 config-git 预览一致）
- 密钥环只读测试保留注入探针；生产检查同时考虑 owner 写权限位和系统可写性，父目录及文件权限在落盘前验证
- 换钥预览不进入 withWrite（避免自身递增配置代次使 token 自失效）；执行侧校验全部基线，预览后任何配置写入都会要求重新预览

## 待办与门槛

- 管理入口已实现；任务 4 的引用影响与故障恢复验收仍待完成。继续任务 5–8：定义与创作、执行与敏感策略、Git v2、完整验证与文档
- 加密依赖执行门槛：阶段 6 完成前，声明加密依赖的运行/测试入口返回固定 FEATURE_NOT_READY（§12.1）
