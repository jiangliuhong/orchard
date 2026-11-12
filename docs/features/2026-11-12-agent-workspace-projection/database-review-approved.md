# 数据库结构与迁移审核稿

**审核状态：待用户审核，未批准。** 本文只有结构设计，不包含可执行迁移文件；本轮未改 schema、索引、触发器、迁移清单或任何实际数据库。

配套：[实施契约](./implementation-contract.md)、[写入口审计](./write-entry-audit.md)。批准结构设计不等于同意立即执行生产迁移或删除旧数据，执行前仍须独立预览和确认。

## 1. 当前结构核对与复用结论

静态证据：`src/persistence/schema.ts`、`src/agent/schema.ts`、`src/persistence/store.ts`、`src/web-bridge/config.ts`。

- 工作流/草稿/脚本/发布版本、artifacts 和 command_receipts 已存在，继续复用。不可变源码仍由内容寻址产物承载，不把整个 workspace 入库为另一份配置。
- 当前生产 agent_conversations 是按 workflow draft 绑定的旧结构；旧脚本/浏览器 Agent 还使用文件 journal。不能假设生产已有统一九表。
- `src/agent/schema.ts` 的九表是前置 feature 已审代码，尚未等同于生产激活。本方案不自动运行旧重置，不强制安装 agent_workspaces/knowledge_installation/operations 等旧状态机。
- 复用原生 session 编解码、进程确认、目录租约、业务校验器及 CAS 思路；新维护功能使用独立表名，避免与旧 agent_conversations 同名冲突。现有 Runtime/AgentStore 需适配新的 host 边界，不直接假装可以指向新表。
- 原有 command_receipts 保留业务命令回执能力；新应用请求需要 queued 状态、确认归属和同步代次，单靠旧 result_json 不足。
- 浏览器声明配置现在是 config/web-bridge.json。选择迁入数据库，拒绝将 SQLite 提交与 JSON rename 冒充一个原子事务。

## 2. 拟新增结构（共 8 表）

通用约束：时间为 UTC epoch 毫秒 INTEGER；revision/generation 为有边界的非负安全整数（递增记录从 1 起）；hash 为小写 64 位 SHA-256；JSON 必须合法且符合预期 object/array 类型及 UTF-8 字节预算；ID 非空且长度有界。业务 JSON Schema、内容 hash 重算及权限由服务额外校验，SQLite CHECK 不能代替授权。

### 2.1 `bridge_configuration`

| 字段 | 约束/用途 |
|---|---|
| id | TEXT PK，固定 `current` |
| revision | INTEGER >=1，全局配置 CAS；每次声明变更递增 |
| config_json | TEXT，最多 16 MiB；schemaVersion/applications/environments/tools/enabledTools；不含运行 bound/tabAvailable、心跳、Cookie 或凭据值 |
| content_hash | 对 canonical config_json 重算的 hash |
| updated_at | INTEGER |

本机 profile/extension 引用可保留在 DB，不进入 workspace。16 MiB 是存储上限，不提升维护投影/提案预算。迁移和所有写入须通过现有浏览器定义验证；更新使用 revision CAS。无需历史版本表，浏览器工具仍是当前配置模型。

### 2.2 `agent_workspace_workflow_bindings`

| 字段 | 约束/用途 |
|---|---|
| draft_id | TEXT PK，FK drafts(id) ON DELETE CASCADE |
| resource_id | TEXT NOT NULL，安全工作流 ID；发布前也存在，不 FK workflows |
| created_at | INTEGER |

resource_id 索引用于枚举同资源草稿；**不加 resource_id 唯一约束**。draft_id/resource_id 创建后不可更新。新建/复制/导入在草稿事务内插入；首次发布检查绑定、源码声明与 workflows.id 一致。

### 2.3 `agent_workspace_projection_state`

| 字段 | 约束/用途 |
|---|---|
| id | TEXT PK，固定 `maintenance`；唯一共享读取范围 |
| target_generation | INTEGER >=1，业务写事务内递增 |
| synced_generation | INTEGER >=0 且 <=target_generation |
| target_knowledge_hash | 当前目标安装包规则/Skills hash，不把规则升级混为业务 revision |
| synced_knowledge_hash | 可为 NULL，未同步时允许与目标不同 |
| content_hash | 可为 NULL，只对应 synced_generation 的完整已校验文件集合 |
| state | `pending/syncing/ready/failed` |
| error_code | 可为 NULL；只存稳定错误码，无内部路径和凭据 |
| updated_at | INTEGER |

ready 要求 target_generation=synced_generation、知识 hash 相同且 content_hash 非空。每个会影响投影的业务事务执行统一 markDirty；规则升级也登记新目标代次。同步开始记录目标代次，完成使用 CAS，不能把较新目标误标 ready。

SQLite 无法验证磁盘：启动必须先封闭准入、确认旧进程停止，再核对/修复文件，即使 DB 显示 ready 也不能免检。状态行不存可由 Agent 指定的绝对路径，固定 workspace 路径由安装器代码决定。

### 2.4 `agent_maintenance_sessions`

| 字段组 | 约束/用途 |
|---|---|
| id, actor_key | TEXT PK；非空主体 |
| scenario, owner_kind, owner_id, owner_scope_json | 场景及不可变固定维护目标；工作流 scope 含 draftId，脚本含 draftVersionId/null，浏览器 owner 为 application |
| mode | `single/multi`；single 不得恢复上下文 |
| provider_id, model_id | provider FK provider_settings(id)；model 可通过受控操作变更 |
| contract_version, tool_policy_version, knowledge_hash | 绑定经过验证的工具/知识能力 |
| native_ref_json, native_ref_version, provider_fingerprint | 可空；由 Provider codec 校验的不透明准确引用，<=64 KiB；不得出现在公开 DTO |
| generation, revision | >=1；代次与平台 CAS，不能因重启恢复成旧值 |
| lifecycle | `active/deleting/deleted` |
| native_delete_state | `present/pending/unknown/absent`；single 为 absent |
| created_at, updated_at | INTEGER |

身份/固定对象/mode/provider/契约版本不可更新。模型切换不改 owner。deleted 要求确认原生历史 absent、引用清空、无活动任务；正常用户删除保留平台 tombstone 供提案归属与回执关联，不因会话删除级联抹掉已应用事实。mode=single 要求 native_ref_json 为 NULL。

### 2.5 `agent_maintenance_tasks`

| 字段组 | 约束/用途 |
|---|---|
| id, session_id | TEXT PK；FK sessions(id) ON DELETE RESTRICT |
| mode, request_id, request_hash, sequence | mode 为 single/multi，与 session 的组合 FK 一致；UNIQUE(session_id,request_id)、UNIQUE(session_id,sequence)；single 仅 sequence=1 |
| generation, projection_generation, projection_hash | 绑定启动时的 session 代次与完整文件快照 |
| baseline_json | <=64 KiB；宿主固定维护目标 revision/内容身份，不能由 Agent 文件回传替代 |
| status | `queued/running/stopping/succeeded/failed/cancelled/interrupted` |
| process_state | `absent/starting/running/stopping/stopped/unknown` |
| input_ref, display_output_ref | 可空；复用已有平台受管引用格式，只用于 UI，不重放为模型上下文 |
| error_code, created_at, started_at, ended_at | 安全错误码与时间 |

局部唯一索引限制整个项目只有一个未终结任务（queued/running/stopping），并限制每会话只有一个活动任务；single 每会话最多一个任务。终结要求 process_state 为 absent/stopped。启动恢复将可疑遗留进程视为 unknown，阻断准入；确认静默后转 interrupted，不自动重发模型请求。PID 不能单独作为进程身份或退出证明，不为方便清理而记录任意可删除目录。

### 2.6 `agent_maintenance_proposals`

| 字段组 | 约束/用途 |
|---|---|
| id, actor_key | TEXT PK；非空主体 |
| session_id, task_id | FK sessions/tasks，ON DELETE RESTRICT；组合归属由服务校验，不接受跨 session 的 task |
| submit_request_id, submit_request_hash | UNIQUE(actor_key,submit_request_id)；相同请求不同正文拒绝 |
| contract_version, target_kind, target_id, target_scope_json | 不可变固定目标，禁止任意宿主路径 |
| baseline_json | 不可变宿主基线，<=64 KiB |
| body_json, before_json | 不可变规范化 after/summary 与 before；分别 <=8 MiB，均通过敏感筛选 |
| content_hash, diff_hash | 对完整固定信封及规范化 diff 重算 |
| state | `pending/confirmed/revoked/applied/conflicted/expired` |
| created_at, expires_at | 创建后不可变；最多 7 天 |

state 不属于可替换正文。复用 existing artifacts 仅用于业务产物，不把提案正文藏在无归属 JSON 文件中。提案正文直接入表便于事务确认；初版不另建正文 blob 状态机。服务内预算包含 before+after 实际字节总和。

### 2.7 `agent_maintenance_decisions`

| 字段组 | 约束/用途 |
|---|---|
| id, proposal_id | TEXT PK；FK proposals(id) ON DELETE CASCADE |
| actor_key, request_id | UNIQUE(actor_key,request_id)；主体必须匹配提案 |
| action | `confirm/revoke` |
| content_hash, diff_hash | 必须与提案匹配，不接受模型自报确认 |
| created_at, valid_until | 确认最长 24 小时且不超过提案 expires_at；撤销不产生新确认 |

追加记录，不更新已有决定；UNIQUE(id,proposal_id) 供应用请求组合 FK 引用。每个 proposal 至多一个 confirm、一个 revoke（UNIQUE(proposal_id,action)）。撤销不可再次确认，须新提案。事务内更新 proposal.state；apply 在同一事务检查确认存在、未撤销、未过期。

### 2.8 `agent_maintenance_apply_requests`

| 字段组 | 约束/用途 |
|---|---|
| id, proposal_id, confirmation_id | TEXT PK；FK proposals/decisions ON DELETE RESTRICT；确认必须属于此提案且 action=confirm |
| actor_key, request_id, request_hash | UNIQUE(actor_key,request_id)，固定作用域为 maintenance.apply；hash 绑定 proposal/content hash |
| state | `queued/applied/conflicted/rejected` |
| target_generation | queued 时 NULL；applied 时 NOT NULL |
| result_json | 可空；终结时 NOT NULL，<=64 KiB，保存业务结果/准确资源版本/目标代次，不存源码、凭据或宿主路径 |
| error_code, retry_at, attempt_count | 重试调度与安全错误码；瞬时准备失败保留 queued，不重做已提交业务 |
| created_at, updated_at, settled_at | INTEGER；终结必须有 settled_at |

queued 是已登记、尚未应用，不等于成功。成功业务事务同时写 state=applied、proposal.state=applied、结果及 projection.target_generation。事务外文件失败只更新 projection 状态，不把请求改为 rejected。永久校验失败 rejected，CAS 冲突 conflicted；这两类须重新生成提案。

部分唯一索引 `proposal_id WHERE state='applied'` 保证一份提案只有一次成功。多个 requestId 的竞争在事务内重查提案状态，后来的请求记录 rejected/ALREADY_APPLIED 并指向首个成功回执，不重复版本创建。瞬时失败可重试同一 queued 请求；apply worker 不执行脚本或浏览器业务端点。

## 3. 索引、触发器和非数据库门禁

除上述 PK/UNIQUE/FK/CHECK 外，拟新增：

- bindings(resource_id,draft_id)。
- sessions UNIQUE(id,mode)；tasks FK(session_id,mode) → sessions(id,mode)、UNIQUE(id,session_id)；proposals FK(task_id,session_id) → tasks(id,session_id)，避免跨会话来源。
- apply_requests FK(confirmation_id,proposal_id) → decisions(id,proposal_id)；插入触发器核对决定为 confirm、主体及两个 hash 匹配。
- sessions(actor_key,scenario,owner_kind,owner_id,updated_at,id)。
- tasks(session_id,sequence) 和全项目活动任务常量表达式部分唯一索引（例如 `ON ...((1)) WHERE status IN ('queued','running','stopping')`）；`ON ...(session_id) WHERE mode='single'` 单任务部分唯一索引。
- proposals(actor_key,state,created_at,id)、proposals(session_id,created_at,id)。
- decisions(proposal_id,created_at,id)。
- apply_requests(state,retry_at,created_at,id)（仅 queued）及成功 proposal_id 部分唯一索引。

拟新增触发器：bindings 身份不可变；sessions 固定归属不可变；tasks 请求/归属/代次身份不可变；proposals 全部正文/基线/目标/归属/hash/有效期不可变；decisions 禁止 UPDATE；apply_requests 请求身份不可变且终态不可回退；projection generation 不得倒退；bridge revision 必须递增。涉及合法状态迁移的 INSERT/UPDATE 还需服务内事务复核，禁止宽泛任意 UPDATE 接口。

不以触发器读取磁盘、调用外部程序或证明用户身份。提案/确认登记可在维护任务读取期间执行；业务写事务须持有同一个独占维护边界。数据库 active task 索引不能替代进程退出、文件读锁和跨进程数据目录租约。

## 4. 提交与恢复流程

1. 验证 grant/页面身份、固定对象和确切确认，登记 queued apply request；不修改业务，也不等待当前任务读锁。
2. 轮次 settled 后关闭 Provider/MCP 子进程，确认所有读取结束，取得独占维护边界。
3. 准备并 fsync 不可变源码产物；失败保留 queued 或记录可解释的永久拒绝。无业务提交时不得更新 workspace。
4. SQLite 事务内重查请求、权限、确认、基线和依赖，CAS 业务，markDirty，写成功回执与 proposal.state；原有业务函数需拆出可参与同一事务的内核，不能在外层提前提交。
5. 提交后同步文件并 CAS synced_generation/hash。失败保留目标状态，返回 applied_projection_pending；重试仅修复派生文件。
6. 重启首先核对进程静默/DB 状态，恢复 queued 请求及未完成投影；事务已成功的请求只查结果，不再次创建业务版本。

用户撤销确认与 worker 提交通过 SQLite 事务排序；提交前撤销生效，提交后只能新提案逆向修改，不能伪装撤销成功。模型取消不撤回已真实确认的 queued 请求；页面可另外撤销。

## 5. 迁移方案（单独预览/执行，不由本文件授权）

1. 探测实际 schema/Agent 变体与全部业务写入口，停止活动任务，备份 DB、产物、浏览器 JSON、本机引用及旧会话目录；计算输入指纹。
2. 只读预检：浏览器 JSON 验证、运行态字段剥离清单、工作流身份绑定冲突、非法 ID/大小写别名、缺失产物/历史依赖、待处理旧 Agent 提案。输出用户可审核报告，无自动修复/重命名。
3. 审核后的版本化迁移创建 8 表/索引/约束，事务内插入浏览器配置、绑定和 pending 投影状态。迁移号由现有迁移链审核确定，**不在本稿预占 user_version 或改 frozen.ts**。
4. 旧业务表、旧 Agent 会话和 journal 原样保留，不重置/丢弃。旧提案不自动转成“已确认”；旧会话不改成“已迁入共享 cwd”。
5. 旧会话继续只读展示；用户明确创建新模式会话。需要迁移历史引用必须另行证明 cwd/规则/Provider 身份兼容，不能用最近会话或历史重放替代。
6. 浏览器 DB 变为唯一权威，替换 JSON 原位置读取方；旧 JSON 移入受管备份，不自动反向导入。备份恢复、配置 Git 导入/导出及 CLI 入口同步切换，否则不开放新模式。
7. 初始化/校验投影及实际工具边界后才启用维护任务。中途失败保持 maintenance，展示具体错误；不可回退运行旧代码去忽略已提交的新配置。
8. 需要回退时先停止新版本全部进程，按审核恢复点整体恢复 DB/配置/产物并重新核对，不能只覆盖旧 JSON。实际旧目录清理另行预览确认。

## 6. 保留与清理

- 未终结提案在创建 7 天后过期；确认最长 24 小时。到期不自动应用。
- 提案/决定/完整应用请求至少保留终结后 90 天；任务展示引用至少 30 天。初版清理入口须预览数量/字节/依赖，清理前要求无 queued 请求、无活动任务和无未完成投影。
- 清理完整审计行前，把已接受 apply 请求的 request hash、proposal/content hash、最终结果及目标代次写入既有 command_receipts 的独立 maintenance.apply 作用域（含主体身份），保留最小幂等 tombstone。该作用域不受旧脚本删除/清理的 scope 清单影响。
- 只在 FK 安全顺序下清理 decisions/apply_requests/proposals，再考虑无引用的 task/session tombstone；旧业务产物和原生会话各由其受管所有者清理，不能随之递归删共享 workspace。
- 最小幂等 tombstone 长期保留，若用户要完全清除，需独立提示重复请求保护丢失后果并确认。不能按普通 UI 历史保留策略悄悄删掉回执。

## 7. 审核请求

待用户明确审核的范围：

1. 8 个新增表及上述字段/约束/索引/触发器方向；不直接启用旧九表或重置。
2. 浏览器声明配置迁入数据库、全局 revision CAS、运行态字段分离及旧 JSON 停止作为权威。
3. 持久工作流草稿身份绑定，多草稿保留；未通过身份预检的数据阻断迁移。
4. queued 应用、业务与回执/目标代次同事务；正文和确认有效期/保留预算。
5. 新维护会话独立存储、旧会话保留展示但不自动跨 cwd 恢复；迁移执行仍须再次预览确认。

**尚无批准记录。** 如修改上述范围，须更新本稿并重新审核；任何批准都不自动代表 CLI 安全验收或生产迁移已完成。
