# 流程格式和脚本协议

工作流由 `workflow.json`、可选 `layout.json` 和 `scripts/` 中的脚本构成。示例完整文件位于 `examples/decision/`，需要将示例中的 `agentConfigId` 替换为本地创建的 Agent 模型配置 ID 后发布。

## 定义

`formatVersion` 为 `1`。字段包括固定 `id`、`name`、`inputSchema`、`outputSchema`、`entryNodeId`、`nodes`、`edges` 和最终 `result` 绑定。节点包含稳定 ID、名称、类型、配置、输入绑定、可选输入 Schema 和输出 Schema。

节点类型：

| 类型 | config | 输出 |
| --- | --- | --- |
| `code.nodejs` | `script`，可选 `timeoutMs` | 默认导出函数的 JSON 返回值 |
| `agent` | `prompt`，可选 `agentConfigId` / `project: {projectId}` / `timeoutMs` | 经输出 Schema 校验的 JSON |
| `shell` | `script`，可选 `resultMode` / `timeoutMs` | 默认 `{stdout,stderr,exitCode}`；`json` 模式读取结果文件 |
| `script` | `scriptId`、`scriptVersionId`，可选 `timeoutMs` | 固定脚本版本的输出；运行时校验该版本 Schema |
| `switch` | `cases: [{label,value}]`、`defaultLabel` | `{edgeId,value,reason}` |

默认 Agent 引用位于 `defaults.agent.agentConfigId`，节点通过 `config.agentConfigId` 整体覆盖，缺省继承工作流默认配置。Agent 节点缺少有效配置来源时校验失败；不接受直接的 `providerId`、`modelId` 字段。发布保留配置 ID，新建运行时统一解析并保存配置修订和明确模型，详见[Agent 模型配置](../product/agent-model-configs.md)。

连线包含 `id`、`from`、`to`，`to: null` 表示结束。普通节点至多一个后继，也可以无后继表示结束。Switch 每个 case 和默认分支都需要唯一 label 连线，按 JSON 标量等值比较，重复条件会被拒绝。未匹配进入默认分支。

不支持环、普通节点扇出、并行汇合语义和不可达节点。可以让互斥分支到达共享后继，但共享后继的输入只能引用所有路径必经的结果。

## 输入绑定

```json
{
  "source": "object",
  "properties": {
    "original": { "source": "workflow" },
    "analysis": { "source": "node", "nodeId": "analyze", "pointer": "/action" },
    "constant": { "source": "literal", "value": "literal text" }
  }
}
```

还支持 `{source:"array",items:[...]}`。pointer 使用 JSON Pointer：空字符串为整个值，`/a~1b` 读取键 `a/b`，`~0` 表示 `~`。不会执行 JS 表达式或字符串命令替换。引用节点需支配当前节点，最终 result 需在所有终点可用；缺失值不会默认为 null。

Schema 使用严格 JSON Schema 校验。声明 required 字段时同时在 properties 中定义，不支持异步 Schema。实际运行输入输出再次校验。

## 最终输出

工作流顶层的 `result` 使用与节点输入相同的绑定语法，决定整个流程最终返回什么，不会自动采用最后一个节点的输出。顶层 `outputSchema` 校验该结果，区别于每个节点自身的输出 Schema。

例如从总结节点提取纯文本：

```json
{
  "result": { "source": "node", "nodeId": "summarize", "pointer": "/summary" },
  "outputSchema": { "type": "string" }
}
```

也可使用 `source: "object"` 组合不同节点及原始输入，或使用数组、常量、整个节点输出。引用节点必须在所有结束路径中可用；结果字段路径在运行时解析，缺失字段或最终 Schema 校验失败会使整次运行失败，即使此前所有节点已成功。编辑页的“最终输出”表单直接写入上述现有字段，不改变执行顺序或增加业务节点。

## Agent 项目上下文

Agent 节点可增加 `config.project: { "projectId": "local-project-id" }`。只接受稳定本机项目 ID，不接受输入动态覆盖远端、分支、凭据或 cwd；嵌套未知字段会被拒绝。没有 project 时完全保持普通节点行为。

发布、入队时检查启用项目、风险确认及 Provider 项目分析能力。入队保存内部项目配置快照，准备阶段 fetch 并固定 SHA；输出仍只由 outputSchema 决定，不强制注入 SHA。分支/SHA/未展开项等来源保存在 attempt execution.project 中。项目节点默认准备与分析合计超时 10 分钟，可使用 timeoutMs 设置时限。源码快照可写，不是安全沙箱，详见 [Git 项目分析与存储空间](../product/git-project-analysis.md)。

## Node.js

```ts
export default async function run(input: { text: string }) {
  console.log("processing");
  return { normalized: input.text.trim() };
}
```

Node 脚本在独立进程中执行，stdin 为 JSON。宿主 wrapper 调用默认导出函数并保存 JSON 结果，stdout / stderr 作为日志。相对依赖必须带完整文件名且属于版本脚本；允许 Node 内置模块，不自动安装 npm 包。发布时转换 TypeScript，不导入或执行业务脚本。

## Shell

```bash
#!/bin/bash
read -r input
printf 'received: %s\n' "$input"
```

使用 `/bin/bash` 显式执行固定脚本，输入不会拼入命令行。默认输出为进程 stdout / stderr / exitCode。配置 `resultMode: "json"` 时，脚本需将业务 JSON 写到宿主提供的 `$ORCHARD_RESULT_FILE`；无论文件是否存在，非零退出都视为失败。

脚本运行在每次尝试独立的目录。默认超时 5 分钟，节点可配置至 30 分钟；进程输出上限 8 MiB，结果文件上限 8 MiB。取消会终止进程组，不自动重试。

## 文件与版本

仅允许 `workflow.json`、`layout.json` 和脚本文件，最多 100 个文件，单个 1 MiB，总源码 4 MiB。拒绝绝对路径、`..`、符号链接及非法扩展名。

`layout.json` 是节点 ID 到 `{x,y}` 的映射，不决定执行顺序。发布时固定定义、布局、源码与编译产物并校验摘要。一个版本可运行多次，修改会发布新版本。

## 脚本库版本引用

`script` 节点引用脚本库，不使用工作流内嵌文件路径。`config.scriptVersionId` 必须是指定脚本的已发布版本；超时可以比脚本版本更短，不能放宽版本的时限。库脚本的超时范围为 1 秒至 5 分钟。

脚本发布新版本不会改变工作流的固定引用。归档禁止新引用，但已有发布工作流可继续执行原版本。脚本版本的源码、Schema、名称、说明及 Shell 输出协议保存在带摘要的不可变产物中；旧产物兼容原进程输出协议。

编辑和发布时检查可判定的输入绑定及 Schema 包含关系，明确不兼容会阻止发布；信息不足和复杂组合会提示无法静态判定，运行时同时校验脚本和节点的输入输出。使用方法见[脚本库说明](../product/script-library.md)。
