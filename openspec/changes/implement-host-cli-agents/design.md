# Design

## Context

见 proposal.md 的动机。当前代码事实：

- `PiClient`/`PiAdapter`（`src/integrations/pi/adapter.ts`）是现成抽象：`createSession({signal, allowedTools}) → session.run(request)`，`PiAdapter.execute` 已内建取消传播与 `assertValidJson` 输出校验。缺的只是真实 `PiClient` 实现与接线。
- `core.cli` 集成（`src/integrations/cli/`）提供了 `ProcessController`（`shell:false`、超时、输出上限、取消、进程组终止）与 `CliToolRegistry`（受信注册）。但 `ProcessController` 目前 `stdio[0] = "ignore"`，**不支持向子进程写 stdin**——而规格要求 prompt 必须经 stdin 传入。
- `agent_profiles` 表与 `AgentProfileRepository` 已存在（`list`/`create`），无校验层；`POST /api/agents` 接受自由文本 provider；`secret_ref` 列存在。
- `createLocalNodeRegistry()`（`src/runtime/local-nodes.ts`）无参数，注册 `core.sleep` 与 metric 节点；`ai.pi` 从未注册。运行时 step 错误默认可重试（除非 `retryable: false`）。
- `main.ts` 从未构造 `PiAuthoringService`，`authorPi` option 缺失 → `/api/drafts/:draftId/author` 固定 503。
- 宿主机实测（本机 pi 1.1.0）：`pi -p --mode json --no-session --no-extensions --no-mcp --no-tools` 接受 stdin prompt，stdout 输出 JSONL 事件流；最终 assistant 消息在 `turn_end.message`（含 `provider`/`model`/`usage`/`stopReason`），流末尾为 `agent_settled`；模型不存在时 exit 1、错误只在 stderr。`pi auth check --model <m> --json` 可探测 provider 就绪（必须给 `--model` 或 `--provider`）。本机未装 codex（e2e 依赖 fake 脚本，见测试决策）。

## Goals / Non-Goals

**Goals:**

- 以最小侵入接通两条断路：`ai.pi` 节点执行、Pi authoring，均路由到宿主机 CLI。
- 对 `core.cli` 基础设施只做一处必要扩展（stdin），不复制进程管理代码。
- 所有外部输入（profile 字段、step config）经白名单校验后才影响子进程命令行。

**Non-Goals:**（除 proposal 的 Non-goals 外，设计层面的边界）

- 不为 CLI 后端引入 `CliToolRegistry` 里的 `CliToolDefinition` 抽象（那是给 `core.cli` 工作流工具用的；agent 后端有 profile 动态参数，直接经 `ProcessController` 拉起，注册语义由新的轻量 backend registry 承担）。
- 不做输出流式转发到 UI / run 日志（防敏感内容落盘，见 D8）。
- 不缓存探测结果到数据库；探测是即时调用。

## Decisions

### D1: 受信解析 = 设置优先 + 常见目录发现，`CliPiClient` 实现 `PiClient`

新增 `resolveCliBackends(settings)`：对每个 launcher 按以下顺序解析，结果钉定为**绝对路径**构建 `HostCliBackends`（`{ "pi-cli"?: BackendConfig, "codex-cli"?: BackendConfig }`，`BackendConfig = { executable, defaultTimeoutMs, maxOutputBytes, killGraceMs, source: "settings" | "discovered", probe }`）：

1. **系统设置**：`dataDir/settings.json`（0600，按需创建）中用户保存的路径（仅接受绝对路径，保存时已探测验证）；
2. **自动发现**：按文档化的固定目录清单顺序搜索，每个候选跑 `--version` 探测，取第一个通过者：
   - `~/.nvm/versions/node/<ver>/bin/<cli>`（多个版本目录按版本号降序，最新 Node 优先）；
   - `~/.npm-global/bin`、`/opt/homebrew/bin`（仅 darwin）、`/usr/local/bin`、`~/.local/bin`、`~/.cargo/bin`（仅 codex）；
3. 都未命中 → 该后端不注册，保持"未配置"明确语义。Windows 上发现仅 best-effort（npm 前缀），设置绝对路径永远可用。

**不新增启动参数、不引入环境变量**（`--pi-cli`/`--codex-cli` flag 与 `ORCHARD_*` 全部取消）：常见路径零配置开箱即用，异常解析经系统设置修正。

设置面（新增，最小实现）：`GET /api/settings/cli-backends` 返回每个 launcher 的 `{ path, source, availability }`；`PUT` 保存新路径时先跑版本探测，失败则拒绝保存并返回原因，成功则原子替换内存中的后端条目（进行中的执行沿用其启动时已解析的命令，不受影响）。设置页（现仅 localStorage 存根）接入该 API。`settings.json` 采用命名空间结构（`cli`、`authoring`、…），定位为工作台的统一设置存储；设置页其余存根项（工作区名称、保留策略、并发数等，现为 localStorage 假数据）后续迁入对应命名空间，但作为**独立 change** 实施——每一项都需要真实语义接线（保留策略涉及运行数据删除、并发数涉及 WorkerLoop 接线），不应混入本 change。

`CliPiClient(backends, controller)` 实现 `PiClient`：`createSession` 按 launcher 选中后端返回一次性 `PiSession`（无会话续接，每 run 一次进程）。运行请求中出现的任何可执行文件路径字段一律忽略（规格：不可注入）。

- 备选：PATH（`which`）发现。否决——PATH 顺序继承自进程环境、不可文档化；固定目录清单是确定性的。
- 备选：环境变量/flag 覆盖。否决——与设置文件构成三源优先级，徒增维护面；设置文件本身已满足 headless/declarative 场景。
- 备选：设置入库（新表）。否决——AGENTS.md 规定表结构变更需审核；实例级运维配置放 `settings.json` 文件既合规又在后端构造前即可读。若未来要入库，走 `docs/database-change-review.md`。
- 备选：保留 `HttpPiClient` 与 CLI 并存配置切换。保留类不动（不删代码），但不再新增接线；`CliPiClient` 是唯一被 `main.ts` 构造的实现。

### D2: `ProcessController` 最小 stdin 扩展

`CliProcessCommand` 增加可选 `stdin?: string`：存在时 `stdio[0]` 用 `"pipe"`，spawn 后单次写入并 `end()`；`EPIPE`（子进程早退）静默忽略，由 exit code / stderr 路径报错；超时/取消/输出上限路径不变。默认（无 `stdin`）行为与现状完全一致，`core.cli` 既有调用零影响。

- 备选：在 `CliPiClient` 里自行 `spawn`。否决——违背"复用进程控制、不新写进程管理代码"，会分叉超时/取消/进程组终止逻辑。

### D3: pi-cli 调用与解析契约（按宿主机实测的 1.1.0 JSONL）

固定参数：`-p --mode json --no-session --no-extensions --no-mcp`；工具：无 `allowedTools` 时加 `--no-tools`，有则以 `--tools a,b` 白名单传递（allowlist 语义本身即"仅这些可用"，不与 `--no-tools` 叠用）；模型：仅 profile.model 非空时 `--model <m>`；thinking：节点执行默认 `--thinking off`（headless 工作流要确定性低成本，pi 默认随模型可能是 high），profile `config.thinkingLevel` 显式覆盖。

prompt 经 stdin 写入。解析 stdout JSONL：取**最后一个** `type:"turn_end"` 的 `message`（role=assistant），拼接 `content[]` 中 `type:"text"` 块的 `text` 为输出；`provider`/`model`/`usage` 取自同一事件。流中出现 `type:"error"` 事件 → 失败并透出其 message。exit ≠ 0 → 失败并透出 stderr 摘要。解析器对未知事件类型宽容跳过（前向兼容），但对"找不到最终 assistant 消息"给出明确 `INVALID_OUTPUT` 错误。

- 已知浪费：`agent_end` 事件会重复整段消息历史（含 system preamble），字节近翻倍。缓解：pi 后端输出上限默认 8 MiB（见 D10），且 `--no-session` 下无落盘副作用。

### D4: codex-cli 调用与解析契约

`codex exec --json [-m <model>] -s <sandbox> -o <tmpfile>`，prompt 经 stdin。最终消息**只从 `-o` 落盘文件读**（stdout JSONL 仅用于 `turn.completed` 的 usage 等元数据），读后立即删除 tmpfile（`mkdtemp` 私有目录 + `rm -rf`，防与 JSONL 解析口径不一致）。sandbox 仅 `read-only` | `workspace-write` 两值（永不传 `danger-full-access`）。provider 报 `"codex"`；model 优先取事件流，缺失回退 profile.model 或 `"codex"`。

- 本机无 codex，契约按其文档固定；行为验证全部走 fake 可执行脚本（见测试）。
- 备选：从 stdout JSONL 的 `item.completed`(agent_message) 取最终消息。否决——`-o` 文件是 codex 官方承诺的"最后一条 agent 消息"，口径最稳。

### D5: profile 字段校验层与 codex 授权单源

新增纯函数校验（`src/integrations/pi/profile.ts`，被 repository 与节点执行共用）：

- `provider ∈ {"pi-cli","codex-cli"}`，否则 `INVALID_AGENT_PROFILE`。
- `model`：`"" | string ≤200`。空 = CLI 默认模型。
- `config_json` 仅接受 `{ timeoutMs?: 1..900_000, thinkingLevel?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max" }`，`additionalProperties` 语义拒绝一切其他键（防命令行注入）。pi 专属 `thinkingLevel` 在 codex profile 上报错。
- `allowedTools`：pi 后端 → 工具白名单（每项 ≤100 字符，≤50 项）；codex 后端 → 仅允许哨兵值 `"workspace-write"`（出现即沙箱 `workspace-write`，空/缺省即 `read-only`）。**与 proposal 的差异**：不设 `config.codexSandbox` 字段——授权来源单一是规格"授权来源可追溯"的最简实现，两个字段表达同一授权会制造歧义。
- `secret_ref`：API 与 repository 不再接受/写入（存量值读取时忽略，不删列、无 migration）。

`POST /api/agents` 路由 schema 收紧（provider 枚举、model 允许空串、config 走校验层）；`GET /api/agents` 对存量非法 provider 行附加 `validationError` 标注而非隐藏（见 Migration）。

### D6: `ai.pi` 节点注册与 profile 解析

新模块 `src/integrations/pi/nodes.ts`，`registerAiNodes(nodes, { agents, client, workspaceRoot })`，由 `createLocalNodeRegistry(options?)` 在 `agents` 可用时调用；后端未解析不影响注册——执行时才报 `AGENT_BACKEND_NOT_CONFIGURED`（`retryable:false`），与设置的运行期生效兼容。节点定义：

- `configSchema`: `{ agentProfileId: string, outputSchema?: JsonSchema }`（`additionalProperties: false`）；`inputSchema`: `{ prompt: string 1..100_000 }`；`sideEffects: "unknown"`。`outputSchema` 为 step 级输出契约（规格："当 step 配置了输出 JSON Schema 时"），透传给 `PiAdapter` 走 `assertValidJson` 后校验。
- 执行：`agents` 查 profile → `D5` 校验 → launcher 路由 → `PiAdapter.execute({ prompt, outputSchema: 节点声明的 outputSchema, model: profile.model || undefined, allowedTools: profile.allowedTools })`。输出校验复用 `PiAdapter.assertValidJson`，校验失败抛普通 Error → 既有 attempt 重试（默认 retryable）。
- profile 不存在 / launcher 未注册 → 带 code 的配置错误，`retryable: false`（重试无意义）。
- `cwd` 锁定 `workspaceRoot`（`dataDir/workspaces/default`）。

### D7: 探测设计（启动 / doctor / UI 三入口，同一实现）

`probeBackend(launcher, executable)`（`src/integrations/pi/probe.ts`）：

- L1 可用性：`ProcessController` 执行 `--version`（10s 超时，输出上限 64 KiB）→ `{ available, version?, path, source, reason? }`。
- L2 就绪（仅 pi、仅 doctor/UI 按需）：对每个引用了该 launcher 的 profile，`pi auth check --model <m> --json`（`--no-refresh` 不动凭证；model 为空跳过并标 `unchecked`）；codex 无廉价等价物，L2 即 L1。
- 启动时只跑 L1（无网络、毫秒级），结果打印一行；doctor 跑 L1+L2；状态与编辑统一走 `GET/PUT /api/settings/cli-backends`（GET 即时跑 L1 并带 `{ path, source }`），Agent 管理界面读取同一端点，不另设 `/api/agents/backends`。
- L2 仅显式触发：设置页/Agent 管理页的"检测就绪状态"按钮 → `GET /api/settings/cli-backends?readiness=deep`，按需即时执行、**不做缓存**——诊断工具返回的必须是刚刚查的结论；若未来需要被动常驻展示（如状态栏徽标）再引入 TTL 缓存，届时不改 API 契约，纯内部优化。

### D8: 错误语义与日志纪律

错误统一为 `Error` + `code` +（进程失败时）`stderr` 摘要（截断 2 KiB）+ `exitCode`：

| 场景 | code | retryable |
|---|---|---|
| launcher 未注册 / profile 不存在 / 字段非法 | `AGENT_BACKEND_NOT_CONFIGURED` / `AGENT_PROFILE_NOT_FOUND` / `INVALID_AGENT_PROFILE` | false |
| 进程启动失败 | `PROCESS_START_FAILED` | false |
| exit ≠ 0（凭证 403、模型不存在…） | `CLI_PROCESS_FAILED` | true |
| JSONL 无最终消息 / JSON 损坏 | `INVALID_PI_OUTPUT` | true |
| 超时 / 取消 / 输出超限 | 沿用 `PROCESS_TIMEOUT` / `PROCESS_CANCELLED` / `OUTPUT_LIMIT_EXCEEDED` | true / false(取消) / true |

`context.onLog`/run 日志**不落**原始 stdout（含 prompt 回显与 preamble，防敏感内容入库）；attempt 错误里的 stderr 摘要是唯一原始透出通道（规格要求）。

### D9: Pi authoring 接线

`main.ts`：后端已配置时构造 `PiAdapter(cliPiClient)` + `PiAuthoringService`，authoring 用的请求参数取 launcher `pi-cli` 的后端默认（无 profile 依赖）；可选经系统设置 `authoring.profileId` 钉到某 profile（复用其 model/thinking/timeout；不引入环境变量）。未配置任何后端 → 不传 `authorPi` option → 既有 503 语义原样保留（规格场景）。

### D10: 限额与默认值

| 参数 | pi-cli | codex-cli | 说明 |
|---|---|---|---|
| 默认超时 | 300s | 300s | profile `config.timeoutMs` 可降不可升过 900s 硬顶 |
| 输出上限 | 8 MiB | 4 MiB | 不可被 profile 覆盖（防内存放大；pi 翻倍冗余见 D3） |
| killGrace | 2s | 2s | 沿用默认 |
| cwd | workspaceRoot | workspaceRoot | `workspace-write` 沙箱的写入面 |

### D11: 测试策略

- 单测：JSONL fixture 解析（正常/截断/无 assistant/`error` 事件）、参数构造（model 空/非空、tools 有无、thinking 默认 off）、profile 校验矩阵、错误码映射。
- 集成：fake `pi`/`codex` 可执行脚本（Node 脚本落临时目录，经 D1 配置注册为受信可执行文件），覆盖 stdin 透传、`-o` 文件读写与清理、超时、取消、exit≠0 透 stderr、schema 校验失败重试。
- e2e：注册 `ai.pi` 节点 + fake CLI 跑通一次 run；authoring 走 fake pi 返回合法 patch。

## Risks / Trade-offs

- [pi JSONL 是版本化私有格式（session v3），升级可能变形] → 解析器宽容未知事件 + `INVALID_PI_OUTPUT` 明确报错；探测拿 `--version`，<1.1.0 时 UI 标记不满足。
- [`agent_end` 冗余导致大输出撞 8 MiB 上限] → 上限已加倍预留；超限是明确错误而非静默截断（规格要求）；prompt-only、无续接的用法天然有界。
- [本机无 codex，`exec --json` 事件与 `-o` 行为仅凭文档] → 全部 codex 断言由 fake 脚本覆盖；真实环境首次运行若事件缺失，model 回退 profile 值、消息仍以 `-o` 文件为准（口径最稳的通道）。
- [设置文件可被本用户改写（settings.json）] → 与单用户本地威胁模型一致（能写 home 即已能替换 CLI 本体）；保存时强制探测 + 仅接受绝对路径，路径与来源在设置页可见可审计。
- [存量 profile 的自由文本 provider（如 "openai"）在收紧后非法] → 不隐藏不迁移：`GET /api/agents` 标注 `validationError`，执行时给明确配置错误；用户用新 UI 重建。
- [stderr 摘要可能含敏感片段] → 截断 2 KiB；本地单使用者定位下可接受，且是规格的明确要求。
- [宿主 pi 默认 provider 在受限地区 403] → 以 `CLI_PROCESS_FAILED` failed attempt 透出原始 stderr，doctor L2 提前发现；由用户自行配置可用 provider。

## Migration Plan

1. 发布新版二进制并重启：常见目录自动发现 CLI 并探测；`settings.json` 按需创建（默认不存在）。
2. 零配置即用；解析异常在设置页改路径（保存即验证生效），authoring 绑定经设置 `authoring.profileId`。
3. 无 DB migration；`agent_profiles` 结构不变，`secret_ref` 停写。
4. 回滚 = 还原旧版二进制：后端消失、`ai.pi` 执行报未配置、authoring 回到 503——与现状等价；`settings.json` 残留无害，可删。
5. 存量数据兼容：旧 profile 照常列出但带 `validationError` 标注，不阻塞其他功能。
