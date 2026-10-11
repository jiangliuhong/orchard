# Proposal

## Why

当前 Orchard 的 AI 能力存在两处断路：

1. `ai.pi` 节点与 Pi authoring 的唯一后端 `HttpPiClient` 从未在 CLI/服务中接线，`PiAdapter` 缺少客户端时直接抛出 `PI_NOT_CONFIGURED`，`/api/drafts/:draftId/author` 固定返回 503。
2. `agent_profiles` 表可由工作台创建、可在创建工作流时选择，但运行时没有任何路径消费它——profile 是"只存不用"的空转数据。

与此同时，Orchard 的定位是本地优先的个人工作台，而宿主机上已安装的 `pi`（≥1.1.0）与 `codex`（≥0.16x）CLI 本身就是现成的推理后端：它们自持凭证（pi 的 provider 配置、codex 的 `~/.codex/auth.json`），且均支持非交互执行（`pi -p --mode json`、`codex exec --json`）。`HttpPiClient` 注释所写的 "gateway owns credentials" 模型，可以由本地 CLI 直接承担，无需自建 HTTP 网关。

`core.cli` 集成已具备生产级的进程控制（`shell: false`、超时、输出上限、取消、进程组终止）和受信注册机制（`CliToolRegistry`），本 change 复用这套基础设施，不新写进程管理代码。

## What Changes

- 新增 `CliPiClient`，实现现有 `PiClient` 接口，支持两种宿主机 CLI 后端：
  - `pi-cli`：`pi -p --mode json --no-session --no-extensions --no-mcp [--model <m>] [--tools ...]`，prompt 经 stdin 传入，解析 JSONL 取最终 assistant 消息与 usage/provider/model。
  - `codex-cli`：`codex exec --json [-m <model>] [-s <sandbox>] -o <tmpfile>`，从 `-o` 落盘文件读取最终消息。
- 子进程全部经 `ProcessController` 拉起，天然获得超时、取消、输出上限与进程组终止。
- 重解释 `agent_profiles` 字段语义，**不修改表结构、不新增 migration**：
  - `provider` → launcher 种类枚举 `pi-cli` | `codex-cli`（现有 UI 自由文本输入改为下拉选择）。
  - `model` → 传给 `--model` / `-m`；允许空字符串表示使用 CLI 默认模型。
  - `config_json` → 受控配置字段（超时覆盖、codex 沙箱模式、pi thinking level），仅枚举字段，不允许任意命令行参数注入。
  - `allowed_tools_json` → pi 的 `--tools` 白名单；codex 映射为沙箱级别（默认 `read-only`，显式授权才可 `workspace-write`）。
  - `secret_ref` → 弃用并置 NULL，凭证由宿主 CLI 自持。
- 宿主机 CLI 可执行文件在启动时自动发现（文档化的常见安装目录清单，`--version` 验证后钉定绝对路径），零启动参数、零环境变量；用户可在工作台系统设置中查看与修改各后端路径（保存时探测验证，立即生效）。
- 启动时与 `orchard doctor` 中探测宿主机 CLI 可用性（可执行文件存在、`--version` 可执行、pi 的 provider 就绪状态），探测结果（含解析路径与来源）在工作台系统设置与 Agent 管理界面可见。
- 运行时节点注册表注册 `ai.pi` 节点，执行时按 step config 中的 `agentProfileId` 解析 profile 并路由到对应 CLI 后端，接通"profile → 执行"断路。
- Pi authoring（`PiAuthoringService`）可配置为同一 CLI 后端（绑定经系统设置），替代永不接线的 HTTP 网关路径。
- CLI 后端的运行时错误（如凭证过期、地区限制 403、模型不存在）作为明确的 failed attempt 记录并透出原始 stderr，遵循"不伪造输出"约定。
- 输出契约校验沿用 `PiAdapter` 既有的 `assertValidJson` 后校验；失败视为可重试错误，交给 step attempt 重试机制处理。

## Capabilities

### New Capabilities

- `host-cli-agent-execution`: 通过宿主机 `pi` / `codex` CLI 执行 `ai.pi` 节点与 Pi authoring 请求，涵盖受信可执行文件注册、profile 解析、进程控制、输出解析、可用性探测与错误语义。

### Modified Capabilities

- None.（`pi-agent-authoring` capability 仍在 `implement-real-workflows` change 中未归档，其后端可用性语义由本 change 的新 capability 承接，归档时合并处理。）

## Goals

- `ai.pi` 节点在配置了有效 agent profile 且宿主机 CLI 可用时可以真实执行，输出通过 JSON Schema 校验。
- 不引入 HTTP 网关、不新增服务依赖、不保存任何裸密钥。
- 可执行文件路径只能来自受信解析（系统设置或启动时自动发现并钉定），运行请求不可临时指定 executable，与 `core.cli` 的受信注册规矩一致。
- CLI 后端故障（凭证、网络、地区限制）在 Run/Step/Attempt 历史中可定位、可重试。

## Non-goals

- 不修改 `agent_profiles` 表结构；若实现中发现确需加列，必须先走 `docs/database-change-review.md` 审核流程，审核通过前不落任何 migration。
- 不实现跨次调用的 Agent 会话续接（pi `--session-id` / codex `exec resume` 留作后续扩展）。
- 不实现结构化输出的强约束（不依赖 codex 实验性 JSON Schema 选项），仅做 prompt 约定 + 事后校验 + 重试。
- 不支持 pi / codex 之外的 CLI 后端插件化，枚举写死为两种。
- 不在沙箱之外放宽工具授权；默认无工具 / 只读沙箱。

## Impact

- 代码：`src/integrations/pi/`（新增 `CliPiClient`、后端解析/探测与输出解析）、`src/runtime/local-nodes.ts`（注册 `ai.pi` 节点）、`src/cli/main.ts`（后端接线与探测）、`src/server/app.ts`（Agent API 语义收紧、新增设置 API）、`src/web/App.tsx`（创建 Agent 表单改为 launcher 选择、设置页接入 CLI 后端管理）。
- 数据库：无 migration。`agent_profiles` 仅重解释字段语义；`secret_ref` 弃用但保留列以避免结构变更。
- 测试：`CliPiClient` 输出解析（正常 JSONL、错误事件、超时、取消、凭证失败）与 profile 解析需要新增单测；e2e 使用 fake CLI 可执行脚本模拟 pi/codex 行为。
- 安全：受信注册 + 默认最小权限（`--no-tools` / `-s read-only`）+ cwd 锁定 workspace；风险集中在"CLI 拥有宿主机凭证"这一事实，由本地优先的单使用者定位与既有安全边界（回环监听、Host/Origin 校验）覆盖。
- 已知环境风险：宿主机 `pi` 默认 provider（openai-codex OAuth）在受限地区刷新 token 失败（403）。此类错误将以 failed attempt 形式透出，用户需自行配置可用 provider。
