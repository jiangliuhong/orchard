# P0 协议检查与实施记录

本记录是首轮静态协议检查，不代表 P0 通过。未发送模型请求、未改动数据库、未操作已有原生会话。

**最新决策：取消归档，改为直接删除。** 下表归档行和原门禁编码说明保留为历史记录；不再作为当前交付要求。当前 Provider 删除方案见[直接删除可行性评估](./delete-provider-plan.md#7-后续编码进展)；锁/guard 核心、持久存储身份、真实 CLI 基本删除实测与待审批项目见[完整实施清单](./implementation-status.md)。

## 版本与证据来源

- `codex --version`：`codex-cli 0.167.0`。
- `pi --version`：`1.5.1`。
- Codex：`codex app-server --help`、`codex app-server generate-ts --help`，以及本机 CLI 生成的 TypeScript 协议。
- Pi：安装包 `@earendil-works/pi-coding-agent` 的 `docs/rpc.md`、`docs/rpc-commands.md`、`docs/sessions.md`、`dist/modes/rpc/rpc-types.d.ts`，以及 `pi --help`。

复核 Codex 协议（只生成文件，不启动对话）：

```sh
out=$(mktemp -d /tmp/orchard-codex-protocol.XXXXXX)
codex app-server generate-ts --out "$out"
# 查看 ClientRequest.ts 和 v2 下对应 Params/Response 类型
```

版本变化需重新检查；协议存在不代表适配器已实现，也不代表真实行为已经验证。

## 能力矩阵

| 能力 | Codex 0.167.0 | Pi 1.5.1 | 下一步证据 |
|---|---|---|---|
| 内置规则/Skills 及全局边界 | `ThreadStartParams` 有 baseInstructions/developerInstructions；待实测 | CLI 有 --skill/--no-skills/--no-context-files；待实测 | 验证隔离祖先/全局规则，不能重复加载 |
| 共享只读 cwd、独立身份 | 待实测 | 待实测；旧适配器从 cwd 推导存储根，不符合新契约 | 并发、只读文件系统、工具身份负例 |
| 不透明引用 | 新契约边界校验已有单测；旧适配器未接入 | 同左 | 适配器私有 payload 校验、所属对话、CAS |
| 仅平台查询工具 | 现适配器禁用 MCP；未接入 | 现适配器 --no-mcp/--no-tools；未接入 | 独立会话授权、工具 allowlist 与越权测试 |
| 原生多轮/重启恢复 | 现适配器 thread/start、thread/resume；需新工作区回归 | 现适配器准确 --session 文件恢复；需回归 | 两轮、回收、重启、缺失引用负例 |
| 无额外生成的宿主反馈 | `thread/inject_items` 接收原始 Responses API items；仅协议证据 | 当前 RPC 命令类型无注入宿主事实命令 | 验证官方宿主通道、消息角色、持久化、去重及模型调用次数 |
| 同 session 模型切换 | `TurnStartParams.model` 声明覆盖本轮及后续；未验证失败语义 | RPC 有 set_model；未验证失败/重启语义 | 实际模型与身份核对，失败保持旧状态 |
| 原生归档/恢复/核对 | 有 thread/archive、thread/unarchive、thread/list/read；未验证幂等及状态核对 | 当前 RPC 无 archive/restore 命令；属于现传输能力缺口 | Codex 故障注入；Pi 另行评审官方等价能力，不直接移动文件 |
| 原生压缩可观察性 | 有 thread/compact/start；自动事件需验证 | RPC 文档有压缩与状态事件；待实测 | 验证实际事件及 UI 可展示范围 |

## 阻塞与禁止降级

1. **原归档缺口已因产品改为直接删除而取消，不再阻塞。** 当前由 Provider 抽象直接删除：Codex 使用 thread/delete，Pi 使用官方明确支持的原生会话文件删除。删除范围、停机证明、不存在核对、跨存储部分成功和幂等仍须验证；详见[直接删除可行性评估](./delete-provider-plan.md)。
2. Pi 无额外生成的宿主反馈还没有可用 RPC 路径证据。不能用 prompt/follow_up 伪装系统事实或隐式触发收费轮次。官方扩展/SDK 桥接若成为候选，需先完整审阅相关文档并验证工具隔离。
3. Codex 的 inject_items 不能仅因接收任意 JSON 就认定支持宿主反馈；必须验证允许的消息类型、持久性和幂等核对。
4. 两个 Provider 的共享只读 cwd、受控平台查询和准确恢复尚未通过真实集成验证。当前不接通新的 multi 入口。
5. 首轮检查时 schema 尚未审核；后续用户已明确批准，SQL、AgentStore 和 DB 重置步骤已编码测试，最新进展见实施清单。生产激活及实际旧数据重置仍未执行。

## 首轮编码（归档方案时期，门禁现已替换）

- `src/agent/provider-contract.ts`：十项必要 multi 能力与绑定安装版本的证据门禁；未知/未验证默认阻塞。不透明引用校验 Provider、版本、严格 JSON、深度/大小预算，再交给对应适配器校验私有 payload；不解析 CLI ID 或路径。
- `tests/agent-provider-contract.test.ts`：第三种测试 Provider、错误 Provider/版本、适配器校验、循环/稀疏数组/访问器/超预算负例及能力门禁，共 6 项测试。
- 这些是独立的 P0 基础契约，**尚未替换旧 Provider/session 契约或接入生产运行时**。所属对话校验、持久化和 CAS 留待 schema 审核后的统一内核实现。

验证：`npm run typecheck` 通过；直接执行新增契约、agent-sessions、project-providers、providers 共 29 项测试通过（包含新增 6 项）。`npm test` 在 pretest 迁移检查阶段被 `Incomplete local dependency lock` 阻塞，未进入全量测试；本轮未修改锁文件或迁移检查。未执行付费模型调用、原生归档/恢复、打包或页面验收；本轮无 UI 修改。
