# Orchard 浏览器桥接设计

状态：已完成编码；当前 HTTP 执行及 Native Host 服务发现见 [implementation-status.md](./implementation-status.md)。真实业务站点、登录与扩展全链路验收仍单列。
日期：2026-11-06  
参考实现：`/Users/jaromejiang/Workspace/kn/web-agent-bridge`

## 1. 目标与范围

Orchard 需要把浏览器扩展提供的同源网页工具接入本地工作台，使用户完成一次 npm 安装和浏览器扩展配置后，可以：

- 启动 `orchard server`，由 Orchard Web 服务持有浏览器桥接调用入口；
- 使用 `orchard web-bridge tool <应用> <工具> ...` 或 JSON 标准输入执行已注册的浏览器工具；
- 使用 `orchard web-bridge chrome-ext` 输出 Chrome 扩展目录和添加步骤；
- 在工作流中把浏览器调用作为独立的 `web-bridge` 节点；
- 在必须兼容脚本的场景中，从 `shell` 节点调用同一套 `orchard web-bridge` CLI；
- 在 Orchard Web 控制台中管理桥接应用、环境、工具启用状态和工具测试；
- 复用 `web-agent-bridge` 的 Chrome MV3 扩展、Native Messaging 和本地 Unix Socket 思路，但由 Orchard 统一分发、启动、生命周期管理和错误模型。

第一阶段面向 Orchard 已支持的 macOS / Linux 本地进程与 Chrome。浏览器扩展先支持 Chrome MV3；Firefox、Windows、远程浏览器、浏览器 DevTools 协议和桌面 App 不在本 feature 范围内。

本 feature 不把浏览器变成 Agent 的任意网页自动化权限。调用方只能选择 Orchard 已安装并审核过的工具 ID，工具定义固定目标来源、HTTP 方法、参数 Schema、响应字段白名单和风险类型。

## 2. 参考实现的边界

`web-agent-bridge` 当前已经验证了以下链路：

```text
Chrome 扩展管理页 / 弹窗
        → 扩展后台
        → 选定标签页的 ISOLATED world
        → 同源网页 API

扩展后台 ↔ Chrome Native Messaging ↔ Native Host
Native Host ↔ 受限 Unix Socket ↔ 本地调用方
```

Orchard 只吸收浏览器桥接职责，不引入参考项目的桌面 App、Swift 双 Socket、Pi MCP 兼容入口或 FM 专用 UI。参考项目中的职责映射如下：

| 参考实现 | Orchard 设计 |
| --- | --- |
| `apps/extension` | Orchard npm 包内置的 Chrome 扩展产物与扩展源码 |
| `apps/native-host` | Orchard 的 Native Messaging Host 适配器，负责连接 Orchard Bridge Socket |
| `packages/protocol` | Orchard `web-bridge` 传输层，保留行 JSON 与 Native Messaging 两种 framing |
| `packages/bridge-client` | Orchard `WebBridgeClient`，被 CLI、HTTP 服务和工作流运行器复用 |
| `packages/config` / 工具目录 | Orchard 受版本控制的工具 Catalog、Schema 和 adapter |
| `examples/mcp-server` | 不作为 Orchard 首期入口；MCP 可在后续通过同一 Gateway 适配 |
| `apps/desktop` | 不迁移 |

参考项目的 `bridge_status`、配置指纹、固定工具路由、标签页绑定、超时、结果裁剪和认证信息留在浏览器内的语义必须保留。不能把调用方传入的 URL、HTTP 方法、Cookie、Authorization、任意脚本或页面选择器直接透传给扩展。

## 3. 用户场景

### 3.1 本地命令调用

在仓库中构建并通过本地 link 安装 Orchard 后，第一次运行：

```bash
pnpm install
pnpm build
pnpm link --global
orchard web-bridge install
orchard server --port 7441
```

用户可以通过以下命令获得扩展目录和 Chrome 添加说明：

```bash
orchard web-bridge chrome-ext
```

`chrome-ext` 只负责打印可复制的本地扩展地址、扩展版本、Catalog hash 和 `chrome://extensions` 添加步骤，并可使用 `--open` 尝试打开 Chrome 扩展管理页。第一阶段只支持 Chrome 开发者模式加载，不要求 npm 发布或 Chrome Policy 分发。扩展产物必须携带固定 key，确保 Native Messaging 的 extension ID 在本地升级后保持稳定。它不伪造 Chrome 商店安装，也不静默修改用户浏览器权限。然后用户在 Chrome 中加载 Orchard 提供的扩展并连接一个已登录标签页。工具目录和连接状态可以检查：

```bash
orchard web-bridge status
orchard web-bridge tools
```

工具调用的主命令选择 `tool`，而不是 `call`。`tool` 与 Web 控制台的“应用 → 工具”层级一致，也为后续增加 `app`、`config` 等管理子命令保留清晰的命名空间；`call` 更像传输动作，不能表达应用和工具目录关系。命令形式固定为：

```bash
orchard web-bridge tool acctrix fm_task_list --args-json '{"projectId":8,"page":1,"size":10}'
printf '%s\n' '{"projectId":8,"page":1,"size":10}' \
  | orchard web-bridge tool acctrix fm_task_list --stdin-json
```

`<应用>` 和 `<工具>` 都必须来自 Catalog；工具调用目标由应用 ID 与工具 ID 的组合唯一确定。命令默认输出单个 JSON 结果；`--pretty` 只改变展示格式，不改变服务端结果。

### 3.2 Web 服务调用

`orchard server` 启动时创建一个 `WebBridgeGateway`。Gateway 连接用户级 Bridge Socket，但不在服务中读取浏览器 Cookie。Web UI 和本地 CLI 通过同一个本地 API 调用：

```text
Orchard Web UI / orchard CLI / workflow runner
                      |
                WebBridgeGateway
                      |
                BridgeClient
                      |
               Unix Socket 0600
                      |
               Native Messaging Host
                      |
                 Chrome 扩展
```

服务启动不要求浏览器已经连接。没有可用扩展或标签页时，服务保持可用，调用返回 `BROWSER_NOT_CONNECTED`。

### 3.3 工作流节点

工作流增加 `web-bridge` 节点。节点输入是工具参数对象，节点配置只包含工具 ID、可选 timeout 和输出策略：

```json
{
  "id": "list-tasks",
  "name": "查询任务",
  "type": "web-bridge",
  "input": { "source": "workflow", "pointer": "/taskQuery" },
  "inputSchema": {
    "type": "object",
    "required": ["projectId", "page", "size"],
    "properties": {
      "projectId": { "type": "integer", "minimum": 1 },
      "page": { "type": "integer", "minimum": 1 },
      "size": { "type": "integer", "minimum": 1, "maximum": 100 }
    },
    "additionalProperties": false
  },
  "outputSchema": { "type": "object" },
  "config": {
    "application": "acctrix",
    "tool": "fm_task_list",
    "timeoutMs": 20000
  }
}
```

节点执行前由 Orchard 根据 Catalog 校验工具存在、参数 Schema、风险类型和当前配置指纹；执行后再校验归一化结果的 `outputSchema`。节点不会把网页凭据放入输入、输出、事件或运行产物。

### 3.4 Web 控制台管理

Orchard Web 控制台增加“Web Bridge”区域，分为三个视图：

| 视图 | 用户能力 |
| --- | --- |
| 应用管理 | 查看内置应用、添加/编辑 HTTPS 环境、设置默认环境、授权并绑定标签页、启用/停用应用 |
| 工具管理 | 按应用浏览工具、查看参数 Schema/风险/确认要求、启用/停用工具、执行测试 |
| 连接诊断 | 查看扩展、Host、Catalog hash、绑定标签页、登录状态、最近一次稳定错误 |

控制台可以管理应用和工具的可用状态，但不能把任意 URL、HTTP 方法、请求头或脚本保存为工具。应用和工具定义来自受版本控制的 Catalog；UI 管理的是环境、启用开关、默认值和测试入口。工具测试仍经过同一 Gateway，写入类工具必须在浏览器中显示一次性确认。

### 3.5 Shell 兼容入口

需要复用现有脚本协议时，Shell 节点可以通过 CLI 调用：

```bash
#!/bin/bash
set -euo pipefail
orchard web-bridge tool acctrix fm_task_list --stdin-json \
  > "$ORCHARD_RESULT_FILE"
```

Shell 输入通过标准输入传给 CLI，不能拼进命令行。`orchard web-bridge tool` 在检测到 `ORCHARD_RESULT_FILE` 或 `--json` 模式时只输出业务 JSON；工具失败使用非零退出码并把稳定错误码写入 stderr。Shell 节点仍受现有工作流脚本权限、超时和输出限制约束。

独立节点是推荐路径，因为它能在工作流事件中记录工具 ID、参数摘要、连接状态和浏览器错误；Shell 入口用于迁移既有脚本或用户确实需要命令行组合的场景。

## 4. 运行时架构

新增模块边界：

```text
src/web-bridge/
  catalog.ts          工具目录、版本、风险和 Schema
  protocol.ts         行 JSON / Native Messaging framing
  client.ts           Unix Socket 客户端、超时、取消、请求关联
  gateway.ts          服务生命周期、并发、配置指纹、公开错误
  install.ts          扩展产物和 Native Host manifest 安装
  cli.ts              orchard web-bridge 子命令
  adapters/           按应用/网站划分的固定请求适配器
```

`WebBridgeGateway` 由 `src/server/app.ts` 装配，并由 `src/server/main.ts` 的关闭顺序释放。它提供：

```ts
interface WebBridgeGateway {
  status(signal?: AbortSignal): Promise<WebBridgeStatus>;
  applications(): Promise<WebBridgeApplicationView[]>;
  tools(applicationId?: string): Promise<WebBridgeToolView[]>;
  call(applicationId: string, tool: string, args: unknown, options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    requestId?: string;
  }): Promise<unknown>;
  close(): Promise<void>;
}
```

Gateway 不向上层暴露 Socket 路径、Native Messaging 细节或扩展内部消息。CLI、HTTP 路由和 `GraphRunner` 都只依赖该接口，避免三套超时、错误和参数校验。

服务器同时只有一个 BridgeClient 连接池。第一版每个调用使用一个短连接；不为业务请求复用浏览器标签页连接状态。连接失败、服务关闭或请求取消时，客户端关闭 Socket 并清理 pending 请求。

## 5. 本地传输协议

### 5.1 Socket

- Socket 位于 Orchard 数据目录下的 `runtime/web-bridge.sock`，父目录权限 `0700`，Socket 权限 `0600`。
- 使用 UTF-8 行 JSON；单条消息默认限制 512 KiB，结果限制由工具 Catalog 进一步收紧。
- 服务启动发现残留 Socket 时拒绝启动并给出 `BRIDGE_SOCKET_EXISTS`，不自动删除其他进程可能仍在使用的 Socket。
- 连接、请求和结果均带唯一 `requestId`；未知或过期 ID 的响应丢弃。
- 每个客户端最多 8 个在途请求，Gateway 全局最多 32 个；超过上限返回 `BRIDGE_BUSY`。

### 5.2 Native Messaging

Chrome 使用 `connectNative` 启动 Native Host。Host manifest 中的 `allowed_origins` 只包含 Orchard 扩展 ID，Native Host 启动参数包含：

```text
orchard web-bridge host --data-dir <resolved-data-dir>
```

Host 不能接受扩展传入的任意可执行文件、Socket 路径或配置路径。启动时发送 `host.ready`，包含：

```json
{
  "type": "host.ready",
  "protocolVersion": "orchard-web-bridge-1",
  "catalogHash": "sha256...",
  "extensionVersion": "..."
}
```

Orchard 扩展和 Host 的 `catalogHash` 不一致时拒绝业务请求，提示重新加载扩展或重新安装 Host。Catalog hash 不是身份认证凭据，只用于防止版本错配。

### 5.3 消息形状

本地调用请求：

```json
{
  "id": "request-uuid",
  "tool": "fm_task_list",
  "args": { "projectId": 8, "page": 1, "size": 10 },
  "catalogHash": "sha256..."
}
```

成功响应：

```json
{
  "id": "request-uuid",
  "result": {
    "source": "https://fm.example.test",
    "fetchedAt": "2026-11-06T00:00:00.000Z",
    "records": []
  }
}
```

失败响应：

```json
{
  "id": "request-uuid",
  "error": {
    "code": "LOGIN_REQUIRED",
    "message": "目标标签页需要重新登录"
  }
}
```

扩展内部消息必须再次校验工具、参数、站点来源、绑定标签页和 Catalog hash。页面执行器只构造 Catalog 中的固定同源请求；请求头、Cookie、Token、完整原始响应和页面脚本不会返回本地进程。

## 6. 工具 Catalog 与浏览器扩展

### 6.1 Catalog

每个工具包含：

| 字段 | 说明 |
| --- | --- |
| `toolId` | 在应用内唯一的稳定 ID，例如 `fm_task_list` |
| `application` / `site` | 应用和目标环境类别 |
| `description` | 面向用户和工作流编辑器的说明 |
| `parameters` | 参数 Schema 与联合约束 |
| `path` / `method` | 受信任的固定同源接口映射，仅扩展端读取 |
| `fields` / `records` | 响应字段白名单、列表上限与裁剪规则 |
| `risk` | `read`、`write`、`delete`、`execute`、`download` |
| `approval` | `none` 或 `user`；变更工具必须为 `user` |
| `timeoutMs` | 工具默认超时和最大值 |
| `catalogVersion` | 工具定义版本 |

Catalog 不是用户可编辑的任意 HTTP 配置。新增工具必须提交代码、Schema、适配器和测试；来源、方法和字段白名单不能只写在 UI 原型中。

第一阶段只迁移参考项目中已经实现并完成真实环境联调的 Acctrix、Superset 只读工具，建议先限定为 2–5 个查询工具。迁移清单按应用拆分，FM 工具可沿用 `fm_task_list` 等已有稳定 ID；未完成真实环境联调的条目显示为不可用，不能仅因进入 Catalog 就宣称可执行。Catalog 可以保留 `risk` 和 `approval` 字段，但首期不启用写入、删除、任务执行和下载工具。

### 6.2 扩展职责

扩展提供：

1. 环境管理和用户显式选择标签页；
2. 连接、断开、绑定修订和登录状态显示；
3. 工具参数基础表单与工具测试界面；
4. 页面内同源请求执行和响应裁剪；
5. 预留高风险工具确认界面；首期不启用写入、删除、任务执行和下载工具；
6. Native Messaging 握手和断开后的在途请求清理。

扩展不提供：

- 任意 URL、方法、请求头或 JavaScript 执行；
- 从页面读取并返回 Cookie、Token、Local Storage 全量内容；
- 自动刷新登录、自动选择未授权标签页或自动重试有副作用的请求；
- 启动 Orchard Server、Pi、Codex 或桌面 App。

环境来源必须是无路径 HTTPS origin；本机测试只允许 `localhost` / `127.0.0.1` 的 HTTP。每个环境绑定一个用户显式选择的标签页，导航、关闭、来源变化、权限撤销、认证失败或环境删除都会使绑定失效。

### 6.3 结果边界

- 浏览器原始响应默认不超过 256 KiB；
- 结构化结果默认不超过 128 KiB；
- 列表默认最多返回 100 条，并明确 `truncated`；
- 嵌套结果限制深度和字段数量，移除凭据名称；
- 大结果转为 Orchard 产物引用时，引用内容仍须经过字段白名单和大小校验；
- CLI、工作流事件和 API 不返回原始 HTTP 报文。

## 7. Orchard Server API

API 继续使用本地 `/api` 前缀和现有 Host / Origin 校验，新增：

| 操作 | 方法与路径 |
| --- | --- |
| 桥接状态 | `GET /api/web-bridge/status` |
| 应用列表/详情 | `GET /api/web-bridge/applications` / `GET /api/web-bridge/applications/:applicationId` |
| 创建/修改/删除应用环境 | `POST/PATCH/DELETE /api/web-bridge/applications/:applicationId/environments/:environmentId` |
| 工具目录 | `GET /api/web-bridge/applications/:applicationId/tools` |
| 启用/停用工具 | `PATCH /api/web-bridge/applications/:applicationId/tools/:toolId` |
| 工具测试 | `POST /api/web-bridge/applications/:applicationId/tools/:toolId/test` |
| 执行工具 | `POST /api/web-bridge/calls` |
| 取消调用 | `POST /api/web-bridge/calls/:id/cancel` |

执行请求：

```json
{
  "requestId": "unique-call-id",
  "application": "acctrix",
  "tool": "fm_task_list",
  "args": { "projectId": 8, "page": 1, "size": 10 },
  "timeoutMs": 20000
}
```

`application` 和 `tool` 均必须来自 Catalog。`timeoutMs` 只能在工具允许范围内覆盖，服务端不接受任意长超时。成功返回 HTTP 200；调用已受理但仍在执行时返回 HTTP 202，并提供 `callId`，首期 CLI 采用同步等待。请求取消只中断 Orchard 等待和 Socket，不撤销已发送到浏览器或目标业务系统的 HTTP 副作用。

应用管理接口只允许管理 Catalog 已声明的应用及其环境：应用的 origin、默认环境、启用状态和标签页绑定可以修改；不能通过 API 注册任意远程应用。工具管理接口只允许修改启用状态和测试参数，不允许修改工具的 URL、HTTP 方法、字段白名单、风险等级或确认策略。配置保存到 Orchard 数据目录中的受限 JSON 配置文件，首期不新增数据库表；写入采用临时文件、fsync 和原子替换。

状态返回：

```json
{
  "enabled": true,
  "connected": true,
  "catalogHash": "sha256...",
  "extensionVersion": "...",
  "sites": [
    {
      "id": "fm",
      "origin": "https://fm.example.test",
      "bound": true,
      "tabAvailable": true
    }
  ]
}
```

状态中的 `connected` 只表示扩展与 Host 握手成功，不代表目标业务网站已登录或某个工具当前有权限。

稳定错误码包括：

`BRIDGE_NOT_INSTALLED`、`BROWSER_NOT_CONNECTED`、`BRIDGE_BUSY`、`BRIDGE_SOCKET_EXISTS`、`CATALOG_MISMATCH`、`UNKNOWN_TOOL`、`INVALID_ARGUMENTS`、`SITE_NOT_BOUND`、`ORIGIN_MISMATCH`、`TARGET_TAB_UNAVAILABLE`、`LOGIN_REQUIRED`、`PERMISSION_DENIED`、`APPROVAL_REQUIRED`、`API_TIMEOUT`、`BROWSER_TIMEOUT`、`BROWSER_DISCONNECTED`、`RESPONSE_TOO_LARGE`、`CANCELLED`。

HTTP 层返回 `{code,message}`，工作流和 CLI 使用同一错误码，不根据浏览器文本猜测失败类型。

## 8. CLI 与 npm 分发

### 8.1 包入口

`package.json` 增加（包继续保持 scoped/private，首期不发布 npm）：

```json
{
  "bin": {
    "orchard": "dist/cli/index.js"
  }
}
```

包名继续使用现有 scoped/private 配置，首期通过 `pnpm link --global` 在本机安装；命令名固定为 `orchard`。`orchard server` 与现有 `pnpm start` 使用同一服务入口。现有 `--port`、`--data-dir` 行为保持兼容；`orchard server` 是面向本地 link 用户的显式命令。

### 8.2 子命令

| 命令 | 行为 |
| --- | --- |
| `orchard server` | 启动 Web 服务和 WebBridgeGateway |
| `orchard web-bridge install` | 安装/更新 Native Host manifest，校验扩展产物和目录权限 |
| `orchard web-bridge uninstall` | 删除 Orchard 自己写入的 manifest，保留用户扩展和业务配置 |
| `orchard web-bridge chrome-ext` | 打印扩展目录、版本、Catalog hash 和 Chrome 添加步骤；`--open` 可尝试打开扩展管理页 |
| `orchard web-bridge status` | 查询服务、Host、扩展和标签页绑定状态 |
| `orchard web-bridge applications` | 列出应用、环境、绑定状态和启用状态 |
| `orchard web-bridge tools [应用]` | 列出指定应用的工具、风险、Schema 摘要和版本 |
| `orchard web-bridge tool <应用> <工具>` | 调用工具；参数来自 `--args-json`、`--args-file` 或 `--stdin-json` |
| `orchard web-bridge doctor` | 检查 Node、Chrome、扩展 ID、manifest、Socket 和握手 |
| `orchard web-bridge host` | 仅供 Chrome Native Messaging 启动，不面向用户手动调用 |

CLI 默认调用本机 `http://127.0.0.1:<port>` 的 Orchard API。服务未启动时返回 `SERVER_NOT_RUNNING`，不在 CLI 内偷偷启动第二个 Gateway。`--server-url` 只允许本机 URL，不能把调用转发到远程 Orchard。

`chrome-ext` 选择为“打印地址”而不是 `install` 的别名：扩展目录是本地构建产物，用户需要在 Chrome 的开发者模式中手动加载。Chrome Policy 分发留待后续企业部署方案。`install` 只负责 Native Host manifest；`chrome-ext` 负责给出扩展目录和浏览器操作指引，职责清晰且适用于无 GUI 的服务器终端。Native Host manifest 的安装和更新可以自动完成，并且必须只写 Orchard 管理的路径。

### 8.3 安装目录

npm 包内包含：

```text
dist/
  cli/
  server/
  web-bridge/
    extension/
    native-host/
    catalog.json
```

运行时不依赖仓库路径。Native Host manifest 使用已解析的绝对 `orchard` 可执行路径和用户选择的数据目录；升级时先写临时文件、fsync，再原子替换。卸载只删除 manifest 和 Orchard 生成的诊断文件，不删除 Chrome 授权、用户环境或 Orchard 数据库。

## 9. 工作流格式变更

`WorkflowNode.type` 增加 `"web-bridge"`。`config` 增加：

```ts
{
  application: string;
  tool: string;
  timeoutMs?: number;
  resultMode?: "result" | "envelope";
}
```

规则：

- `application` 与 `tool` 必须是发布/测试时可用的 Catalog 组合；
- 节点输入必须满足工具参数 Schema，不能在绑定中出现 URL、Cookie、Token 或请求头字段；
- `resultMode: "result"` 返回工具业务结果；`"envelope"` 额外返回工具 ID、来源环境、抓取时间和裁剪信息；
- 首期工作流节点只允许 Catalog 中的只读工具；写入、删除、执行和下载工具统一返回 `APPROVAL_REQUIRED`，不实现等待审批状态。后续如果引入 Web UI 确认，再单独设计审批状态机和确认接口；
- 工作流发布冻结 `application`、`tool`、Catalog 版本和配置摘要，Catalog 变更不会偷偷改变历史版本的工具语义；
- 工作流运行按现有串行节点模型执行，一个 Run 同时最多一个浏览器调用；
- 取消、超时或浏览器断开会结束当前 attempt，不自动重试。

工作流编辑器需要显示工具目录、风险标签、需要连接的环境和输入 Schema。保存/发布校验不要求目标浏览器在线；真正运行时才检查连接和登录状态。

`GraphRunner` 新增 `WebBridgeGateway` 依赖。节点 attempt 的 `execution_json` 记录 `application`、`tool`、`catalogVersion`、`catalogHash`、`siteId`、`durationMs` 和非敏感错误信息；不记录完整请求参数、Cookie、Token 或原始响应。现有 `node_runs`、`node_attempts`、`runs`、事件和产物机制继续使用。

## 10. 数据库与数据生命周期

本 feature 首期不修改数据库表结构、索引、迁移或 `SCHEMA_VERSION`。连接状态、扩展版本和待处理请求属于进程内状态，服务重启后重新握手；工作流执行结果沿用现有节点运行记录。

根据仓库根目录 `AGENTS.md`，如果后续需要保存以下任一信息，必须先单独提交数据库方案并审核通过后才能实施：

- 浏览器环境、标签页绑定或用户确认记录；
- 可恢复的浏览器调用队列；
- 工具调用审计日志或跨重启幂等回执；
- Catalog 版本到工作流版本的持久化映射；
- 凭据、会话文件或浏览器身份引用。

第一版不保存凭据、不把浏览器会话写入数据库，也不把工具调用结果写成长期缓存。大结果只使用现有产物机制，并遵守当前产物清理和访问控制。

## 11. 并发、取消与关闭

- Gateway 全局最多 32 个 pending call，单个 Socket 最多 8 个；
- 请求超时分为连接超时、浏览器调用超时和 CLI/HTTP 等待超时，默认沿用参考实现的 12 秒页面请求、18 秒 Host 等待和 20 秒客户端等待，再按工具 Catalog 缩短或放宽；
- 同一 CLI `requestId` 重复提交且内容相同，返回第一次结果；相同 ID 不同工具或参数返回 `REQUEST_ID_CONFLICT`；
- 不对浏览器业务请求自动重试，尤其是写入、删除、任务执行和下载；
- 服务关闭顺序为停止接收新 API 请求、取消等待中的 Gateway 调用、关闭工作流运行器、关闭 Bridge Socket 客户端、最后关闭 Store；
- Host 或扩展断开时，所有未完成调用得到 `BROWSER_DISCONNECTED`；迟到响应丢弃；
- stale Socket 不自动删除；`doctor` 可以在确认进程不存在后提供人工清理命令。

## 12. 安全与权限

本地 Bridge 的信任边界是当前操作系统用户及其本地进程。设计采取以下约束：

1. Orchard Web 服务只监听 `127.0.0.1`，沿用现有 Host / Origin 校验，不监听 LAN；
2. Unix Socket 父目录 `0700`，Socket `0600`，Native Host manifest 目录和文件拒绝符号链接；
3. Native Messaging `allowed_origins` 固定为 Orchard 扩展 ID；
4. 工具请求使用 allowlist；调用方不能传入 URL、方法、Header、脚本、任意选择器或远程配置；
5. 认证凭据只在扩展页面执行器和同源浏览器请求中使用，不能进入 Socket、API、日志、事件、产物、CLI 输出或工作流上下文；
6. 写入、删除、发布、任务执行和下载等风险工具需要一次性用户确认，并绑定工具、环境、参数快照、网页身份和有效期；
7. 输入、输出、日志和错误消息执行大小限制及字段裁剪；
8. `catalogHash` 用于版本一致性，不被当作秘密或认证 token；
9. 本机 API 使用随机 token 做进程外调用认证。首次安装或启动时生成用户级 `0600` token 文件，CLI 自动读取并发送认证头；token 不进入扩展、Socket 业务消息、日志、事件或工作流上下文；
10. Shell 节点继续按当前用户权限运行；浏览器桥接不构成操作系统沙箱；
11. 服务端不接受远程 `server-url`，避免把本地浏览器身份暴露给其他机器。

## 13. 可观测性

WebBridge 事件只在工作流 Run 内按现有 `node.*` 事件记录：

- `node.started`：工具 ID、站点 ID、非敏感参数摘要；
- `node.log`：仅 CLI/Host 诊断片段，过滤凭据键；
- `node.succeeded`：结果或产物引用、耗时、是否裁剪；
- `node.failed`：稳定错误码、阶段（connect/host/browser/normalize）和耗时。

`GET /api/health` 增加只读字段 `webBridge: { enabled, connected, pending }`。不提供“返回最近原始请求/响应”的调试 API。`doctor` 可以输出版本、路径、权限和握手错误，但必须对路径中的用户目录和配置内容脱敏。

## 14. 实施顺序

1. 固定只读 Catalog、协议版本、错误码、扩展 key 和本机 token 方案；从参考项目迁移协议与参数校验测试。
2. 将扩展和 Native Host 产物纳入本地 build，完成 `install`、`uninstall`、`doctor` 和 `host` 生命周期。
3. 实现 `WebBridgeClient`、Gateway、本机 token 校验和 `/api/web-bridge/*`，接入服务关闭顺序。
4. 增加 `orchard web-bridge` CLI，覆盖 `chrome-ext`、applications、tools、tool、stdin JSON 和错误退出码。
5. 只接入已联调的只读工具，完成扩展管理页、环境绑定和只读调用。
6. 扩展 `WorkflowNode`、校验器和 `GraphRunner`，加入只读 `web-bridge` 独立节点，并为 Shell 节点提供稳定 CLI 调用约定。
7. 完成模拟协议、拆包/粘包、超时、取消、断开、结果裁剪、token 认证和真实 Chrome profile 测试。
8. 后续单独评估高风险工具确认、Chrome Policy 分发和跨重启状态恢复。

首期不做：

- 将浏览器调用直接暴露给 Agent Provider 工具；
- 远程浏览器或多用户共享浏览器；
- 任意网页录制、点击坐标、键盘宏或 JS 注入；
- 浏览器会话跨服务重启恢复；
- 自动重试有副作用的业务请求；
- 将 MCP、桌面 App 和浏览器桥接合并为一个通用协议；
- 为连接、审计或队列新增数据库表。

## 15. 验收标准

### 安装与服务

- 执行 `pnpm build && pnpm link --global` 后，`orchard --help`、`orchard server` 和 `orchard web-bridge` 可用；
- `orchard web-bridge install` 能生成受限 Native Host manifest，重复执行幂等，卸载不删除用户数据；
- `orchard web-bridge doctor` 能区分 Node/Chrome 缺失、扩展未加载、Host 未安装、Socket 残留、Catalog 不一致和标签页未绑定；
- 服务未连接浏览器时仍能启动，调用返回明确 `BROWSER_NOT_CONNECTED`。

### 协议与安全

- 覆盖 Native Messaging 长度帧、Unix Socket 行 JSON 的拆包、粘包、CRLF、非法 JSON、过大消息和残缺 EOF；
- 未知工具、非法参数、来源不匹配、绑定变更、Catalog hash 不一致和过期响应均被拒绝；
- Cookie、Token、Authorization、原始响应和任意 URL 不出现在 API、CLI、日志、事件或产物；
- Host 只接受 Orchard 扩展 ID，Socket 权限和 stale Socket 行为符合设计；
- 浏览器断开、用户取消和超时都能清理 pending 请求且不自动重发。

### CLI 与工作流

- `orchard web-bridge chrome-ext` 能打印可复制的扩展目录、版本和 Chrome 添加步骤；
- `orchard web-bridge tool` 支持应用/工具定位、JSON 参数、非零错误码、稳定 stderr 和标准输入；
- Web 控制台能够管理 Catalog 应用的环境与启用状态、只读工具启用状态并执行测试；
- 独立 `web-bridge` 节点能在已绑定标签页中读取结果，并把结果传给后续节点；
- 节点输入/输出 Schema、Catalog 版本冻结、运行事件和失败状态符合现有工作流语义；
- Shell 节点可以通过 stdin 调用 CLI，结果文件模式不会把输入拼入命令行；
- 只读调用、登录失效、权限不足、结果超限、浏览器超时和取消均有测试；
- 写入/删除/执行/下载工具在首期统一返回 `APPROVAL_REQUIRED`，不会静默执行。

### 真实环境

- 在测试 Chrome profile 中完成扩展加载、登录、标签页绑定、只读查询和断开重连；
- 升级 Orchard 后 Catalog hash 不一致能提示重新加载扩展；
- 记录 Node、Chrome、扩展、Host 和业务站点版本，真实测试不把模拟响应结果当作联调通过；
- 首期所有失败场景都能在不修改数据库结构的情况下恢复服务和工作流运行。

## 16. 已确认决策

1. 首期不进行 npm 发布，包继续保持 scoped/private，通过 `pnpm link --global` 本地安装；命令名为 `orchard`。
2. 扩展采用 Chrome 开发者模式加载，产物携带固定 key 以保持 extension ID 稳定；Chrome Policy 分发留待后续。
3. 首期只迁移已经完成真实环境联调的 Acctrix、Superset 只读工具，建议控制在 2–5 个查询工具。
4. 首期不启用写入、删除、任务执行和下载工具；工作流遇到这些工具时直接返回 `APPROVAL_REQUIRED`，不进入等待审批状态。
5. 本机 API 启用随机 token 认证，token 保存于用户级 `0600` 文件，CLI 自动读取。
6. 首期不修改数据库表结构、索引、迁移或 `SCHEMA_VERSION`，不做跨服务重启的浏览器状态恢复。

## 17. 桌面工作区与 Agent 维护（2026-11-08）

状态：已完成（本地验证）；本次扩展不修改数据库表结构、索引或迁移声明。

### 目标和用户场景

将 `/web-bridge` 的应用定义、管理双入口合并为以应用为上下文的固定高度工作区。用户可以选择应用、编辑工具、执行测试，并在同一应用的 Agent 会话中描述维护需求、分析测试结果、审阅和应用工具变更。Orchard 全局导航继续支持原有折叠。

### 行为规则

- 应用导航可搜索，主区包含工具、环境、应用设置；工具列表进入详情，详情内切换定义与测试。
- 工具提供表单和 JSON 编辑；工具存在未保存修改时，切换上下文前提供保存、放弃、取消。保存、删除、测试有进行中状态，失败保留可重试的操作。
- 浏览器插件目录和资料列表收进连接对话框，资料读取失败不阻塞其他工作区。在线状态表示最近注册，并不保证业务标签页实时可用。
- Agent 面板支持关闭、宽度调整、Provider/模型选择、历史会话、新建会话、连续对话和取消任务。当前应用、选中工具自动作为配置上下文；测试参数和结果需用户显式勾选附带。
- Agent 仅提出当前应用内工具定义的新增、修改和删除，不自动执行网页工具，不修改环境、不发布。纯问答回复包含说明和空变更列表。
- 提案在主区显示逐工具差异，用户确认后一次写入全部变更。配置摘要不一致时拒绝覆盖；重复请求和重复应用不重复修改配置。JSON Schema 和工具归属在服务端校验，非法提案不写入配置。
- 每应用最多一个生成任务，全局最多四个，超时 120 秒。生成期间阻止配置恢复，关闭服务取消任务；服务重启时未结束的文件记录标记中断。切换应用和关闭 Agent 面板不取消后台任务。
- 删除应用前拒绝未结束的 Agent 任务；删除成功同时清理该应用会话记录，重新创建同 ID 应用不会继承旧提案。

### Agent 工具编写契约与环境边界

- 工具定义与执行就绪状态分离：环境列表为空、浏览器离线或尚未绑定均不阻止生成和保存定义；不得因此要求用户提供域名或站点映射。生成仍须有业务接口、方法、参数和返回字段依据。
- `path` 仅保存同源绝对路径，不固定域名。`site` 暂作为兼容的逻辑站点标识：新工具使用当前应用 ID，更新保留已有值；它不是环境 ID，也不要求环境配置提供 site 映射。不变更现有持久化格式。
- Agent 每轮接收可信的平台契约，包含实际提案 Schema、默认 site 和能力边界；用户请求、历史和快照仍是不可信数据。不再要求用户提供 Orchard 配置格式或证明平台能力。
- 当前定义格式没有内部加签、动态请求头、敏感参数处理、原始请求体映射和完整 JSON 返回模式。参数 JSON Schema 仅用于校验，不能替代这些执行能力；`fields: []` 或 `fields: ["*"]` 不代表已支持完整返回。需求依赖这些能力时，明确指出具体缺口，不生成虚假的可用定义，不索取真实凭据。
- 本次修复只覆盖定义编写契约，不宣称完成浏览器执行或环境路由。后续执行链路需显式解析所选环境及 origin、校验浏览器绑定，并在测试/执行阶段提供环境缺失、禁用或歧义等错误；多环境不能静默选取第一项。

### 数据和接口

工具继续写入现有 `config/web-bridge.json`，会话与提案使用 `web-bridge-agent/<application>/<turn>.json` 原子写入，临时 Provider 工作目录位于 `runtime/web-bridge-agent`。不新增数据库结构。会话记录为本地历史，不进入配置 Git 快照。

| 方法 | 路径（前缀 `/api/web-bridge/applications/:applicationId`） | 用途 |
| --- | --- | --- |
| GET | `/agent/turns?conversationId=...` | 会话列表与最近 100 轮记录，返回应用内活动任务 |
| POST | `/agent/turns` | 指定 Provider、模型、请求 ID、会话 ID 和需求生成一轮 |
| POST | `/agent/turns/:turnId/cancel` | 取消指定轮次 |
| POST | `/agent/turns/:turnId/apply` | 确认应用已完成且配置未冲突的提案 |

### 验收标准

1. 应用、工具、会话和测试上下文互相隔离；资料读取失败仍可维护工具。
2. 未保存保护覆盖切换应用、工具列表、审阅变更及页面离开；错误 JSON 不能静默保存旧值。
3. Agent 生成和审阅均不改工具配置，只有显式应用后发生变化，旧提案不能覆盖更新配置。
4. 取消、服务重启、Provider 失败和配置恢复互斥均保留明确状态；重复应用不覆盖后续手动修改。
5. 通过类型检查、相关交互与服务测试、全量回归和生产构建；真实 Provider 和 Chrome 业务站点联调需使用实际已配置环境验证。

### 验证记录（2026-11-08）

- `npm run typecheck` 通过。
- `env TMPDIR=/private/tmp npm test` 全量 433 项通过。macOS 默认临时目录可能经过符号链接，Git 路径防护测试需使用规范路径；HTTP/SSE 测试需允许本机端口监听。
- `npm run build` 通过，保留 Monaco 等大分块的体积提示；差异编辑器按需加载。
- 使用隔离测试数据在真实 Chrome 中检查应用导航、工具列表、Agent 面板和底部状态条布局。预览 Provider 为模拟实现；未调用真实模型或业务站点。
- 本次仅刷新业务源码依赖锁和生成包摘要，数据库表、索引、Schema 版本和已审核迁移声明保持原有定义。

