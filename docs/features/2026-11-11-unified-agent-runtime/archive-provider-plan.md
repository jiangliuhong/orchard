# Provider 原生会话归档适配方案

状态：**已废弃，保留历史调研证据。** 用户已决定直接删除、不做归档，以下归档候选不再实施；当前方案见[直接删除可行性评估](./delete-provider-plan.md)。未修改数据库、未归档任何已有会话。

## 1. 抽象边界

归档由 Provider 实现，不要求所有 CLI 具有同名 RPC，也不把 RPC 命令集合当作 Provider 能力上限。

```text
AgentRuntime
  archive(reference, operation)
  restore(reference, operation)
  inspect(reference)
       ↓
Provider Adapter
  CLI 原生协议 / 官方 SDK / 经评审的原生存储等价操作
```

沿用 design.md §12.1 的 AgentSessionProvider；不另建业务侧 Codex/Pi 分支。Runtime 只负责 owner/活动轮次校验、对话锁、operation 幂等、generation CAS 和展示状态。原生身份、控制连接、路径、原生状态核对全部由 Provider 封装。

- `release` 只关闭执行连接，不等于 `archive`。
- 归档与恢复不发送 prompt，不触发模型生成。
- 返回确认后的原引用或更新后的引用；不能恢复到新建会话。
- 超时/响应丢失返回未知交付状态，由 inspect 核对后再决定是否重试。
- 能力状态应说明“传输尚未适配”还是“原生无等价能力”；不能混为一谈。

## 2. Codex：直接使用官方 App Server 生命周期协议

本机 0.167.0 生成的协议确认：

| 操作 | 原生调用 | Provider 行为 |
|---|---|---|
| 归档 | `thread/archive { threadId }` | 校验私有引用后调用；宿主必须已确认无活动任务 |
| 恢复 | `thread/unarchive { threadId }` | 检查响应 thread.id 与原 ID 一致；不调用 thread/start |
| 核对 | `thread/list { archived: true/false, ... }` | 分页按精确 ID 匹配；不要把第一页没有匹配当作不存在 |
| 恢复执行连接 | `thread/resume { threadId, ... }` | 恢复归档后需要继续执行时再准确 resume，不用 cwd 最近会话 |

`Thread` 的 `status` 是执行状态，不是归档标志，不能用 idle/notLoaded 推断是否归档；目前生成的 Thread 类型没有 archived 布尔字段。

适配器可以使用独立、无模型请求的短生命周期 App Server 控制连接。必须使用和原会话相同的原生存储配置/身份，不能因换连接而换 CODEX_HOME。

查阅的官方 main 源码中，归档还可能处理派生子会话，并尝试停止已加载 thread；因此宿主的 stopped 前置检查不能省略，也不能直接把官方 main 行为等同本机版本保证。重复 archive/unarchive、归档空会话、控制连接中断、分页状态核对仍须对本机 0.167.0 实测。

证据：

- 本机 `codex app-server generate-ts --out <临时目录>`：`ThreadArchiveParams`、`ThreadUnarchiveParams/Response`、`ThreadListParams`、`Thread`。
- [官方实现 thread_processor.rs（固定提交）](https://github.com/openai/codex/blob/d9a32c178951695f365faa36a39d542e06a96e4f/codex-rs/app-server/src/request_processors/thread_processor.rs)：`thread_archive_response`、`thread_unarchive_response`、`prepare_thread_for_removal`。
- [官方 App Server 文档（同提交）](https://github.com/openai/codex/blob/d9a32c178951695f365faa36a39d542e06a96e4f/codex-rs/app-server/README.md)。

## 3. Pi：原生会话文件机制可作为候选，但当前没有原生归档命令

进一步检查了 **CLI 交互实现、SDK SessionManager、官方存储文档**，不只检查 RPC。

本机 Pi 1.5.1 的证据：

1. `session-format.md` 明确会话保存为 JSONL，支持以删除文件删除会话。
2. 交互 `/resume` 删除实现先调用 `trash`，失败后 `unlink` 永久删除。它不是满足本产品保留/恢复约束的归档接口，不能直接复用。
3. 官方 SessionManager 支持指定 sessionDir、按确切文件 open；列表枚举指定目录直接子级的 `.jsonl`。没有查到 archive/unarchive API。
4. `--session <path>` 支持准确原生恢复；恢复前必须确认文件存在并核对 session ID。不能依赖 SessionManager.open 对缺失文件的默认行为保证失败，也不能用 continueRecent。

因此推荐进一步评审的是 **Pi Provider 内部基于官方原生文件存储的保留式归档**，而不是平台只改 archived 标志，也不是调用删除：

```text
<providerManagedRoot>/
  active/<受管会话位置>
  archived/<受管会话位置>
```

候选执行流程：

- 平台只分配 providerManagedRoot；内部文件布局及定位完全属于 Pi Adapter。
- 归档前停止并确认退出所有能写目标文件的受管连接，取得 Provider 级目标会话锁。
- 只处理引用指向且已验证身份/归属的原生会话文件；拒绝 symlink、路径越界及未知资源。
- 在同一文件系统内移动原生文件到 Provider 私有归档范围；不修改 JSONL、不重放消息、不生成新 session ID。文件是否有附件/分支引用等伴随依赖必须先核实，不能假设一个文件永远足够。
- 用原生读取能力验证同一个 session ID、cwd 和历史，再返回新不透明引用，由 Runtime CAS 保存。
- 恢复执行逆操作，并使用准确 `--session <恢复后文件>` 打开同一个原生会话。
- inspect 检查旧/新精确位置及身份：仅 active/仅 archived/两处都有/均无分别处理；后两种不能宣称成功，保留 operation 诊断。
- 记录可恢复的 operation 意图，覆盖“移动完成但引用尚未持久化”的崩溃窗口；重试不能覆盖已有目标文件。恢复冲突不自动替换或合并历史。
- 不调用系统回收站：可能跨文件系统，恢复定位/权限/语义不稳定，而且原生删除具有 unlink 降级。

**边界：这不是 Pi 官方提供的归档状态，而是 Adapter 管理原生存储的等价实现候选。** 独立 Pi CLI 若显式传入归档文件路径，仍可能打开它；平台的归档禁止执行依赖 Provider 授权和宿主状态检查。原生列表不可见、同 ID 可恢复、文件依赖完整性和故障恢复必须实测。

按 design.md §10.4，这个方案需要单独评审后才能实施。如果要求严格限定“CLI 自带归档/恢复功能”，当前 Pi 1.5.1 不能满足；不能仅靠 Provider 抽象把不存在的原生命令变成已支持。

证据：

- 本机安装包 `docs/session-format.md`、`docs/sessions.md`。
- 本机 `dist/modes/interactive/components/session-selector.js` 的 `deleteSessionFile`（trash → unlink）。
- 本机 `dist/core/session-manager.js` 的 `listSessionsFromDir`、`SessionManager.open`。
- [官方 SessionManager 源码（固定提交，非本机版本承诺）](https://github.com/earendil-works/pi/blob/4839e41d6463d759a92ee55f4ca7c8ae57e52c9c/packages/coding-agent/src/core/session-manager.ts)。

## 4. 实施建议

1. 先按统一 Provider 生命周期接口实现 Codex 原生协议适配与无模型生命周期测试，不要求 Pi 和 Codex 走同一种传输。
2. Pi 原生文件存储候选单独评审后，做临时受管会话的归档/恢复实验；不对已有用户会话试验。
3. 无法提供等价能力的 Provider 返回标准不支持/未验证状态，不做假归档；这不阻止独立基础模块和其他 Provider 的实现，但不能宣告该 Provider 的 multi 完整验收。
4. 数据库仍须另行审核。本文不授权迁移或旧数据重置，也不把协议调研当作真实 CLI 验收。
