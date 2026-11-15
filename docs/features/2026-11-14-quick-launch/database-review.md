# 快速执行与统一运行记录数据库审核稿

状态 **方案审核通过，DDL 候选已提交复核** · 2026-11-14 · 基线 SQLite v11，候选 v12。原型审核已通过。本稿供审核结构、回填、切换与恢复方案，实施和实际迁移另行授权。最终版本号以仓库发布时的基线为准。

产品契约见[设计文档](./design.md)，交付批次见[实施任务](./coding-tasks.md)。快照及安装复用[现有迁移执行协议](../2026-11-06-data-migration/execution-protocol.md)。当前版本取自 `src/persistence/schema.ts`，旧数据来自 `runs`、`script_tests` 和 `runtime/bridge-history.json`。

## 1. 拟新增结构

以下是供审核的列和约束定义。ID、枚举和 JSON 使用 TEXT，修订、序号、次数和 UTC 毫秒时间使用 INTEGER。除标记可空外均为 NOT NULL。每张表的 id 为主键。应用层严格解析 JSON，并依据列要求校验对象或任意合法 JSON。

| 表 | 列 |
| --- | --- |
| `quick_launch_groups` | id、name、name_key、parent_id（可空）、revision、created_at、updated_at |
| `quick_launches` | id、name、note、group_id（可空）、target_json、fixed_input_json、input_sources_json、revision、created_at、updated_at |
| `execution_records` | id、parent_execution_id（可空）、launch_id（可空）、source、target_kind、request_scope、request_id、request_digest、config_revision（可空）、snapshot_ref、underlying_kind、underlying_id（底层两列同为空或同非空）、status、privacy_policy、accepted_at、started_at、ended_at（后二者可空）、safe_error_json（可空）、output_availability、last_event_sequence、ended_tracking_reason（可空） |
| `execution_outbox` | id、execution_id、operation、sequence、state、attempts、claim_token（可空）、lease_until（可空）、created_at、updated_at |

- 分组 parent_id 指向分组，卡片 group_id 指向分组，均使用 RESTRICT。删除事务先迁移卡片，再从叶到根删除分组。分组自指由 CHECK 拒绝。应用层在写事务内校验无环、最多五层及预览涉及的组和卡片集合未变化。全部可能改树的写路径执行同一校验。
- name_key 采用应用统一的 NFC 与去首尾空白，区分大小写。顶层按 name_key 唯一，非顶层按 (parent_id, name_key) 唯一，分别使用部分唯一索引覆盖 SQLite 的 NULL 行为。父级及卡片 group_id 建索引。名称长度与斜杠限制按主设计校验。revision 起始为 1，更新递增，变更以旧 revision 为条件。
- 执行记录的 parent_execution_id 指向父记录，删除约束 RESTRICT。launch_id 指向卡片并 ON DELETE SET NULL，安全快照保留原卡片 ID。执行记录通过 (underlying_kind, underlying_id) 关联底层，首期无需修改 runs、script_tests 或节点表。多态引用由同事务创建或经可验证的历史导入建立，底层记录清理可保留关联 ID，并明确标记输出不可用。
- 执行记录设 (request_scope, request_id) 唯一键，以及底层二元组非空唯一索引。按 (accepted_at DESC, id DESC) 建顶层部分索引，另建 (parent_execution_id, accepted_at, id) 和 (launch_id, accepted_at, id) 索引。卡片活动记录部分唯一索引覆盖 accepted、queued、running、cancel_requested、unknown。状态取主设计枚举，事件序号只增不减。按模拟频率及查询计划评估其他筛选索引。
- Outbox 引用 execution_id，使用 RESTRICT。设 (execution_id, operation, sequence) 唯一约束及 (state, lease_until, created_at, id) 领取索引。state 取 pending、claimed、dispatching、settled。领取和续租通过 claim_token 条件写，过期工作者无法覆盖新持有者状态。持久化 dispatching 后才调用外部工具，租约过期不得直接重派该状态。
- 卡片变更回执复用 command_receipts，启动幂等由 execution_records 承担。同一接收请求重试比较规范化请求摘要，REVISION 检查只用于新请求。确认和删除预览使用有期限且绑定请求/配置摘要的签名凭证，不另建表。环境允许名单属于本机设置，不写入运行数据库。
- snapshot_ref 纳入既有产物引用扫描。快照含安全手动输入、引用描述及目标与分组摘要。迁移回填只取允许的安全元数据，不复制旧输入、凭据、输出正文或原始错误；详情沿用底层权限和脱敏策略。resolved values 不进入任何新增表、派发载荷、回执或日志。清理底层产物时保留运行摘要，区分未记录、受限、已清理和可用。

## 2. 回填和安装

1. **只读预览。** 校验 application_id、user_version、已冻结 v11 结构与发布账本，检查数据库完整性、外键及旧浏览器历史格式。统计各来源、活动任务、无法关联记录和产物引用，输出脱敏计数、源指纹和备份空间估算。格式未知或数据损坏时进入人工核对。旧版本按既有链路升级，旧浏览器历史缺失允许按零条处理。
2. **静默窗口与备份。** 停止接收新任务，等待工作流、脚本及浏览器活动清零；存疑外部请求必须先查证并纳入预览。持有数据目录独占锁，重新核对源指纹。用现有迁移引擎生成可恢复快照，包含一致性 SQLite 副本、旧浏览器历史及相关配置、账本和受管产物。关闭连接并按现有协议处理 WAL/SHM。
3. **在副本增加四表与索引。** 保持旧表、约束和业务行。经预览确认在隔离副本按来源分批回填，以底层类型与 ID 确定统一记录 ID 和合成的历史请求标识。重复导入只校验/合并同一来源身份，回填不建立 outbox 派发意图。空库安装初始化同一结构。
4. **来源映射。** runs 导入正式及草稿运行，script_tests 导入发布版及草稿测试，按已有状态及时间映射。浏览器以原历史 ID 导入成功或失败摘要，使用原始 startedAt 和 durationMs，创建时间未知则以已有开始时间回退并注明。源入口、父子关系或版本无法证明时标记历史未知。重复底层身份内容冲突时暂停核对，不按名称或时间猜测关联。只导入当前仍存在的历史，浏览器旧轮转已删除的条目无法回填。
5. **验证后安装。** 核对各来源“已映射 + 明确拒绝”的计数、外键、唯一约束、旧表逻辑行摘要以及引用可访问性。存在拒绝项时暂停并报告，不静默掉记录。副本通过检查后再推进版本及账本，按现有阶段日志安装。切换后全部新运行使用统一接收登记，网页桥接历史 UI 读统一记录，旧文件作为受限只读备份保留。SQLite 与文件备份使用同一迁移清单。
6. **恢复。** 安装或提交中断时按迁移阶段日志验证后恢复完整源快照。激活后如需降级，先停写，预览新写入及外部副作用，明确快照恢复会失去的记录后再授权。恢复旧数据库、旧浏览器历史、配置及受管产物，并用 v11 验证可读。不计划用反向 DDL 删除新表来降级。

## 3. 运行时一致性和审核验收

接收记录先持久提交。校验通过后，同事务写入底层任务关联与派发意图，再允许工作者派发。浏览器外部调用前持久化稳定 bridgeCallId。收到结果后用同一执行 ID 更新状态，写入失败只重试记录写入。有外部副作用且结果未知时进入 unknown，释放占用须查证或执行用户确认的结束追踪。仅确定未派发且能恢复原输入的任务可重新领取。引用解析结果丢失时按设计中断或待确认。

验收包括 v11 升级与全新安装结构一致、历史重复回填、超过 500 条后仍可分页、未知来源/父级保留、到期预览和分组并发、跨连接请求去重、派发前后崩溃与重启、无敏感值落盘、引用清理、失败恢复及版本复验。拟审核范围为四表与索引、旧表零 DDL、快照和历史映射、切换停写窗口及恢复策略。后续按仓库现行流程提交精确 DDL、冻结初始化/升级差异、候选摘要与验证证据；本稿不签发批准记录。
