# Agent 原生会话协议基线记录

状态：Phase A 契约固定记录。本文件记录实施时实际核对的 CLI 版本与协议形状；在线文档可能变化，实施与测试以本记录为准。真实账号（付费调用）验收另行执行并记录，见设计文档 §15、§24。

核对日期：2026-11-04（实施 Phase A–C 当天）

## 1. CLI 版本矩阵

| 后端 | 设计基线 | 本机实施核对版本 | 协议入口 | 核对方式 |
| --- | --- | --- | --- | --- |
| Codex | 0.166.0 | **codex-cli 0.165.0** | `codex app-server`（v2 API） | `app-server --help`、`app-server generate-json-schema --out`（仅本地导出 Schema，未调用模型）、真实进程 initialize 握手 |
| Pi | 1.4.0 | **pi 1.3.0** | `pi --mode rpc` | 包内官方 `docs/rpc.md` / `rpc-commands.md` / `json.md`，真实进程 `get_state` 握手 |

注意：设计文档撰写时基线为 0.166.0 / 1.4.0；本机安装为 0.165.0 / 1.3.0。协议形状在两个版本间一致（见下），已按本机版本固定契约测试。升级 CLI 后必须重新生成 Schema 并重跑本文件记录的核对项。

## 2. Codex App Server（0.165.0 实测）

协议为 stdio JSON-RPC（v2 API），由 `codex app-server generate-json-schema --out <dir>` 导出的 Schema 固定：

| 方法／通知 | 实测形状 | 备注 |
| --- | --- | --- |
| `initialize` | 请求 `{id, method:"initialize", params:{clientInfo:{name,version}}}`；响应 `{id, result:{userAgent, codexHome, ...}}` | clientInfo 必填；握手完成后发送 `initialized` 通知 |
| `thread/start` | 参数含 `model`、`cwd`、`ephemeral`、`sandbox`、`approvalPolicy`、`config`(object)；响应 `result.thread.id` | ephemeral thread 用于单次调用 |
| `thread/resume` | 必填 `threadId`；可重新指定 model / cwd / sandbox / approvalPolicy / config；响应 `result.thread.id` | 失败时按错误文本分类：明确 not found → SESSION_REBUILD_REQUIRED。**2026-11-06 实测**：格式非法 threadId 报 `invalid session id: invalid character…`，同为永久性错误，已归入 SESSION_REBUILD_REQUIRED |
| `turn/start` | 必填 `threadId`、`input: [{type:"text", text, text_elements:[]}]`；可选 `outputSchema`；响应 `result.turn.id`、`turn.status`（inProgress） | 响应前到达的通知先暂存。**2026-11-06 实测**：`outputSchema` 走 OpenAI 严格结构化输出校验，`required` 必须覆盖全部 `properties`、仅支持 type/description/enum/properties/required/items/additionalProperties/format；不满足时请求被拒（`Invalid schema for response_format`）。实现仅对完全兼容的 schema 透传（`strictOutputSchema()`），否则省略并由宿主校验 |
| `turn/completed` | `{threadId, turn:{id, status, error?, items[]}}`；`status ∈ completed/interrupted/failed/inProgress` | items 中 `type:"agentMessage"` 带 `{id, text}` 为最终消息 |
| `item/agentMessage/delta` | `{threadId, turnId, itemId, delta}` 全必填 | 增量仅展示；completed item 覆盖增量缓冲 |
| `item/completed` | `{threadId, turnId, item:{id, type, text}}` | agentMessage 完整文本以此为准 |
| `thread/tokenUsage/updated` | `{threadId, turnId, tokenUsage:{last, total}}` | 线程级范围（session scope），`last` 为最近一轮用量 |
| `turn/interrupt` | `{threadId, turnId}` | 中断后等待终态 |
| 服务端请求 | 实测方法集：`execCommandApproval`、`applyPatchApproval`、`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/call`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`、`account/chatgptAuthTokens/refresh`、`attestation/generate` | 已知工具/审批请求返回协议错误并终止本轮 TOOLS_DISABLED；未知方法返回 `-32601` method-not-found |
| 未知通知 | 实测 `remoteControl/status/changed` 在 initialize 后到达 | 格式有效但未知的通知记录后忽略 |

工具限制：`app-server` 子命令支持 `-c <key=value>` 配置覆盖（实测 `features.shell_tool=false`、`notify=[]` 可被接受启动）。实现沿用 legacy exec 的禁用集合：`mcp_servers={}`、`notify=[]`、`web_search="disabled"`、`features.<shell_tool|unified_exec|apps|plugins|hooks|multi_agent|browser_use|computer_use|in_app_browser|image_generation>=false`。

已知环境问题：本机 codex app-server 存在偶发启动抖动（与参数无关，随机约半数进程无响应即退出）。因此实现要求 initialize 超时给出明确错误（PROTOCOL_UNSUPPORTED / TIMEOUT），不做静默重试；真实多轮验收如遇此现象按启动失败处理并重试打开连接。

## 3. Pi RPC（1.3.0 实测）

协议为 JSONL（LF 分帧、允许 CR）：命令带唯一字符串/数字 `id`，响应 `{id, type:"response", command, success, data|error}`，会话事件无 id。

| 命令／事件 | 实测形状 | 备注 |
| --- | --- | --- |
| `get_state` | 响应 `data.model.id`、`sessionId`、`isStreaming`、`messageCount`（1.3.0 实测未返回 `sessionFile`） | 新进程与恢复后都必须校验模型、sessionId 与 isStreaming=false；sessionFile 缺失时允许"尚未生成"，首轮接受后可再查询补充 |
| `prompt` | `{id, type:"prompt", message}`；响应 `data.disposition ∈ started/queued/handled` | 只有 started 接受为本轮执行；queued/handled 在无扩展、禁并发前提下是协议状态违规 |
| `message_update` | `assistantMessageEvent.type === "text_delta"` 时 `delta` 为增量 | 按 UTF-8 字节累计 offset |
| `message_end` / `turn_end` | `message.role === "assistant"`，`content[].text`、`model`、`usage`、`stopReason`、`errorMessage` | 重试过程中间消息会被后续覆盖，保留最后一个 |
| `agent_end` | `{messages, willRetry}` | 低层运行结束边界，不能据此结束轮次 |
| `agent_settled` | `{aborted}` | 最终空闲边界；aborted=true 按取消归类 |
| `clear_queue` / `abort` | 响应型命令 | 中断顺序：clear_queue 响应后再 abort；clear_queue 失败仍尝试 abort；无法确认 settled 时终止进程 |

启动参数（数组构造，不拼 shell）：`--mode rpc --no-extensions --no-mcp --no-tools --thinking off --model <id>`；临时会话 `--no-session`；新持久会话 `--session-dir <受控目录> --session-id <宿主UUID>`；恢复 `--session <绝对文件路径>`（realpath 校验，拒绝越界 symlink、缺失文件、目录冒充文件）。

## 4. 本机真实进程冒烟结果（无模型调用）

执行日期：2026-11-04。脚本：临时脚本（未纳入仓库），仅握手探测、不发 prompt、不读取用户认证内容。

| 探测 | 结果 |
| --- | --- |
| PiRpcProvider.probe（真实 pi 1.3.0，get_state 握手后退出） | OK，461 ms |
| CodexAppServerProvider.probe（真实 codex 0.165.0，initialize/initialized 握手后退出） | OK，第 1 次尝试 165 ms |

真实账号三轮创作、取消、重启恢复、两次独立节点调用（设计 §15）尚未执行，属于 Phase F 验收范围。
