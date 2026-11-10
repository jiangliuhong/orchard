# 技术验证记录

日期：2026-11-10

状态：本页第 1–4 节保留编码前的基础探针记录。当前实现已完成真实 SSH、Pi/Codex 生产适配器与工作流闭环验证，见第 5 节及 [implementation.md](./implementation.md)。

## 1. 环境与复现

- Pi：1.5.0；模型：`openai-codex/gpt-6.1-sol`。
- Codex CLI：0.166.0；沿用本机默认模型配置。
- 使用 [provider-probe.mjs](./provider-probe.mjs)，不修改生产 Provider 适配器。

从仓库根目录运行（会调用本机模型服务，产生相应用量）：

```bash
PROBE_PI_MODEL=openai-codex/gpt-6.1-sol \
  node docs/features/2026-11-10-git-project-agent/provider-probe.mjs .orchard
```

最后一个参数为要验证的 Orchard 数据目录；可替换为当前实例的自定义目录。脚本仅在该目录的 `project-git/verification/` 下生成随机数字测试文件，不读取真实源码或认证文件、不执行 push。生成的每个 Provider 工作目录在结束时删除，父目录可能保留。

## 2. 实测结果

| Provider | 协议 | 工具完成事件 | 耗时 | 结果 |
| --- | --- | --- | --- | --- |
| Pi | RPC | 3 | 10771 ms | 通过 |
| Codex | app-server JSONL | 2 | 9771 ms | 通过 |

检查内容：

1. 子进程/会话使用生成测试目录作为 cwd。
2. 要求模型执行 pwd 并读取 `left.json`、`right.json`，输入 prompt 不包含文件内的随机数。
3. 捕获工具完成事件，不以模型自称读文件作为证据。
4. 最终结果必须是可解析 JSON，sum 等于两个随机值之和，cwd 等于实际测试目录，且至少有一次工具完成事件。
5. 两个 Provider 同时运行，各自目录和数字不同，均返回正确结果。

Pi 使用 `--mode rpc --no-session --no-extensions --no-mcp`，不传 `--no-tools`。Codex 不传 Orchard 当前的全量工具禁用参数，thread 使用 `sandbox: workspace-write`、`approvalPolicy: never`；未使用绕过审批/沙箱参数。这证明正常项目文件读取与命令调用可行，不证明所有命令在 Provider 本身的策略下都可执行，也没有新增 Orchard 只读限制。

## 3. 对设计的结论

当前已无“必须自行构建受控只读工具桥”的前置要求。两个原生协议都具备本 feature 所需的基础目录、工具与 JSON 输出能力，可以进入分阶段实现。

生产集成必须按场景传递执行策略，普通节点/创作会话保持原行为。Codex 当前适配器会拒绝工具请求，最终文本还可能混入工具前的 commentary；仍需验证和调整事件处理、最终消息选择、审批处理及连接指纹。探针只取最终 Agent 消息，没有证明现有生产适配器无需修改。

## 4. 基础探针结束时尚未完成的验证（历史记录）

- 真实 SSH ls-remote、首次 clone、后续 fetch、主机信任、加密密钥及 agent 接入。
- Orchard 入队配置固定、准备时 SHA 固定、项目引用校验和恢复依赖拦截。
- 生产 Provider 会话/事件集成、多次工具调用、中间说明与最终 JSON 分离、失败与取消。
- 固定 SHA 源码物化、缓存/快照生命周期、取消/超时/重启后的清理。
- 实际分析源码，节点输出传递给后续节点和顶层 result 的完整工作流。
- 设置存储统计、错误与部分结果、实际 UI 检查。

本次无真实远端推送测试，无宿主凭据访问测试，不声称存在 Agent 文件或命令隔离。没有更改表结构、索引或迁移声明。

## 5. 编码后的真实集成验证

可从仓库根目录复现（SSH 测试启动临时本机 sshd；模型测试会产生用量）：

```bash
# 项目、恢复、API、存储与 Provider 契约
TMPDIR=/private/tmp node --import tsx --test \
  tests/project-git.test.ts tests/project-recovery.test.ts \
  tests/project-api.test.ts tests/project-providers.test.ts tests/storage-usage.test.ts

# 生产适配器独立真实模型验证
TMPDIR=/private/tmp ORCHARD_MODEL_INTEGRATION=1 \
  node --import tsx --test tests/project-model.integration.test.ts

# 真实 SSH + Pi/Codex 生产适配器 + 后续节点 + 顶层 result
TMPDIR=/private/tmp ORCHARD_SSH_INTEGRATION=1 ORCHARD_MODEL_INTEGRATION=1 \
  node --import tsx --test tests/project-ssh.integration.test.ts
```

`PROBE_PI_MODEL` 可覆盖 Pi 模型（缺省 openai-codex/gpt-6.1-sol）；`PROBE_CODEX_MODEL` 可覆盖 Codex 模型（缺省本机配置的明确 model）。CLI 从 PATH 发现。默认全量测试跳过上述需外部环境的真实模型/SSH测试。

实测通过：

- Pi、Codex 生产 Registry / RPC / app-server 双文件工具读取、正确数值、实际 cwd、最终 Schema JSON 和工具完成事件计数。
- 临时生成 host/client 密钥并直接使用受信公共 host key；非默认 SSH 端口，真实 ls-remote / clone / 后续 fetch。
- 分支固定 SHA、同项目并发独立快照、入队后项目禁用/换分支不改写已入队配置；缓存更新后来源与新提交一致。
- 两个生产 Provider 分别分析临时 SSH 仓库的 left.ts/right.ts；带可核验文件行号的节点 JSON 被后续 Node.js 节点消费，顶层 result 得到预期结果，attempt 保存 SHA 与工具计数。
- 未知/变化主机密钥、未解锁的加密身份、分支不存在、取消、服务断开均安全失败，不返回 raw stderr，不离线使用旧缓存。
- Chromium 实际页面检查覆盖项目/存储、1280px/390px、浅/深/系统主题与长名称/地址，无页面横向溢出。详情表格在窄屏可横向滚动。

仅操作自动生成的测试仓库与临时密钥，不读取真实私钥内容、不执行任何远端推送，也不声称 Agent 被隔离。真实磁盘耗尽、全部进程崩溃时序、真实内部跨设备挂载和 Linux 页面/文件系统环境仍未逐项实测；相关代码及已有故障注入测试不能替代这些环境验收。
