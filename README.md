# Orchard

Orchard 是一个**本地优先、面向单个使用者**的个人 AI 工作流工作台。通过 CLI 启动服务,在浏览器中观察工作流与运行记录;工作流使用 TypeScript 编排,可调用本机 CLI 工具,也可将 Pi Agent 作为具有明确输入输出契约的节点。

- **TypeScript 编排**:用 `defineWorkflow` 定义工作流,TypeBox 推导输入输出类型,运行时以 JSON Schema 严格校验
- **SQLite 持久化**:Run / Step / Attempt 全量记录,UUIDv7 主键,无外部数据库依赖
- **本机 CLI 集成**:`core.cli` 节点以 `shell: false` 调用受信任注册的 CLI 工具,支持超时、输出上限、取消与进程组终止
- **Pi 集成边界**:`ai.pi` 节点契约与适配层已就位,未配置时明确报错,不伪造输出
- **安全的本地服务**:仅监听回环地址,一次性访问令牌 + Host/Origin 校验,防 DNS rebinding

## 当前状态

Orchard 处于 **v0.1.0 开发阶段**(私有包,尚未发布到 npm)。当前已可用:

- CLI 启动服务、初始化数据目录、SQLite 建库与迁移
- 领域契约、状态机、注册表与 JSON 校验(严格 draft-07)
- Workflow SDK、内存 StepRunner、并发队列与运行协调器
- `core.cli` 进程控制、产物存储、esbuild 工作流编译器
- HTTP API 与浏览器只读工作台(查看工作流列表和运行记录)

**尚未实现**:Cron / 事件触发调度、版本发布管线与浏览器端创建/运行闭环、真实 Pi 模型接入、远程 Worker、多用户与多租户。详见 [docs/tasks/001-initialize-workbench.md](docs/tasks/001-initialize-workbench.md)。

## 环境要求

- Node.js **≥ 24**(使用内置 `node:sqlite`)
- pnpm(开发时)

## 快速开始

```bash
# 克隆并安装
git clone https://github.com/jiangliuhong/orchard.git
cd orchard
pnpm install

# 构建
pnpm build

# 启动服务(默认命令,等价于 orchard start)
node dist/cli/main.js
```

启动后终端会输出:

```text
Orchard listening at http://127.0.0.1:7331
Data directory: /Users/you/.orchard
Access token (valid for this process only): 3f9a...
```

每次启动生成新的随机访问令牌,仅当前进程有效。打开 `--open` 可自动唤起浏览器。

## CLI

```bash
orchard start [--host <host>] [--port <port>] [--data-dir <path>] [--open]
orchard doctor
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `--host` | `127.0.0.1` | 监听地址,目前仅允许 `127.0.0.1` 或 `::1` |
| `--port` | `7331` | 监听端口 |
| `--data-dir` | `~/.orchard` | 数据目录 |
| `--open` | 关闭 | 启动后打开浏览器 |

`orchard doctor` 检查本地环境(Node 版本、平台、HTTP 服务与 SQLite 可用性)。

同一数据目录同一时间只允许一个实例;重复启动会因实例锁直接报错。服务进程退出后,后台不会有任何调度在运行。

## 工作台(浏览器)

访问 `http://127.0.0.1:7331`,输入终端显示的访问令牌即可查看工作区。当前版本为**只读预览**:可浏览工作流列表与运行记录;创建、发布和运行功能尚未开放。

## HTTP API

所有接口(除 `/`、`/workbench.js`、`/api/health` 外)需要 `Authorization: Bearer <token>`:

```text
GET  /api/health                健康检查(无需认证)
GET  /api/workflows             工作流列表(分页 limit/offset)
GET  /api/runs                  运行列表(分页)
GET  /api/runs/:runId           运行详情
POST /api/runs/:runId/cancel    请求取消一次运行
POST /api/events                接收外部事件
```

事件接收示例:

```bash
curl -X POST http://127.0.0.1:7331/api/events \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "local-script",
    "id": "report-2026-09-24-001",
    "name": "report.generated",
    "data": { "date": "2026-09-24" }
  }'
```

相同 `source + id` 且内容一致的重复投递会幂等去重;同键不同内容返回冲突错误。

## 定义工作流

```ts
import { defineWorkflow, Type } from '@jiangliuhong/orchard/workflow';

export default defineWorkflow({
  id: 'hello',
  name: 'Hello',
  inputSchema: Type.Object({ name: Type.String({ minLength: 1 }) }),
  outputSchema: Type.Object({ greeting: Type.String() }),
  async run(ctx, input) {
    ctx.signal.throwIfAborted();
    return { greeting: `Hello, ${input.name}` };
  },
});
```

- 输入输出用 TypeBox 定义可推导 TypeScript 类型,也接受普通 JSON Schema(draft-07)
- `defineWorkflow` 只定义,不执行、不持久化;运行边界会对输入输出做运行时校验
- 调用本机 CLI 用 `core.cli` 节点,工作流只提供 `toolId` 与输入,可执行文件由可信的应用注册提供:

```ts
await ctx.step.execute('read-report', {
  type: 'core.cli',
  config: { toolId: 'local.report' },
  input: { date: '2026-09-24' },
});
```

## 包导出

构建后的包提供以下入口(路径前缀 `@jiangliuhong/orchard`):

| 入口 | 内容 |
| --- | --- |
| `.` | HTTP 服务(`createServer`) |
| `/workflow` | Workflow SDK:`defineWorkflow`、`Type`、注册表、校验 |
| `/runtime` | 步骤执行与运行协调 |
| `/storage` | SQLite 初始化与 Repository |
| `/authoring` | 工作流编译器(esbuild) |
| `/artifacts` | 产物存储 |
| `/scheduler` | 并发运行队列 |
| `/core-cli` | `core.cli` 节点与进程控制 |
| `/pi` | Pi 适配边界 |

## 数据存储

默认数据目录为 `~/.orchard`(可用 `--data-dir` 覆盖):

```text
~/.orchard/
├── orchard.db           # SQLite:工作流、运行、步骤、事件、产物索引
├── workspaces/default/  # 默认工作区
├── artifacts/           # 运行产物文件
└── runtime/orchard.lock # 单实例锁
```

数据库启用 WAL 与外键约束;ID 使用 UUIDv7,时间为 UTC Unix 毫秒;历史记录不级联删除。

## 开发

```bash
pnpm build          # TypeScript 编译到 dist/
pnpm typecheck      # 类型检查(与 lint 相同)
pnpm test           # 构建 + 单元/集成测试(node:test)
pnpm test:e2e       # 构建 + 冒烟测试
pnpm test:package   # 构建 + npm pack 清单 dry-run
pnpm dev            # 构建 + 启动 CLI
```

## 文档

- [Workflow SDK](docs/workflow-sdk.md) —— 定义、校验边界与当前验证范围
- [core.cli 节点](docs/core-cli.md) —— 本机 CLI 工具调用契约
- [初始化任务规划](docs/tasks/001-initialize-workbench.md) —— 完整架构决策、数据模型与实施子任务
- [AGENTS.md](AGENTS.md) —— 工程协作规则

## 许可

私有项目,版权保留。
