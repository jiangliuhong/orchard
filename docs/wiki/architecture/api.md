# API 与事件

服务默认只监听 `127.0.0.1:7441`，校验 Host 和 Origin。以下端点以 `/api` 为前缀，JSON 请求错误返回 `{code,message}`。找不到资源 404，修订/基线/请求冲突 409，其余无效请求 400。启动未就绪时业务接口统一返回 `503 / NOT_READY`，错误体还包含 `retryable` 和 `nextAction`；迁移答案错误为 422 并带 `fieldErrors`。

| 操作 | 方法与路径 |
| --- | --- |
| 健康 | `GET /health` |
| Provider 目录 | `GET /providers` |
| 修改设置 | `PATCH /providers/:id` |
| 检测 / 刷新模型 | `POST /providers/:id/detect` / `POST /providers/:id/models/refresh` |
| 模型列表 / 手动添加 | `GET /providers/:id/models` / `POST /providers/:id/models` |
| 修改模型 / 删除 | `PATCH /providers/:id/models/:modelId` / `DELETE /providers/:id/models/:modelId` |
| 验证模型可用性 | `POST /providers/:id/models/:modelId/verify` |
| Agent 模型配置列表 / 创建 | `GET /agent-model-configs` / `POST /agent-model-configs` |
| 模型配置详情 / 修改 | `GET /agent-model-configs/:id` / `PATCH /agent-model-configs/:id` |
| 模型配置引用 | `GET /agent-model-configs/:id/references` |
| 草稿列表 / 创建 | `GET /drafts` / `POST /drafts` |
| 草稿快照 / 保存文件 | `GET /drafts/:id` / `PATCH /drafts/:id` |
| 对话列表 / 创建重置 | `GET /drafts/:id/conversations` / `POST /drafts/:id/conversations` |
| 对话历史管理 | `POST /drafts/:id/conversations/:cid/resume` / `rebuild` / `archive` / `restore` / `rename` |
| 对话消息 | `GET /drafts/:id/messages?conversationId=...` |
| 删除草稿 | `DELETE /drafts/:id` |
| 发起创作 | `POST /drafts/:id/turns` |
| 取消创作 | `POST /drafts/:id/turns/:turnId/cancel` |
| 发布 | `POST /drafts/:id/publish` |
| 测试草稿 | `POST /drafts/:id/runs` |
| 工作流列表 / 详情 | `GET /workflows` / `GET /workflows/:id` |
| 删除工作流 | `DELETE /workflows/:id` |
| 版本与源码 | `GET /workflows/:id/versions/:versionId` |
| 运行 | `POST /workflows/:id/runs` |
| 运行列表 / 快照 | `GET /runs` / `GET /runs/:id` |
| 取消运行 | `POST /runs/:id/cancel` |
| 事件 / SSE | `GET /runs/:id/events?after=0` / `GET /runs/:id/stream?after=0` |
| 创作事件 / SSE | `GET /turns/:id/events?after=0` / `GET /turns/:id/stream?after=0` |
| 完整 JSON 产物 | `GET /artifacts/:id` |

## 启动与迁移接口

以下路径以 `/api` 为前缀，在业务服务启动前可用：

| 操作 | 方法与路径 |
| --- | --- |
| HTTP 存活 / 业务就绪 | `GET /health` / `GET /ready` |
| 同源会话 / 启动状态 | `GET /bootstrap/session` / `GET /bootstrap/status` |
| 计划 / 验证答案并生成确认 | `GET /migrations/plan` / `POST /migrations/validate` |
| 接受任务 / 读取任务 | `POST /migrations/jobs` / `GET /migrations/jobs/:jobId` |
| 失败后新尝试 / 恢复已有尝试 | `POST /migrations/jobs/:jobId/retry` / `POST /migrations/jobs/:jobId/recover` |
| 重试业务或数据初始化 | `POST /bootstrap/initialize` |
| 下载脱敏报告 | `GET /migrations/jobs/:jobId/report` |

会话握手需要 `X-Orchard-Bootstrap: 1` 和浏览器同源证据；返回仅本进程有效的 token 与 sessionId。迁移接口及初始化重试需要 `X-Orchard-Bootstrap-Token`，写请求还必须携带精确匹配的 Origin 和 JSON Content-Type。拒绝跨站、不同本机端口和未知 Host；不启用宽泛 CORS。匿名启动状态不包含数据路径和详细错误，会话与状态响应不缓存。

验证请求为 `{planHash,answers}`，返回选定分支的 planHash、summary、有效期和 confirmationHash。答案的默认值、类型、条件父字段与隐藏字段由服务端验证；secret 不返回默认值或实际值。旧源数据或旧分支产生 `PLAN_STALE`，必须重新预览确认。

任务及 retry 请求为 `{requestId,planHash,confirmationHash,answers}`，返回 202 和 `{jobId,statusUrl}`。同请求与相同语义输入返回原任务，刷新确认凭据不改变已接受请求的身份；同键不同答案返回 REQUEST_CONFLICT。不同标签页相同活动计划汇合到原任务，不同输入返回 MIGRATION_BUSY。任务进度包含持久化阶段、步骤、处理数量和实际备份结果，不回显答案、确认凭据或私密 HMAC。

recover 与 initialize 请求只接受 `{requestId}`，返回 202 和 recoveryAttemptId / initializationAttemptId；恢复目标只能是服务端记录的 jobId。initialize 仅在 initialization_failed 可新建操作，recover 仅在 recovery_required 可执行。相同操作请求可跨进程重发；并发操作汇合。

`GET /ready` 未就绪返回 503，`GET /health` 仍返回 200。前端按 revision 忽略过期状态，进程会话失效后重新握手并复用原请求标识。详见 [运行与恢复](../operations/runtime.md)及 [完整迁移协议](../../features/2026-11-06-data-migration/execution-protocol.md)。

## 脚本库接口

以下端点同样使用 `/api` 前缀：

| 操作 | 方法与路径 |
| --- | --- |
| 列表、创建 | `GET /scripts?q=&runtime=&status=&offset=0&limit=20` / `POST /scripts` |
| 详情、更新草稿 | `GET /scripts/:id` / `PATCH /scripts/:id/draft` |
| 固定版本 | `GET /scripts/:id/versions/:versionId` |
| 发布、归档 | `POST /scripts/:id/publish` / `POST /scripts/:id/archive` |
| 复制、还原 | `POST /scripts/:id/copy` / `POST /scripts/:id/restore` |
| 工作流引用 | `GET /scripts/:id/references` |
| 测试摘要、创建 | `GET /scripts/:id/tests?offset=0&limit=20` / `POST /scripts/:id/tests` |
| 测试详情、取消 | `GET /scripts/:id/tests/:testId` / `POST /scripts/:id/tests/:testId/cancel` |
| Agent 轮次列表、生成 | `GET /scripts/:id/agent/turns?offset=0&limit=20` / `POST /scripts/:id/agent/turns` |
| Agent 详情、取消 | `GET /scripts/:id/agent/turns/:turnId` / `POST /scripts/:id/agent/turns/:turnId/cancel` |
| 确认 Agent 变更 | `POST /scripts/:id/agent/apply` |
| 清理预览、确认 | `POST /scripts/:id/cleanup/preview` / `POST /scripts/:id/cleanup` |

脚本定义包含 `id,name,description,runtime,entryFile,inputSchema,outputSchema,files`，可选 `timeoutMs` 和 `resultMode`。`files` 为完整源码文件字典；Shell 的 `resultMode` 为 `process`（默认）或 `json`。创建/编辑建议携带 `requestId`（保留旧客户端省略的兼容），编辑还包含 `expectedRevision`，新客户端同时携带 `expectedDraftVersionId` 防止草稿替换后的修订号重用。

复制包含 `id,name,versionId,requestId`；还原包含 `versionId,expectedRevision,expectedDraftVersionId,replaceDraft,requestId`，现有草稿必须显式确认替换。发布包含 `expectedRevision,requestId`。脚本列表最多每页 200 条，测试和 Agent 历史最多每页 100 条，列表返回摘要及 total。

测试包含 `input,requestId`，并且必须恰好指定 `scriptVersionId` 或 `draftRevision`。测试绑定完整不可变快照；详情中的大字段可能返回 `{artifact:{id,sha256,byteSize}}`，大输入额外携带 `inputArtifactId` 以便准确复用。历史清理后原请求重试返回 410 / TEST_EXPIRED，不重新执行。

Agent 生成包含 `providerId,modelId,prompt,expectedRevision,requestId`，可选 `conversationId,testId`，返回 202。通过轮次详情轮询状态；跨脚本轮次或测试访问返回 404。确认应用包含 `turnId,expectedRevision,requestId`，只允许在原草稿 ID 和修订上应用一次。服务重启中断未完成生成，不自动重试；归档后只读保留历史。

清理预览包含 `keepDays,keepLatest`，返回 count、token 和每批上限。确认请求包含相同策略、token 和 requestId；范围改变时返回 409 / CLEANUP_CONFLICT。默认不自动清理，用户确认范围后才删除符合条件的历史测试和无引用产物。

## 工作流请求体

```json
{
  "requestId": "unique-create-id",
  "workflowId": "optional-existing-workflow-id"
}
```

创建草稿时省略 workflowId 即创建新工作流候选。轮次请求包含 requestId、expectedRevision、providerId、modelId、prompt，可选 `conversationId` 与 `mode`（single/multi）；缺省时使用当前对话，配置/模型快照变化会原子轮换（旧对话转 idle 历史）。创建/重置对话请求包含 providerId、modelId、expectedRevision、requestId，可选 mode 与 rebuildFromId；操作不调用模型、不提高草稿 revision。对话状态机为 current（当前，每草稿至多一个）/ idle（可继续历史）/ archived（用户归档，archived_at 记录归档时间）/ needs_rebuild（后端上下文不可恢复，保留作诊断历史，不占当前名额）；历史管理命令均携带 requestId 与 expectedRevision，存在活动轮次（queued/running/cancel_requested）时拒绝并返回 409 / DRAFT_BUSY；跨草稿会话 ID 统一 404。resume 将 idle 设为当前（原当前转 idle）；rebuild 等价于携带 rebuildFromId 的创建，原会话保留；archive 需二次确认且仅限 current/idle；restore 将 archived 设为当前；rename 修改标题（1–200 字符，不影响消息与上下文）。对话无 current 时隐式提交轮次：最新对话为 needs_rebuild 返回 409 / SESSION_REBUILD_REQUIRED，存在其他存量对话返回 409 / CONVERSATION_CONFLICT，空草稿首轮懒创建。对话列表按最近活动倒序，条目含 title（缺省由首条用户消息确定性生成）、archivedAt、lastUserMessage、lastTurnStatus、activeTurnId 等派生字段。手动保存文件包含 expectedRevision 和完整 files 字典。发布包含 requestId 和 expectedRevision。草稿测试包含 requestId、expectedRevision 和 input；测试前校验草稿修订，冻结定义、模型配置、布局与编译脚本为不可变快照，不创建 workflow_versions 记录，也不改变草稿状态或当前发布版本。运行包含 requestId、input、可选 versionId，省略版本时选当前发布版本。

同 scope/requestId 和相同内容返回原结果，同键不同内容拒绝。自动重试请求应复用标识；用户发起新的运行使用新标识。

删除端点不发送请求体，成功返回 `{id, deleted: true}`，重复删除同一 ID 仍返回成功。删除工作流会在同一事务中清理全部发布版本、关联草稿（包括首次发布的原始草稿）、对话、正式及草稿测试运行、节点执行、事件和相关请求回执。存在生成、发布、排队、运行或取消尚未完成的任务时返回 409 / WORKFLOW_BUSY。删除草稿仅清理该草稿及其测试记录，不影响已发布版本；已发布草稿需通过工作流删除入口处理。独立复制出的工作流及草稿不受影响。共享的摘要文件和产物保留，避免破坏其他引用，不执行磁盘文件回收。

## 模型管理

具名 Agent 模型配置与 Provider 模型目录分开管理。创建配置请求为 `{name, description?, providerId, modelId, enabled?, requestId}`；修改支持同样的业务字段，并要求 `expectedRevision`、`requestId`。列表支持 `?enabled=true|false`，返回可用性、不可用原因、去重工作流数与草稿数；引用接口返回草稿和全部发布版本。详情见[Agent 模型配置](../product/agent-model-configs.md)。

工作流默认值及 Agent 节点仅接受 `agentConfigId`。发布保留配置 ID，正式运行和草稿测试入队时保存节点绑定。运行详情返回 `agentBindings`，包括 `nodeId`、`configId`、`configRevision`、`name`、`providerId`、`modelId` 和创建时的 `providerRevision`；节点执行信息另记录实际调用时的 Provider 修订。

模型列表返回 `{items, defaultModel}`，items 包括 id、name、source 与 enabled，旧条目缺少 enabled 时返回 true。列表包含禁用模型，不包含已删除条目。

添加模型请求为 `{id, name?, enabled?}`，name 默认使用 ID，enabled 默认 true，source 固定为 configured。活动 ID 重复返回 409；显式添加已删除 ID 会恢复该条目。

修改请求支持 `{enabled?, name?}`，至少提供一个字段。禁用或删除默认模型会清空 defaultModel。修改或删除返回更新后的 Provider；重复删除同一已删除 ID 保持成功。不存在的模型返回 404。

路径中的模型 ID 使用 `encodeURIComponent` 编码，包括 ID 中的 `/`。删除请求无请求体，不发送 application/json 请求头。

刷新保留启停状态和删除标记，新发现条目默认启用，返回 models、defaultModel、revision 与可选 warning。刷新期间若配置已改变，返回 409 而非覆盖较新的设置。旧的 Provider PATCH models 数组采用合并更新：遗漏条目不会移除现有模型，省略 enabled 会保留已有状态，已删除条目只能通过显式添加恢复；删除使用专用 DELETE。

## 模型验证

`POST /providers/:id/models/:modelId/verify` 无请求体，不发送 application/json 请求头，模型 ID 仍使用 `encodeURIComponent` 编码。发起一次真实模型请求，可能产生用量。必须启用 Provider，模型必须存在且未删除；允许验证禁用模型，不改变启用、默认值或设置修订。

请求完成返回 HTTP 200：

```json
{
  "providerId": "example-provider",
  "modelId": "example/model",
  "providerRevision": 3,
  "status": "available",
  "checkedAt": 1793750400000,
  "durationMs": 320,
  "responsePreview": "OK"
}
```

status 为 available、failed 或 cancelled。checkedAt 是服务端完成检查的毫秒时间戳；失败或取消带 `error: {code,message}`，可用时返回最多 160 字符的 responsePreview。actualModelId 仅在后端明确报告时存在。CLI 不可用、模型调用错误、空回复、超时（TIMEOUT）或验证期间设置修订改变（SETTINGS_CONFLICT）均返回 failed 结果。

未执行验证的请求错误使用 4xx：禁用 Provider 为 400，模型缺失或已删除为 404，同 Provider 已有活动验证为 409 / MODEL_VERIFICATION_BUSY。超时固定为 60 秒，不接受客户端修改；不自动重试。客户端断开连接会传递取消信号，服务关闭会取消活动验证并等待清理。检测阶段须等待内建 CLI 版本检测结束（最多 10 秒）后处理取消。

结果不入库；客户端在配置修订变化时清除旧结果。`GET /health` 的 activeModelVerifications 返回当前活动验证数。

## 浏览器桥接诊断

`GET /web-bridge/status` 返回 `enabled, connected, catalogHash, extensionVersion, pending, sites`。connected 表示最近 150 秒内存在注册资料；pending 是实际在途 browser 调用数。sites 展示启用环境及绑定资料的连接状态，不代表业务页签或登录态可用。

`GET /web-bridge/doctor` 在状态基础上返回 `transport: "http"` 和 checks，分别报告 Node、扩展文件、浏览器资料与 Native Host 安装。Native Host 只做本机服务发现，业务请求仍经过受认证的 HTTP 轮询通道。安装、端口与升级步骤见[浏览器桥接](../product/web-bridge.md)。

## 快照和事件

正式运行快照包括 version；草稿测试快照包括 draftId、draftRevision 和 execution（不可变流程定义、布局与产物路径），两者都包括 nodes、attempts 和 lastSequence。初次获取快照后可以从 lastSequence 订阅；SSE 使用 `id: sequence`、`data: JSON`，支持 Last-Event-ID 重连。事件包含 streamType、streamId、sequence、type、可选 nodeId / attemptId、payload 与 createdAt。

HTTP events 一次最多返回 500 条，按最后返回的 sequence 分页，直到达到 lastSequence。客户端按 sequence 去重，不能用数组长度当游标。服务先补读历史再续读新事件；慢连接结束后可以用持久化游标重连，服务不无限缓存日志。

工作流创作的 provider.text 在宿主持久化前按 50 ms 或 4 KiB 合并，保留 UTF-8 字节 offset 与可选 itemId；超大单条增量拆成 inline 事件，非文本事件和终态前刷新。turn.succeeded 包含 summary、validation、conversationId、appliedRevision；失败／取消包含会话身份和安全错误。客户端按活动 turn 保存已收到文本，切换历史不清空该轮内容。

较大输入输出和事件 payload 返回 `{artifact:{id,sha256,byteSize}}`，通过产物端点读取并校验完整内容。产物 ID 不接受任意本地路径。运行列表暂保留最近 200 条展示，历史记录本身不自动删除。

功能测试使用 Fastify 注入和本地模拟子进程验证这些请求，不调用真实模型。
