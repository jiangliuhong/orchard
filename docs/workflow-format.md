# 流程格式和脚本协议

工作流由 `workflow.json`、可选 `layout.json` 和 `scripts/` 中的脚本构成。示例完整文件位于 `examples/decision/`，该示例中的 Provider / 模型 ID 需要按本地配置修改后发布。

## 定义

`formatVersion` 为 `1`。字段包括固定 `id`、`name`、`inputSchema`、`outputSchema`、`entryNodeId`、`nodes`、`edges` 和最终 `result` 绑定。节点包含稳定 ID、名称、类型、配置、输入绑定、可选输入 Schema 和输出 Schema。

节点类型：

| 类型 | config | 输出 |
| --- | --- | --- |
| `code.nodejs` | `script`，可选 `timeoutMs` | 默认导出函数的 JSON 返回值 |
| `agent` | `prompt`，可选 `providerId` / `modelId` / `timeoutMs` | 经输出 Schema 校验的 JSON |
| `shell` | `script`，可选 `resultMode` / `timeoutMs` | 默认 `{stdout,stderr,exitCode}`；`json` 模式读取结果文件 |
| `switch` | `cases: [{label,value}]`、`defaultLabel` | `{edgeId,value,reason}` |

默认 Agent 选择位于 `defaults.agent`。发布时按节点、工作流默认、Provider 默认模型解析有效选择，保存明确 Provider / 模型。覆盖 Provider 时不会继承另一个 Provider 的模型。

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
