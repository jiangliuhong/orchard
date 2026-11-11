# 统一 Agent Runtime 数据库变更审核候选

- 状态：**用户已批准，结构与持久化层编码/测试中，尚未激活生产迁移**。审批依据：本会话用户明确回复“批准”；见 schema-approval.json。
- 基线：当前源码 `src/persistence/schema.ts` 的 SCHEMA_VERSION=10；合并时重新确定目标版本，不提前占号。
- 产品基线：design.md 最新直接删除决策；没有归档、恢复已删对话或历史重建。
- 批准范围为本文九表、字段/索引/触发器、旧 Agent 重置边界与备份回滚的编码。实际升级旧数据仍须另外确认；此次审批不授权直接重置已有用户数据库。
- 目前实现独立 SQL、AgentStore 及 v10→v11 数据库重置步骤；未切换全局 SCHEMA_VERSION 或启用旧/新双写，迁移注册需与运行时切换一同完成。

## 1. 审核范围与固定选择

1. 重建现有 `agent_conversations`，统一三个维护场景与其他 single 系统调用。
2. 移除旧 `authoring_turns`、`authoring_messages`；新建统一 turns/events/backends/operations/feedback/workspaces/runtime_resources/knowledge_installation 八张表，加上重建的 conversations，共九张表。旧对话不迁移。
3. `scenario`、`owner_type`、Provider ID 均为开放字符串，不在数据库固化 Codex/Pi 类型或路径字段。
4. owner 不是工作流外键：以 `actor_key + scenario + owner_type + owner_id + owner_scope_json` 固定绑定，由场景 authorizer 检查业务对象；避免删除业务对象反向级联清空对话、导致原生会话引用丢失。当前单机 actor_key 使用现有本地身份，不虚构多租户 ACL。
5. 业务数据不增加指向可删对话/turn 的强依赖。保留必要业务溯源 ID/应用 revision，不保留对话正文来维持业务记录。
6. 可删除对话内容与不可重放的最小删除回执分开。操作回执不保留 prompt/result；无定时清理任务。
7. Native backendRef 外层 providerId、version、opaque 为 JSON；Provider 私有 storeId 持久绑定受管存储。Runtime 不解释 opaque 中 CLI ID、路径或文件格式。
8. 敏感/禁存 single 不创建可恢复原生会话，不把其 prompt/result/events 正文落库。维持原场景的更严格历史策略；native multi 不接纳禁存请求。

## 2. 具体表结构

通用约定：时间为 INTEGER epoch 毫秒；revision/generation/sequence 使用 `typeof(...)='integer'` 与范围 CHECK；UUID 为服务端生成的 TEXT。JSON 使用 `json_valid` 后的 CASE 检查类型，避免非法 JSON 调用 json_type 导致意外错误。路径仅为服务端生成的受控相对路径，不在表中接受客户端 cwd。

### 2.1 agent_conversations（替换旧表）

| 字段 | 类型/约束 |
|---|---|
| id | TEXT PRIMARY KEY |
| actor_key | TEXT NOT NULL，非空 |
| scenario | TEXT NOT NULL，长度 1–100 |
| owner_type / owner_id | TEXT NOT NULL，分别长度 1–100 / 1–200 |
| owner_scope_json | TEXT NOT NULL，JSON object，仅身份/版本范围，不含草稿或凭据 |
| mode | TEXT NOT NULL，CHECK IN ('single','multi') |
| provider_id | TEXT NOT NULL REFERENCES provider_settings(id)，不级联删除 |
| current_model_id | TEXT NOT NULL，非空 |
| knowledge_hash | TEXT NULL；非空时为 64 位小写 hex |
| contract_version / tool_policy_version | TEXT NOT NULL，非空 |
| workspace_id | TEXT NULL REFERENCES agent_workspaces(id)，不级联删除 |
| lifecycle | TEXT NOT NULL CHECK IN ('active','deleting') |
| usability | TEXT NOT NULL CHECK IN ('usable','knowledge_outdated','backend_unavailable','owner_unavailable') |
| revision | INTEGER NOT NULL >0 |
| title | TEXT NULL，长度 1–200 |
| created_at / updated_at | INTEGER NOT NULL |

额外约束：UNIQUE(id,mode)、UNIQUE(id,provider_id)。multi 必须有 knowledge_hash 和共享 workspace_id；single 可没有维护知识。id/actor/owner/scenario/mode/provider/knowledge_hash/契约及策略版本在创建后不可改；知识升级改变 usability，不偷偷改旧对话 hash。

没有 archived_at、rebuild_from_id、context_mode、native_session_id、threadId 或 sessionFile 通用字段。

### 2.2 agent_turns

| 字段 | 类型/约束 |
|---|---|
| id | TEXT PRIMARY KEY |
| conversation_id / mode | TEXT NOT NULL；复合 FK REFERENCES agent_conversations(id,mode) ON DELETE CASCADE |
| sequence | INTEGER NOT NULL >0；single 时 CHECK sequence=1 |
| request_id | TEXT NOT NULL，长度 1–200 |
| request_hash | TEXT NOT NULL，64 位 hex；敏感请求使用既有 HMAC 策略而非明文摘要 |
| status | TEXT NOT NULL CHECK IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted') |
| submission_state | TEXT NOT NULL CHECK IN ('not_sent','sending','accepted','settled') |
| requested_model_id | TEXT NOT NULL |
| actual_model_id / model_source | TEXT NULL；model_source 非空时 IN ('requested','reported','unknown') |
| generation | INTEGER NOT NULL >=0 |
| input_ref / proposal_ref / error_json | TEXT NULL；引用内容受既有敏感保留策略约束；error_json 非空时为 object |
| base_revision | TEXT NULL；规范化字符串，支持整数 revision 或浏览器定义内容 hash，不由模型猜测替代查询证明 |
| read_baselines_json | TEXT NOT NULL DEFAULT '{}'，JSON object；记录本轮宿主查询所得资源身份/revision，不存源码副本 |
| apply_status | TEXT NOT NULL CHECK IN ('not_applicable','pending','applied','rejected','failed') |
| outcome_ref | TEXT NULL；仅关联宿主确认的业务应用结果 |
| created_at | INTEGER NOT NULL |
| started_at / ended_at | INTEGER NULL |

UNIQUE(conversation_id,sequence)、UNIQUE(conversation_id,request_id)、UNIQUE(id,conversation_id)。request_hash 不能因 retry 覆盖；sending/accepted 未确认结果的请求不自动重发。

single 的唯一逻辑轮次不允许单独删 turn 后再插入：触发器禁止在父对话 lifecycle!='deleting' 时删除 single turn，且禁止更新 turn 的 id/conversation_id/mode/sequence/request_id/hash。对话删除事务先置 deleting，再删除内容。

### 2.3 agent_events（包含消息与状态事件）

| 字段 | 类型/约束 |
|---|---|
| conversation_id | TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE |
| sequence | INTEGER NOT NULL >0 |
| event_id | TEXT NOT NULL UNIQUE |
| turn_id | TEXT NULL；复合 FK (turn_id,conversation_id) REFERENCES agent_turns(id,conversation_id) ON DELETE CASCADE |
| operation_id | TEXT NULL REFERENCES agent_operations(id)，不级联删除 operation |
| generation | INTEGER NOT NULL >=0 |
| type | TEXT NOT NULL，非空 |
| role | TEXT NULL，非空时 IN ('user','assistant','host','system') |
| payload_ref | TEXT NULL；按敏感策略过滤，工具源码和原始诊断不默认广播/存消息副本 |
| created_at | INTEGER NOT NULL |

PRIMARY KEY(conversation_id,sequence)。对话游标统一按 sequence 分页，不从展示消息重建 CLI 历史。操作删除回执单独保留，不依赖已删除 events。

### 2.4 agent_backends

| 字段 | 类型/约束 |
|---|---|
| conversation_id | TEXT PRIMARY KEY |
| provider_id | TEXT NOT NULL；复合 FK (conversation_id,provider_id) REFERENCES agent_conversations(id,provider_id) ON DELETE CASCADE |
| ref_version | INTEGER NOT NULL >0 |
| reference_json | TEXT NOT NULL，JSON object，外层恰好 providerId/version/opaque；providerId/ref_version 与列值一致 |
| fingerprint | TEXT NOT NULL，64 位 hex，不包含模型凭据 |
| generation | INTEGER NOT NULL >0 |
| health | TEXT NOT NULL CHECK IN ('available','unknown','unavailable') |
| native_delete_state | TEXT NOT NULL CHECK IN ('present','pending','unknown','absent') |
| updated_at | INTEGER NOT NULL |

reference_json UTF-8 上限 64 KiB；外层字段合法、payload/路径/存储身份由 Provider 强校验。插入/更新触发器要求父对话 mode='multi'；single 不落持久 backendRef。更新必须 generation/revision CAS，不得以 <= generation 允许陈旧回调覆盖。

### 2.5 agent_operations（含删除回执）

| 字段 | 类型/约束 |
|---|---|
| id | TEXT PRIMARY KEY |
| conversation_id | TEXT NULL REFERENCES agent_conversations(id)，默认 NO ACTION；完成删除时显式置 NULL |
| subject_id | TEXT NOT NULL；原 conversation UUID/系统操作 ID，非 FK，用于删除后的幂等归属，不含业务正文 |
| actor_key | TEXT NOT NULL |
| kind | TEXT NOT NULL CHECK IN ('turn','delete','switch_model','knowledge_install') |
| request_id / request_hash | TEXT NOT NULL；hash 为 64 位 hex |
| expected_revision / expected_generation | INTEGER NULL；非空时分别 >0 / >=0 |
| status | TEXT NOT NULL CHECK IN ('pending','running','unknown','failed','succeeded') |
| phase | TEXT NOT NULL CHECK IN ('prepared','closing','provider_pending','provider_confirmed','platform_pending','done') |
| target_reference_json | TEXT NULL；未完成删除的准确引用快照，上限 64 KiB，不含凭据 |
| result_json / error_json | TEXT NULL；JSON object，无 prompt/result 正文、源码和原生敏感错误 |
| created_at / updated_at | INTEGER NOT NULL |
| settled_at | INTEGER NULL |

UNIQUE(actor_key,subject_id,kind,request_id)。succeeded 必须 phase='done' 且 settled_at 非空；delete 完成必须 conversation_id 与 target_reference_json 均 NULL。failed/unknown 删除在未完成时保留 target_reference_json，并保持父对话 deleting，不能恢复发送。

最小删除回执字段为 actor/subject/requestHash/阶段/时间/归一化结果；无回收站正文。原生删除先完成，平台数据删除后同一事务更新 operation 回执；外部删除不可回滚，只能恢复该操作向前完成。

### 2.6 agent_host_feedback

| 字段 | 类型/约束 |
|---|---|
| event_id | TEXT PRIMARY KEY |
| conversation_id | TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE |
| turn_id | TEXT NULL；复合 FK (turn_id,conversation_id) REFERENCES agent_turns(id,conversation_id) |
| operation_id | TEXT NULL REFERENCES agent_operations(id) |
| generation | INTEGER NOT NULL >=0 |
| type | TEXT NOT NULL CHECK IN ('applied','rejected','resource_changed','selected_test_changed') |
| payload_json | TEXT NOT NULL，JSON object，仅必要事实，按既有敏感规则过滤 |
| status | TEXT NOT NULL CHECK IN ('pending','delivered','unknown') |
| receipt_json | TEXT NULL，JSON object，Provider 投递确认，不含 token |
| created_at | INTEGER NOT NULL |
| delivered_at | INTEGER NULL |

投递成功须有 confirmed receipt 与 delivered_at；unknown 先核对，不盲目重发。对话删除前撤销投递授权，删除事务清除 outbox，不为通知启动模型生成。

### 2.7 agent_workspaces

| 字段 | 类型/约束 |
|---|---|
| id | TEXT PRIMARY KEY，维护共享 workspace 使用固定逻辑 ID 'maintenance' |
| relative_path | TEXT NOT NULL UNIQUE；共享实例 CHECK relative_path='agent/workspace' |
| knowledge_hash | TEXT NOT NULL，64 位 hex |
| installation_state | TEXT NOT NULL CHECK IN ('initializing','ready','failed') |
| revision | INTEGER NOT NULL >0 |
| updated_at | INTEGER NOT NULL |

共享知识读写锁使用进程内 FIFO RW 锁并受现有数据目录单写者租约保护，不将每个会话做成 workspace 独占行锁。重启初始化先检查安装状态及真实包内容；失败禁止受理。

### 2.8 agent_runtime_resources

| 字段 | 类型/约束 |
|---|---|
| operation_id | TEXT PRIMARY KEY REFERENCES agent_operations(id)，不级联删文件/记录 |
| relative_path | TEXT NOT NULL UNIQUE；只能是服务端生成的 agent/runtime/<operationId>，不能是 agent/workspace 或 sessions 根 |
| purpose | TEXT NOT NULL CHECK IN ('single','project','provider_private') |
| lease_instance | TEXT NOT NULL |
| generation | INTEGER NOT NULL >0 |
| process_state | TEXT NOT NULL CHECK IN ('absent','starting','running','stopped','unknown') |
| release_state | TEXT NOT NULL CHECK IN ('retained','pending','released','failed') |
| created_at / updated_at | INTEGER NOT NULL |

磁盘路径归属/进程退出证明由服务强校验；不能按 mtime/PID 或 TTL 自动删未知资源。删除对话时资源仍未确认释放，则 operation 不得宣称全部完成。共享 workspace 永不进入此表。

### 2.9 agent_knowledge_installation

| 字段 | 类型/约束 |
|---|---|
| id | TEXT PRIMARY KEY CHECK id='current' |
| bundle_version | TEXT NOT NULL |
| knowledge_hash | TEXT NOT NULL，64 位 hex |
| manifest_json | TEXT NOT NULL，JSON object |
| state | TEXT NOT NULL CHECK IN ('initializing','ready','failed') |
| error_json | TEXT NULL，脱敏 JSON object |
| updated_at | INTEGER NOT NULL |

这是当前安装状态，不是用户可编辑知识库/历史版本库。原子激活文件与 DB 更新之间出现崩溃由启动校验收敛，不能直接把 ready 行当文件已正确发布的证明。

> 九张表均属于统一 Agent 模型；不修改业务资产、运行记录和模型配置表。

## 3. 唯一性、索引与触发器（审批范围）

索引名称使用统一 agent_ 前缀，删除旧 one_current_conversation/one_active_turn 等旧索引，不复用旧 draft 级“唯一当前对话”限制。

```sql
CREATE UNIQUE INDEX agent_one_active_turn
  ON agent_turns(conversation_id)
  WHERE status IN ('queued','running','cancel_requested');
CREATE UNIQUE INDEX agent_single_turn
  ON agent_turns(conversation_id) WHERE mode='single';
CREATE UNIQUE INDEX agent_one_control_operation
  ON agent_operations(conversation_id)
  WHERE kind IN ('delete','switch_model') AND settled_at IS NULL;
CREATE INDEX agent_conversations_by_owner
  ON agent_conversations(actor_key,scenario,owner_type,owner_id,updated_at DESC,id);
CREATE INDEX agent_conversations_by_lifecycle
  ON agent_conversations(lifecycle,updated_at DESC,id);
CREATE INDEX agent_turns_by_conversation
  ON agent_turns(conversation_id,sequence);
CREATE INDEX agent_operations_pending
  ON agent_operations(status,updated_at,id) WHERE settled_at IS NULL;
CREATE INDEX agent_feedback_pending
  ON agent_host_feedback(conversation_id,created_at,event_id)
  WHERE status IN ('pending','unknown');
CREATE INDEX agent_runtime_release
  ON agent_runtime_resources(release_state,updated_at,operation_id);
```

必须实施并做直接写库测试的触发器：

1. conversation 的身份、owner、Provider、mode、knowledgeHash 与契约/策略不可修改。
2. active turn 插入/更新要求父对话 lifecycle=active、usability=usable，且没有未结束 delete/switch_model operation。
3. delete/switch_model operation 插入或重新进入未结束状态时，拒绝存在 active turn；switch_model 必须在 active/usable conversation，delete 允许知识过期或 owner_unavailable 的历史记录，但宿主仍检查删除权限。
4. conversation 从 active 进入 deleting 前拒绝 active turn；不能从 deleting 退回 active。
5. backend 仅 multi，且 Provider/引用版本外层与父对话匹配，更新 generation 不倒退。
6. single turn 在非 deleting 父对话下禁止单独删除；turn 身份、序号与请求 hash 不可修改。
7. owner 不绑定业务 FK，不代表授权可省略；上述触发器不替代宿主 authorizer、工具 allowlist 或 revision 的事务内比较。

## 4. 旧数据重置清单与关联检查

代码检查发现：

- 工作流对话使用 SQLite `agent_conversations`、`authoring_turns`、`authoring_messages`，消息 FK 指向 turn/conversation；旧 conversations 还有 rebuild_from_id 自引用。
- 脚本维护使用 `script-agent/<scriptId>/<turnHash>.json` journal，浏览器维护使用 `web-bridge-agent/<application>/<turnHash>.json`；包含旧历史、草稿快照和未应用提案。
- 脚本提案应用通过 `command_receipts` 的 script-agent-apply 等 scope 关联 turn；不是业务版本指向 authoring_turns 的 FK。保留已应用脚本版本，但旧幂等 scope 内可能含对话结果，必须按具体 scope/受管记录清单拆分，不能整表清空。
- 原生旧目录 agent-workspaces/agent-sessions 只能按经确认的受管资源清单处理；外部 Codex/Pi home 不扫描删除。
- `stream_events` 同时保存 run 与 authoring_turn；只重置 stream_type='authoring_turn'，不能删除 run 事件或业务 artifacts。

执行迁移前必须再次通过 PRAGMA foreign_key_list 全表枚举、command_receipts scope 枚举与受管文件清单校验，记录精确预览。若合并基线增加了指向旧 turn/conversation 的业务 FK，迁移失败并要求重新审核，不动态扩大删除范围。

受批准迁移在确认、停机、备份后，事务内先解除旧自引用、删除旧 authoring messages/turn 关联和仅 Agent 所属事件/receipts，再移除旧三表、建立新九表。已应用业务溯源保留为必要 ID/revision 元数据，不保留整个旧提案。业务资产、运行、字典、模型配置、script_tests 与其历史保留策略均不改变。

磁盘 journal/原生资源删除是独立受管清单阶段，不能在 DB 提交前不可逆删除唯一副本；备份和迁移 journal 记录处理阶段。失败按现有迁移框架阻止新旧运行时同时受理，恢复对应备份；不能把外部未清理资源显示为已回收空间。

## 5. 审批与真正执行的区分

本候选获批只允许编码上述结构与版本化迁移；真正升级旧数据时仍须：

1. 显示旧对话/消息/未应用提案及受管目录重置预览并取得明确破坏性确认。
2. 停止受理并确认旧进程退出；无法证明停止时阻止升级。
3. 使用现有一致性备份覆盖数据库/WAL 和受管 journals/资源清单。
4. 更新经审核的迁移声明与独立 approval archive，再按原工具重建 release integrity；不手改已有历史批准记录，也不绕过 `Incomplete local dependency lock` 检查。
5. 做直接写库约束测试、v10/合并基线升级与失败回滚、业务资产/运行不丢失、恢复后旧二进制拒绝打开的验证。

用户已明确批准本 schema-review.md 所列九表、字段/索引/触发器、旧 Agent 重置范围及备份回滚边界，允许继续编码。批准不代表生产 Runtime/API/UI 已完成或允许自动重置旧数据；不得用 JSON sidecar 或仅内存状态绕过统一数据库模型。
