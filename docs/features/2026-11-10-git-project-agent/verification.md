# 技术验证记录

日期：2026-11-10

状态：双 Provider 原生协议基础探针通过；真实 SSH 与工作流闭环尚未验证，功能尚未实施。

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

## 4. 尚未完成的验证

- 真实 SSH ls-remote、首次 clone、后续 fetch、主机信任、加密密钥及 agent 接入。
- Orchard 入队配置固定、准备时 SHA 固定、项目引用校验和恢复依赖拦截。
- 生产 Provider 会话/事件集成、多次工具调用、中间说明与最终 JSON 分离、失败与取消。
- 固定 SHA 源码物化、缓存/快照生命周期、取消/超时/重启后的清理。
- 实际分析源码，节点输出传递给后续节点和顶层 result 的完整工作流。
- 设置存储统计、错误与部分结果、实际 UI 检查。

本次无真实远端推送测试，无宿主凭据访问测试，不声称存在 Agent 文件或命令隔离。没有更改表结构、索引或迁移。
