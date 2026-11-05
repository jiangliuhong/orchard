# Provider 扩展与配置

`src/providers/registry.ts` 定义统一 `AgentProvider`。新增实现只需注册，不向业务层增加 Codex / Pi 之外的固定枚举。生产默认注册 `codex-cli` 和 `pi-cli`，最初均为禁用。

接口包括稳定 ID、名称、配置 Schema、能力声明、`detect`、`models` 和 `turn`。调用通过 AbortSignal 取消；CLI 适配器等待进程清理，宿主不制造后端没有提供的消息。第三个测试 Provider 验证扩展契约，不是产品中的假模型。

## 能力与会话

两个内建适配器都将凭据留在本机 CLI 内，工作台不保存 API key；均不授予流程创作或分析节点工具能力。Pi 明确使用 no-tools、no-extensions 和 no-mcp。Codex 沿用 CODEX_HOME 的认证与 config.toml，保留用户的模型路由、openai_base_url、model_provider / model_providers 和自定义模型目录，兼容 Magpie 接管。调用覆盖 mcp_servers 为空、notify 为空，使用 read-only 并关闭 shell / unified exec、插件、应用、hooks、子 Agent 和计算机/浏览器等工具特性。结构化输出由最终 JSON 解析与宿主 Schema 校验完成。

Pi 转发真实 text_delta；Codex 首版报告开始、诊断、usage 和最终消息，不宣称逐 token 流式输出。两者都不承诺原生会话恢复：多轮创作通过工作台保存的历史重建。每次工作流运行使用独立输入，不隐式共享上一次 Agent 上下文。

## 传输模式（transport）

内建 Provider 配置增加可选 `transport` 字段（枚举 `legacy` / `native`），仍禁止任意 argv。旧配置缺少该字段时一律按 `legacy` 读取，升级不自动切换。设置保存合并现有 config，不会因只提交 executable 而丢失 transport。

- `legacy`（默认）：一次性 CLI 调用，行为与历史版本一致；多轮能力为宿主历史重建，`sessions` 能力为 `none`。
- `native`：常驻协议进程（Codex `app-server` stdio JSON-RPC；Pi `--mode rpc` JSONL）。节点与模型验证使用临时专属句柄（Codex ephemeral thread、Pi `--no-session`），结束后释放；创作多轮接入待持久化审核通过后启用，见 [agent-conversations 实施状态](../features/agent-conversations/implementation-status.md)。能力声明按配置计算（`sessions: "persistent"`、`nativeResume: true`）。
- 原生模式就绪检测在 `--version` 之外增加无模型握手探测（缓存 60 秒，配置变化立即失效）；探测失败返回具体错误码（PROTOCOL_UNSUPPORTED / TIMEOUT），可切回兼容模式，不自动回退或静默重试。握手成功不等于账号或模型可用，真实模型验证仍是显式触发的独立调用。
- 原生与 legacy 的单次进程都受全局进程配额与队列限制（见下节），禁止绕过限额。

## 设置

- `enabled` 与 readiness 分开：启用不表示已验证登录、模型权限或网络。
- 路径优先使用用户保存值，初始值从 PATH 及常见本地目录发现，执行时使用绝对路径。
- 检测执行 `--version`，不执行付费模型请求；显示的 ready 表示 CLI 可执行，实际认证错误原样报告为调用失败。
- 模型“验证”独立于 CLI 检测：先检查可执行状态，再直接调用所选模型一次，固定提示词要求仅回复 OK；非空最终文本表示本次请求可用。沿用适配器的无工具限制，不附加业务数据、不自动重试，可能产生模型用量。
- 验证要求 Provider 启用且模型存在，允许测试禁用模型，不更改设置。每个 Provider 只允许一个活动验证；60 秒总超时通过 AbortSignal 传递，客户端断开、关闭弹窗及服务关闭会取消并等待调用清理。detect 接口没有 AbortSignal，内建 CLI 检测最多 10 秒，结束后检查取消。
- 验证结果包含请求模型、配置修订、状态、耗时、时间和错误；实际模型 ID 仅在后端报告时返回。配置修订在验证中变化时结果失败，页面配置变更后清除旧结果；结果不持久化，无数据库结构变更。
- Pi 模型目录通过本机 `--list-models`；Codex 优先读取用户 config.toml 的 model_catalog_json，未配置时读取 models_cache.json，同时纳入配置中的 model。只将目录 slug 作为模型 ID，display_name 用于展示，不将显示名称替换为调用 ID。
- 已配置的自定义目录读取失败时提示错误，不悄悄回退到默认缓存。刷新仍合并现有模型，旧手动条目不会自动删除或改写；选择新目录中的准确 ID 后再验证。配置解析错误使用固定信息，避免将含密钥的 TOML 原文返回页面；不读取 auth.json。
- 自动目录为空时可以补充明确模型 ID，并配置默认值。目录存在不保证模型有调用权限。
- 设置中的模型管理支持搜索、启停、添加和删除。旧目录条目缺少 enabled 时按启用处理；状态保存在现有 models_json 中，无需建表或迁移。
- 模型刷新合并目录并保留启停状态和手动条目；删除记录保持隐藏，避免下次刷新重新出现。手动添加相同 ID 可以恢复。
- 默认模型被禁用或删除时清空默认值，不自动选用替代模型。新的模型选择与 Agent 创作能力目录仅包含已启用条目。
- 兼容旧的显式模型引用；明确禁用或删除的模型 ID 会在后续调用前被拒绝，已经启动的调用使用其原有配置快照。
- 创作必须选择明确 Provider 与模型；发布时固化 Agent 节点的有效模型。不会在运行时替换成新默认值。
- 禁用阻止尚未启动的调用；活动调用沿用其启动时配置。更改路径不等于改写历史版本，尝试记录保存实际配置修订与路径。

## 协议依据

实现时使用 OpenAI Docs 技能，检查官方 Developer commands、Non-interactive mode 和本机 Codex CLI 0.165.0 的 `exec --help` / `features list`；同时核对已安装 Pi 1.1.0 的官方 `docs/cli.md`、`docs/json.md`。Pi 帮助在受限环境会触发 trust 文件锁，因此使用包内官方文档核对。版本检测、JSONL framing、最终消息、错误及取消由模拟 CLI 子进程测试，真实账号调用验收另行执行。

JSONL 严格按 LF 分割，保留 JSON 字符串里的 Unicode 行分隔符；stdout 连续读取。Pi 的最终 assistant message_end/turn_end 为结果依据；Codex 使用 `-o` 结果文件与 turn.completed usage。

结果记录 `modelSource`：后端确实返回模型信息时为 reported；没有返回时保留明确请求的模型并标记 requested，不将其伪装为已确认的实际模型。进程流和 Codex 最终消息文件均限制为 8 MiB。
