# Tasks

## 1. ProcessController stdin 扩展（D2）

- [x] 1.1 `src/integrations/cli/types.ts`：`CliProcessCommand` 增加可选 `stdin?: string` 字段
- [x] 1.2 `process-controller.ts`：`stdin` 存在时 `stdio[0]` 用 `"pipe"`，spawn 后单次写入并 `end()`，`EPIPE` 静默忽略；无 `stdin` 时行为与现状完全一致（超时/取消/输出上限路径不动）
- [x] 1.3 单测（`tests/core-cli.test.mjs` 或新文件）：stdin 透传、子进程早退时 EPIPE 不误报、无 stdin 时既有 `core.cli` 行为零回归

## 2. Agent profile 校验层（D5）

- [x] 2.1 新增 `src/integrations/pi/profile.ts`：纯函数校验——launcher 枚举、model 空串/≤200、`config` 仅 `{ timeoutMs?: 1..900_000, thinkingLevel?: 枚举 }` 拒绝其余键、pi 专属 `thinkingLevel` 在 codex 上报错、allowedTools 规则（pi 白名单每项 ≤100 字符 ≤50 项 / codex 仅哨兵 `"workspace-write"`）
- [x] 2.2 `AgentProfileRepository.create` 接入校验，`secretRef` 停写（不入参即存 NULL）
- [x] 2.3 单测：校验矩阵（合法/非法 provider、注入型 config 键、超界 timeoutMs、codex 哨兵）

## 3. 设置存储与后端解析（D1）

- [x] 3.1 新增设置存储模块：`dataDir/settings.json`（0600、按需创建、命名空间结构 `cli`/`authoring`），读/写/清除覆盖项
- [x] 3.2 新增 `resolveCliBackends(settings)`：设置路径（仅绝对路径）优先 → 常见目录清单发现（nvm 版本降序、`~/.npm-global/bin`、`/opt/homebrew/bin` 仅 darwin、`/usr/local/bin`、`~/.local/bin`、`~/.cargo/bin` 仅 codex，每候选 `--version` 验证取首个通过者）→ 未命中不注册；结果钉定绝对路径并标记 `source: "settings" | "discovered"`
- [x] 3.3 后端注册表支持原子替换条目（设置保存热生效；进行中执行不受影响）
- [x] 3.4 单测：优先级顺序、多 nvm 版本取最新、候选探测失败跳过、全部未命中返回空、非绝对路径的设置值拒绝

## 4. 探测模块（D7）

- [x] 4.1 新增 `src/integrations/pi/probe.ts`：L1 `--version`（10s 超时、64 KiB 上限）→ `{ available, version?, path, source, reason? }`；L2 仅 pi——对引用该 launcher 的 profile 跑 `pi auth check --model <m> --json --no-refresh`（model 为空标 `unchecked`），codex 的 L2 即 L1
- [x] 4.2 单测：fake 可执行文件探测（版本正常/超时/不可执行），L2 结果映射

## 5. CliPiClient 与输出解析（D3/D4/D8/D10）

- [x] 5.1 pi 参数构造器：固定 `-p --mode json --no-session --no-extensions --no-mcp`；无 tools 加 `--no-tools`、有则 `--tools a,b`；model 非空才传；节点默认 `--thinking off`、profile 显式覆盖
- [x] 5.2 pi JSONL 解析器：取最后一个 `turn_end` 的 assistant 消息（拼接 `content[]` 的 `text` 块）与 provider/model/usage；`error` 事件即失败；未知事件宽容跳过；无最终消息报 `INVALID_PI_OUTPUT`
- [x] 5.3 codex 参数构造器与执行：`exec --json [-m] -s read-only|workspace-write -o <tmpfile>`，tmpfile 走 `mkdtemp` 私有目录、读后 `rm -rf`；最终消息只从 `-o` 文件读，usage 从 JSONL `turn.completed`，model 缺失回退 profile
- [x] 5.4 `CliPiClient implements PiClient`：`createSession` 按 launcher 路由，prompt 经 stdin，cwd 锁定 workspaceRoot，限额按 D10（默认 300s、硬顶 900s 只降不升、输出 8/4 MiB 不可覆盖、killGrace 2s）
- [x] 5.5 错误映射（D8 表）：code/retryable/stderr 摘要（2 KiB 截断）+ exitCode；运行请求中出现的可执行路径字段一律忽略
- [x] 5.6 单测：JSONL fixtures（正常/截断/无 assistant/error 事件）、参数构造矩阵、错误码与 retryable 映射

## 6. ai.pi 节点注册（D6）

- [x] 6.1 新增 `src/integrations/pi/nodes.ts`：`registerAiNodes(nodes, { agents, client, workspaceRoot })`——configSchema `{ agentProfileId }`、inputSchema `{ prompt: 1..100_000 }`、sideEffects `"unknown"`；执行链 = 查 profile → D5 校验 → `PiAdapter.execute`（outputSchema 透传，校验失败走默认 retryable）
- [x] 6.2 配置错误语义：profile 不存在 / launcher 未注册 → 对应 code + `retryable: false`
- [x] 6.3 `createLocalNodeRegistry(options?)` 接线：agents 可用即注册（后端未解析不阻塞注册）
- [x] 6.4 单测：profile 解析路由、未配置报错、输出 schema 校验失败重试语义

## 7. 服务端 API（D1/D5/D7）

- [x] 7.1 `app.ts` 新增 options 与路由：`GET /api/settings/cli-backends`（即时 L1 + `{ path, source }`，`?readiness=deep` 触发 L2 不缓存）；`PUT` 保存路径先探测、失败拒收返回原因、成功原子替换；PUT 空值清除覆盖回退自动发现
- [x] 7.2 `POST /api/agents` 收紧：provider 枚举校验、model 允许空串、config 走 D5 校验层、移除 `secretRef` 入参
- [x] 7.3 `GET /api/agents`：存量非法 provider 行附加 `validationError` 标注（不隐藏）
- [x] 7.4 集成测试：设置读写与探测失败拒收、agent 创建校验、validationError 标注

## 8. main.ts 接线（D1/D9）

- [x] 8.1 启动时 `resolveCliBackends` + 打印每后端一行 L1 结论；构建 `CliPiClient`/`PiAdapter` 并把 `{ agents, client, workspaceRoot }` 传入 `createLocalNodeRegistry`
- [x] 8.2 Pi authoring：后端可用时构造 `PiAuthoringService` 并接 `authorPi` option（`authoring.profileId` 设置钉 profile）；未配置任何后端保持不传 → 既有 503 语义原样
- [x] 8.3 移除 doctor 中硬编码的 "Pi: not configured"（由第 9 组取代）

## 9. doctor 探测（D7）

- [x] 9.1 doctor 输出每个后端的 L1+L2 结论、解析路径、来源与不可用原因；无后端时明确输出未配置

## 10. Web UI（D1/D5）

- [x] 10.1 创建 Agent 表单：provider 改 launcher 下拉（`pi-cli`/`codex-cli`）、model 改可选、codex 后端显示"允许写工作区"授权开关（映射哨兵）；显示后端可用状态
- [x] 10.2 设置页新增"CLI 后端"卡片：每 launcher 显示路径/来源/可用性，可编辑路径（保存即探测验证）、"检测就绪状态"按钮触发 deep 探测；接入真实 API 替换该区块的 localStorage 存根（其余存根项不动，留待独立 change）

## 11. 端到端验证（D11）

- [x] 11.1 fake `pi`/`codex` 可执行脚本 fixtures：模拟 JSONL 输出、stdin 读取、`-o` 文件写入、exit≠0、超时挂起
- [x] 11.2 集成：经设置注册 fake 后端跑通 `CliPiClient`（stdin 透传、tmpfile 清理、超时、取消、stderr 透出）
- [x] 11.3 e2e：`ai.pi` 节点 + fake CLI 完成一次 run 并可在 Run/Step/Attempt 历史定位；authoring 走 fake pi 返回合法 patch 并落盘
- [x] 11.4 回归：`pnpm test` + `pnpm test:e2e` 全绿；`pnpm typecheck` 通过

## 12. 合规与收尾

- [x] 12.1 确认零 DB migration、零表结构变更（AGENTS.md 红线）；`secret_ref` 仅停写不删列
- [x] 12.2 对照 spec 场景逐条核验（受信解析 5 场景、profile 校验、节点执行、进程控制、最小权限、输出校验、探测可见、错误透出、authoring 复用）

## 13. Review 修复（验证报告后续）

- [x] 13.1 doctor 在实例锁被占用时优雅跳过 L2 而非崩溃（实测验证）
- [x] 13.2 W1：codex model 改为事件流优先提取，缺失回退 profile/"codex"（D4 原文语义）
- [x] 13.3 W2：draft rootPath 对齐 `workspaces/default/drafts` 约定（与 WorkflowDraftService 一致）
- [x] 13.4 W3：e2e 补设置 PUT 接线层断言（相对路径 400、绝对路径探测钉定 source=settings、空值回退发现）
- [x] 13.5 S1：GET /api/agents 每行仅计算一次 validationError
