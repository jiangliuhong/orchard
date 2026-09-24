# TASK-001：初始化 Orchard 个人 AI 工作流工作台

> 状态：实施规划，尚未实现。  
> 规划日期：2026-09-24。  
> 目标仓库：jiangliuhong/orchard。  
> 建议落库路径：docs/tasks/001-initialize-workbench.md。  
> 本任务的交付物是可通过 CLI 启动、通过浏览器使用的第一版工作台，不只是目录、接口和空页面。

## 1. 任务依据与范围调整

本任务以用户上传的《Orchard Workflow Workbench 需求文档》以及本轮补充的九项描述为依据。二者冲突时，本轮明确提出的需求优先；其余变动是本规划提出的实施建议，不视为原文已有要求。

核对时 GitHub Contents 接口返回 `This repository is empty.`。因此按空仓库初始化规划，不假设仓库内已经存在可迁移的实现。

### 1.1 新定位

Orchard 是一个本地优先、面向单个使用者的个人 AI 工作流工作台。用户通过 CLI 启动服务，在浏览器内创建、编辑、发布、触发和观察自己的工作流。工作流采用 TypeScript 编排，可调用本机 CLI，也可将 Pi Agent 作为具有明确输入输出的节点。

这里的“本地 CLI”指 Orchard 服务所在机器上的 CLI，而不是浏览器所在机器上的 CLI。部署在服务器时，默认执行服务器命令；本版本不实现远程 Worker 协议。

“个人工作台”在初版中不引申为多用户 SaaS、多租户或团队权限系统。保留基础认证和本机防护，但不引入用户中心。

### 1.2 与附件的差异

| 主题 | 附件原要求 | 本任务的处理 |
| --- | --- | --- |
| 产品定位 | 为现有两个业务 Workflow 替代 Inngest 的执行平台 | 调整为通用个人工作台，业务流程作为使用案例 |
| Pi | 明确“不接入 Pi” | 被本轮描述覆盖：Pi 是节点执行和对话创建的核心集成 |
| 工作流定义 | 代码定义，不优先 DSL | 保留 TypeScript 为唯一执行定义，不引入另一套 JSON 编排语言 |
| 系统内创建 | 主要从可信项目目录加载 | 增加受控草稿工作区、对话生成、检查、人工确认发布 |
| HTTP 任意代码 | 不允许上传并执行任意代码 | 改为：认证后的所有者可编辑受管草稿；运行 API 仍只能执行已发布版本，不能直接执行请求体中的代码或任意路径 |
| 工作流目录 | 源码目录或其编译产物 | 开发示例与用户工作区分开；用户数据不写进全局 npm 安装目录 |
| 版本与独立进程 | 原第二阶段功能 | 基础不可变版本和子进程执行前移，服务于对话发布、隔离和停止 |
| SQLite、观察、并发、副作用保护 | 已明确要求 | 保留，并补充节点输入输出和每次尝试记录 |
| 可恢复执行 | 第二阶段功能 | 仍后置，不把初始化扩大成完整持久化编排引擎 |
| 原业务迁移 | 迁移 hello 和菲律宾指标流程 | hello 在初始化提供；菲律宾流程单列迁移任务，保留安全要求，不凭需求描述伪造原业务代码 |

附件的主要对应位置：项目定位第 11–15 行；阶段目标第 49–72 行；非目标第 74–86 行；代码定义第 149–181 行；业务迁移第 285–301 行；恢复与人工介入第 334–350 行。

### 1.3 初始化完成范围

第一版必须同时具备：CLI 启动服务、浏览器工作台、工作流草稿与发布、CLI 节点、Pi 节点、Pi 对话创建、SQLite 运行记录、步骤输入输出与日志、停止、有限节点重试、整次重新运行、Cron 调度、HTTP 事件触发，以及可注册的扩展接口。

以下不在本任务实现范围内：拖拽编排器、完整静态流程图、跨机器 Worker、多用户、多租户、插件市场、任意第三方依赖自动安装、交互式 PTY 终端、任意函数自动断点恢复、失败节点之后的手动续跑、外部系统的 exactly-once 保证。

## 2. 核心技术决策

以下为本任务选型，不表示附件已指定这些框架。

| 位置 | 选择 | 使用边界 |
| --- | --- | --- |
| 运行环境 | Node.js 24 LTS、TypeScript、ESM | 锁定并测试一个明确的 Node 24 补丁版本；不承诺未经验证的所有未来版本 |
| 工程组织 | 单仓库、模块化单体、一个 npm 发布包 | 初版不拆多个独立发布包，不引入微服务 |
| 包管理 | pnpm | 提交锁文件；终端用户通过 npm 安装发布包 |
| HTTP 服务 | Fastify 5 | 提供 API、基础认证、静态前端、SSE；不承担工作流业务编排 |
| Web UI | React、Vite、Tailwind CSS | 初版采用工作台布局；组件库不是核心架构依赖 |
| 前端数据 | TanStack Query + SSE | HTTP 获取快照，SSE 获取增量，服务端持久化记录是真相来源 |
| 数据层 | SQLite + better-sqlite3 + Drizzle ORM | Repository 边界；使用经验证的正式版本组合，不盲目安装文档中的 RC |
| 输入输出契约 | JSON Schema / TypeBox | 用于 API、工具与节点运行时验证；工作流导出纯 JSON Schema 元数据 |
| CLI | Commander | 仅处理命令、选项和引导；复用应用服务 |
| 外部进程 | node:child_process 的 spawn / fork | shell:false、流式输出、超时、退出和进程树管理 |
| Pi | 官方 TypeScript SDK + Orchard PiAdapter | 初始化时核对已发布包名、版本、导出和最小例子，锁定正式可用版本 |
| Workflow 编译 | TypeScript 检查 + esbuild 构建 | 二者用途不同，不能把转译成功当成类型检查通过 |
| 定时表达式 | cron-parser | 仅计算触发时间；队列、去重和状态仍由 Orchard + SQLite 管理 |
| 日志 | Pino + 结构化运行事件 | 系统日志与业务运行记录分层，写入前脱敏 |
| 测试 | Vitest、Fastify inject、Playwright | 单元、集成、浏览器与发布包冒烟验证 |

不依赖 Redis、BullMQ、Inngest、Temporal、外部数据库或 Docker 才能启动。实现一套范围明确的单机任务调度器，而非试图复刻通用分布式工作流引擎。

选择 Fastify 的原因是本项目需要嵌入一个 CLI 启动的小型 HTTP 服务，核心执行器应独立于 Web 框架。通过模块边界组织代码，而不是依赖 Controller 或 HTTP 生命周期运行任务。NestJS 并非不可用，但本任务没有必须引入其模块和依赖注入体系的需求。

better-sqlite3 存在原生二进制依赖；必须验证发布包安装，而不是仅在开发目录验证。TypeScript 和 esbuild 在此产品中还承担安装后的 Workflow 检查与发布功能，因此需要作为可用的运行时依赖交付，不能只放在最终安装时缺失的 devDependencies 中。

## 3. 用户体验目标

### 3.1 启动

目标命令如下；这些是待实现的命令，并不表示包已经发布或名称已被占用。

```bash
# 建议 npm 包名，发布前核验 npm scope 权限和名称可用性
npm install -g @jiangliuhong/orchard

# 首次运行自动初始化数据目录；默认以前台方式启动服务
orchard

# 与默认命令等价，参数可覆盖配置
orchard start --port 7331 --open

# 指定工作台数据目录
orchard start --data-dir ~/orchard-data --no-open

# 检查 Node、数据目录、SQLite、CLI 工具和 Pi 配置
orchard doctor
```

`orchard` 默认等同于 `orchard start`。默认监听 `127.0.0.1`；默认浏览器是否打开由配置控制，建议默认不打开，提供 `--open`。服务以前台方式运行，关闭进程后 Cron 不会继续执行；本任务不实现守护进程安装。

同一 data-dir 只允许一个 Orchard 主服务。第二次启动应明确报错并显示可用的连接信息，不能再启动一个调度器抢任务。

### 3.2 使用闭环

用户打开浏览器，创建空白 Workflow 或进入对话创建页面；描述需要的步骤，Pi 在受管草稿目录生成或修改 TypeScript。工作台展示源码差异、输入输出说明、所需工具和风险。用户执行检查、确认受控测试、确认发布，然后手动运行或配置触发器。

运行过程中可以看到当前活跃步骤、每个步骤的输入输出、日志、模型调用情况和尝试次数。停止按钮发出取消请求；重新运行按钮创建新的 Run，并保留原历史。

未配置真实模型时，工作台、代码节点和 CLI 节点仍可使用。Pi 页面显示明确的未配置状态，不用假 Agent 输出冒充成功。

## 4. 系统结构与依赖方向

```text
浏览器工作台
    │ HTTP + SSE
    ▼
Orchard 主服务（由 CLI 启动）
    ├── API / 认证 / 静态资源
    ├── Workflow 草稿、检查、版本与发布服务
    ├── 调度器 / 事件入口 / 运行队列 / 并发控制
    ├── Run、Step、Attempt 状态管理
    ├── SQLite Repository / 运行事件 / 产物索引
    └── WorkerSupervisor
             │ 受验证的 IPC
             ├── Workflow Worker A
             │       ├── Workflow SDK / StepRunner
             │       ├── NodeRegistry
             │       ├── CLI 工具适配器 → 本机 CLI 子进程
             │       └── PiAdapter → 模型与已授权工具
             └── Authoring Worker
                     └── PiAdapter → 受管草稿工具与检查工具
```

主服务负责数据库、调度和状态裁决。执行进程不得获得数据库连接或通过业务代码直接写库。执行相关信息经 IPC 发往主服务，由主服务验证 runId、attemptId、worker generation 等关联关系后持久化。

核心领域代码只能依赖契约，不能依赖 Fastify、React、Pi SDK 或 Drizzle 的具体实现。CLI 和 HTTP 都调用同一应用服务。

独立进程提供故障隔离和生命周期控制，不是安全沙箱。可信 TypeScript 在同一操作系统权限下仍可能访问文件和网络；工具白名单、路径约束和静态检查都不能把它变成不可信代码沙箱。

## 5. 代码与运行时目录

### 5.1 项目目录

```text
orchard/
├── src/
│   ├── cli/                   # 命令与配置引导
│   ├── server/                # Fastify、认证、路由、SSE、静态文件
│   ├── application/           # 用例服务，协调 Repository 和运行时
│   ├── core/                  # 领域实体、状态机、错误与策略
│   ├── workflow-sdk/          # 提供给 Workflow 开发者的公开 API
│   ├── runtime/               # WorkerSupervisor、IPC、StepRunner
│   ├── scheduler/             # 队列、Cron、事件分发、并发
│   ├── storage/               # Drizzle schema、Repository、迁移
│   ├── integrations/
│   │   ├── cli/               # CLI 工具与 ProcessController
│   │   └── pi/                # 上游 SDK 的唯一直接依赖边界
│   ├── authoring/             # 对话、草稿、差异、检查与发布
│   ├── artifacts/             # 产物保存、引用与受控下载
│   └── shared/                # 少量无业务状态的基础工具
├── web/                       # React/Vite UI
├── examples/                  # 可复制到用户工作区的示例
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/              # 假 CLI、假 Pi、可控故障
├── migrations/                # 随发布包携带
├── scripts/                   # 构建与发布包验证
├── docs/
│   ├── requirements-original.md
│   ├── product-v1.md
│   ├── architecture.md
│   ├── workflow-sdk.md
│   ├── security.md
│   ├── recovery-semantics.md
│   └── tasks/001-initialize-workbench.md
├── AGENTS.md
├── package.json
└── pnpm-lock.yaml
```

原始 REQUIREMENTS.md 原样保留为参考；新的 product-v1.md 明确覆盖项，避免 Agent 同时遵循“不接入 Pi”和“必须接入 Pi”。

### 5.2 用户数据目录

```text
~/.orchard/
├── orchard.db
├── config.json
├── workspaces/
│   └── default/
│       ├── drafts/<draft-id>/
│       └── workflows/<workflow-id>/
├── versions/<workflow-id>/<version-id>/
│   ├── source/
│   ├── workflow.mjs
│   └── manifest.json
├── artifacts/<run-id>/
├── logs/
└── runtime/                   # 实例锁与临时通信信息
```

SQLite 保存元数据、业务配置、状态、运行记录、消息和产物索引。TypeScript 源码、编译版本和大型产物存文件系统。不要把用户数据写到项目源码目录或 npm 全局包目录。

凭据仅保存引用。可以引用用户明确配置的环境变量或受限制的本地凭据存储，不把 API Key 放进 Workflow 源码、消息记录、普通配置快照或可查看的节点输入输出。

## 6. Workflow 与扩展契约

### 6.1 概念

| 概念 | 含义 |
| --- | --- |
| WorkflowDefinition | 一份 Workflow 的定义与输入输出契约 |
| WorkflowVersion | 已发布、不可变、可执行的版本 |
| Run | 对明确版本的一次运行 |
| NodeDefinition | 节点的类型、配置与声明 |
| NodeExecutor | 某类节点的执行实现 |
| StepRun | 一次运行中一个稳定 stepId 对应的步骤记录 |
| StepAttempt | 同一步骤的某次实际执行尝试 |
| ToolDefinition / ToolAdapter | 工具参数、能力及实际调用方式 |
| ToolInvocation | 节点内部的一次工具调用，含独立副作用记录 |
| TriggerDefinition / TriggerAdapter | 创建 Run 的触发规则与入口 |
| AuthoringSession | 创建或修改 Workflow 的对话，不等于业务 Run |
| ArtifactRef | 大型输出或文件产物的受控引用 |

不得把 Workflow、某次 Run、节点类型和某次节点执行混成一个对象。不得通过修改旧记录来实现重试。

### 6.2 必须暴露的扩展边界

```ts
// 设计示意，初始化时完善类型约束和运行时校验后作为公开契约。
interface NodeExecutor<Config, Input, Output> {
  readonly type: string;
  readonly version: string;
  readonly configSchema: JsonSchema;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  execute(context: NodeContext, config: Config, input: Input): Promise<Output>;
}

interface ToolAdapter<Input, Output> {
  readonly type: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  execute(context: ToolContext, input: Input): Promise<Output>;
}

interface TriggerAdapter<Config> {
  readonly type: string;
  readonly configSchema: JsonSchema;
  // 产生候选触发；最终去重和 Run 创建必须经过应用服务事务。
  start(context: TriggerContext, config: Config): Promise<TriggerHandle>;
}
```

`NodeContext`、`ToolContext` 至少提供 runId、stepId、attemptId、AbortSignal、日志、产物保存、已授权工具调用、明确的工作目录和凭据解析能力。不得暴露数据库句柄。

工具定义还需声明副作用类别 `read_only | idempotent | non_idempotent | unknown`、取消能力、超时、最大输出、环境变量引用和权限需求。副作用类别是适配器和用户的可信声明，不是引擎能自动证明的事实；默认按 unknown 处理。

NodeRegistry、ToolRegistry、TriggerRegistry 各自独立。Pi 可以通过桥接层调用已授权的 ToolRegistry 工具，从而复用 CLI 适配能力；工具调用也必须进入统一观测和副作用记录。

公共接口类型 ID 使用命名空间，如 `core.code`、`core.cli`、`ai.pi`。初版用显式注册实现扩展即可，不建设插件市场。新增内置节点或工具不应要求修改调度状态机。

### 6.3 首批节点

| 类型 | 用途 | 初版规则 |
| --- | --- | --- |
| core.code | 可信 TypeScript 数据处理 | 用显式步骤包装；导入与执行均在子进程中 |
| core.cli | 调用已注册 CLI 工具 | 复用 ToolRegistry；不得接受运行请求临时传入的任意 executable |
| ai.pi | 使用 Pi 完成一次 LLM/Agent 子任务 | 独立会话、明确输入、可验证输出、授权工具列表 |
| core.delay | 流程内等待 | 可取消；记录 wakeAt；初版不保证服务重启后自动继续该代码位置 |

Cron 和事件是触发器，不是上述四种节点。未来的“流程内等待事件”也不是初版 HTTP 事件触发的同义词，另列能力扩展。

### 6.4 建议的 Workflow API 形态

以下是目标 API 示例，不是当前已发布可运行的包接口。初始化任务应实现并测试对应 SDK，不能把示例直接当作现成依赖。

```ts
import { defineWorkflow, Type } from '@jiangliuhong/orchard/workflow';

export default defineWorkflow({
  id: 'daily-summary',
  name: '每日数据摘要',
  inputSchema: Type.Object({
    date: Type.String(),
  }),
  outputSchema: Type.Object({
    summary: Type.String(),
  }),
  concurrency: 1,

  async run(ctx, input) {
    const report = await ctx.step.execute('collect-report', {
      type: 'core.cli',
      config: { toolId: 'local.read-report' },
      input: { date: input.date },
    });

    const summary = await ctx.step.execute('summarize-report', {
      type: 'ai.pi',
      config: {
        agentProfileId: 'report-summary',
        outputSchema: Type.Object({ summary: Type.String() }),
        tools: [],
      },
      input: {
        instruction: '根据给定数据生成摘要，不添加未经证实的信息。',
        data: report,
      },
    });

    return summary;
  },
});
```

要求：stepId 在同一运行内稳定且唯一；循环步骤必须包含稳定的迭代标识；节点输入和输出都校验；JSON 值或产物引用可以持久化，进程句柄、流、连接和密钥不能作为输出。

条件和顺序继续使用 TypeScript 控制流。本任务先保证顺序流程、条件和受约束循环；不承诺完整并行分支/汇合语义。运行详情保留活跃步骤集合的字段，避免将来扩展并行时只剩一个 currentStepId。

通过运行事件展示实际执行的步骤时间线。不要声称可以从任意 TypeScript 静态推导全部未来分支或准确完成百分比。

## 7. 版本、发现、草稿与发布

开发者可在可信工作区添加 Workflow，用户也可通过 UI 新建草稿。统一经过：

```text
创建/编辑草稿
    → 静态检查与 TypeScript 类型检查
    → 编译
    → 用户授权的受控测试
    → 用户确认发布
    → 保存不可变版本
    → 更新当前发布指针
```

发布产物必须至少保存源码快照、构建结果、内容哈希、SDK 兼容版本和依赖清单。工作流相对导入应纳入构建快照；不得让发布后的代码仍读取会被草稿编辑覆盖的模块。

首版限制 Workflow 依赖为 Orchard SDK 和工作区内受管文件；新第三方包的安装不由 Agent 自动执行。未来依赖扩展必须有明确安装授权、锁文件和版本可复现策略。

全局 npm 安装后，受管工作区的 Workflow 必须能解析 Orchard SDK。编译器应显式提供包路径映射或等价解析机制，不能假设任意工作目录都能自然解析全局 npm 包。

新 Run 在创建时绑定明确的 WorkflowVersion，不在开始执行时再读取“最新版本”。工具定义、模型配置、提示词和允许工具列表也应记录配置快照与版本引用；凭据只保留 secretRef。模型供应端可能变化，不能宣称模型输出可完全复现。

发布新版本不影响旧 Run。编译或加载失败不替换当前可用版本；停用版本不删除历史。导入校验可能执行模块顶层代码，因此也必须在子进程及明确的所有者授权边界内进行，不能在 API 主进程直接 import 用户草稿。

## 8. Pi 的两种职责

### 8.1 Workflow 执行节点

运行 Pi 节点时，建立本次 Attempt 专属会话。默认不继承其他 Workflow、AuthoringSession 或用户无关 Pi 会话的上下文。

输入包含任务说明、前序步骤结果、模型配置引用、可用工具以及期望输出契约。输出至少包含最终文本或结构化结果；运行元数据保存 provider、model、会话引用、可获得的用量、耗时、结束原因和工具调用记录。

结构化输出必须实际执行运行时校验。供应商不支持强制结构化输出时，由适配器解析并校验；失败有明确错误码。修复提示或重试必须受限，并说明可能发生额外模型费用和工具副作用，不能自动无限追问。

不要假定 SDK 的低层单个事件等同于整个任务结束；以所锁定 SDK 版本的官方会话完成语义为准。正确解除订阅、取消并销毁会话。

默认仅启用明确授权的工具。不无条件加载用户全局 Pi 扩展或默认 shell/write 工具。需要复用用户已有 Pi 登录和配置时，先在设置中显式选择并验证来源。

### 8.2 Workflow 对话创建

AuthoringSession 与业务 Run 分开持久化。Pi 的目标是创建或修改草稿，不是直接更改已发布版本，也不是决定任务是否已经成功。

首版为 Authoring Agent 提供受控工具，例如：

```text
list_workflows
inspect_workflow
list_node_types
list_tools
read_draft_file
write_draft_file
validate_draft
request_test
request_publish
```

写文件工具只能作用于当前草稿根目录；校验路径、真实路径和符号链接。静态检查可以自动执行；执行草稿和真实工具测试必须经过用户授权；自动测试默认使用 fixture CLI 和 mock Pi。

`request_publish` 仅创建待确认操作，由用户通过 UI 确认。发布确认绑定草稿内容哈希，确认后草稿又发生变化时原确认失效。相同原则用于具有副作用的测试授权。

对话界面展示消息流、生成文件、差异、检查结果、所需工具、风险与确认按钮。模板和手动编辑入口也要存在，不能把“只能靠模型创建”当成产品限制。

## 9. SQLite 模型与持久化

### 9.1 最小数据模型

| 表 | 用途与关键字段 |
| --- | --- |
| workflows | id、名称、描述、当前发布版本、归档状态 |
| workflow_versions | workflowId、versionId、contentHash、artifactPath、manifest、createdAt |
| workflow_drafts | 草稿路径、基准版本、状态、revision/contentHash、检查结果 |
| runs | workflowVersionId、trigger来源、inputRef、outputRef、status、时间、retryOfRunId、cancel信息 |
| step_runs | runId、stepId、nodeType、配置快照、状态、输入输出引用、开始结束时间 |
| step_attempts | stepRunId、attemptNo、错误、输入输出引用、超时、执行者generation、开始结束时间 |
| tool_invocations | attemptId、toolId、输入输出引用、副作用类别、幂等键、外部关联ID、结果确定性 |
| run_events | 单调序号、runId、stepId、attemptId、事件类型、脱敏payload、时间 |
| triggers | workflowId、版本策略、类型、配置、enabled、timezone、nextFireAt、misfire策略 |
| trigger_occurrences | triggerId、occurrenceKey、scheduledFor、runId、处理状态；负责触发去重 |
| incoming_events | source、eventId、name、payload、接收与分发状态 |
| authoring_sessions | workspaceId、draftId、状态、模型配置引用 |
| authoring_messages | sessionId、消息序号、消息内容、工具调用与结果引用 |
| tool_configs | 工具定义、配置、权限、版本、secretRef；不存裸密钥 |
| agent_profiles | 模型与资源配置、允许工具、secretRef；不存裸密钥 |
| artifacts | id、关联run/step、受管路径、大小、hash、mime、保留策略 |
| audit_actions | 发布、停用、取消、风险确认、重新运行、人工确认的操作记录 |

不强制为队列另建表；初版可以直接对 runs 中的 queued 状态进行原子认领。迁移表由所选迁移方案提供。

### 9.2 约束

必须有明确唯一约束：Workflow 版本键、(runId, stepId)、(stepRunId, attemptNo)、Cron 的 (triggerId, scheduledFor)、事件来源的 (source, eventId) 及触发分发唯一键。

数据库启用 WAL、外键和合理 busy_timeout。事务保持短小；执行 CLI 或调用模型时不得持有数据库事务。单实例锁加状态条件更新防止重复认领，不依赖纯内存 Map 维护队列真相。

工作台数据库使用本机文件系统，不把 WAL 数据库直接当作多机器共享数据库。日志批量写入，避免每个模型 token 都进行一次同步数据库写入。大型查询分页。

先提交状态和对应事件，再对外通过 SSE 通知。事件序号应可用于断线续传；状态快照可纠正漏失或过期增量。

所有迁移随 npm 包发布。首次启动自动建库，升级执行兼容迁移；破坏性变更提供备份指引，失败不能继续以半升级状态启动。

### 9.3 输入输出与产物

每步、每次 Attempt 都保存实际输入、输出或其产物引用，失败时保存已有部分输出和错误。UI 中的大对象展示预览并提供受认证的下载，不只显示一个不可访问的本地路径。

建议初始阈值：单个 JSON 值 64 KiB 以内内联，超过后保存到产物文件；阈值可配置。达到硬上限必须明确失败或说明截断，不能静默丢弃数据。

日志、消息、错误和可查看输入输出统一脱敏；凭据只使用 secretRef。不要把脱敏显示内容误当成将来可恢复执行的完整输入。业务敏感数据的本地保存范围与保留期限在设置和文档中说明。

## 10. 运行、停止和重试语义

### 10.1 状态

保留附件定义：

```text
queued
running
waiting
succeeded
failed
cancel_requested
cancelled
interrupted
needs_review
```

使用显式状态机和状态转换测试。等待中的自动重试可使用 waiting 加 waitReason/retryAt，而非随意增加相互重叠的状态。

### 10.2 执行与并发

初始全局并发为 2，可配置。Workflow 可设置更小的独立并发上限；业务互斥键与并发上限分开建模。

主服务事务认领 Run、保存开始意图后启动 Worker。执行 Step 前，主服务先保存 Attempt 和必要的副作用意图，再允许 Worker 发起外部调用。无法消除“外部已成功、本地未收到结果”的窗口，应保守记录，而非宣称 exactly-once。

CLI 与 Agent 不在 HTTP handler 内直接执行。CPU 密集工作和任意业务代码不阻塞 API 主进程。

### 10.3 停止

排队中的 Run 可直接取消。运行中的 Run 先保存 cancel_requested，再通过 IPC 传播 AbortSignal，并阻止开始后续 Step。

CLI 由 ProcessController 管理可控进程树；Pi 调用对应会话取消方法。超出宽限期后可终止执行进程并回收资源。终止父进程不等于所有后代都已终止，必须按目标平台测试。Worker 也应监听父进程连接断开并尽力清理自身管理的命令。

不要收到取消 HTTP 请求就立即显示 cancelled。必须展示“正在停止”，并在确认本地执行结束后给出结果。外部任务可能仍在运行时显示明确警告，并将不确定结果转 needs_review；不得把它伪装成远端已取消。

迟到的 Worker 消息不能把已停止或已裁决的运行改回 running/succeeded。保留迟到结果的审计信息，但主状态由服务端依据 generation 和状态机裁决。

### 10.4 三种重试必须区分

| 操作 | 初版是否提供 | 语义 |
| --- | --- | --- |
| 节点自动重试 | 是 | 同一 Step 增加 Attempt，有限次数与退避，仅对策略允许的错误和副作用类型执行 |
| 整次重新运行 | 是 | 创建新的 runId、retryOfRunId，默认原输入和原版本；不会覆盖旧历史 |
| 从失败步骤继续 | 否，后续扩展 | 需要检查点与回放协议；初版不能做一个看似成功、实际重新提交副作用的按钮 |

通用 CLI 和带可写工具的 Pi 默认不自动重试。read_only 或有明确幂等与结果确认协议的工具可以配置有限重试。所有策略都必须有 maxAttempts、超时和取消检查，maxAttempts 表示包含首次执行的总尝试次数。

重新运行同样可能再次产生副作用；界面必须提示会从头执行。处于 needs_review 的运行不能通过“重新运行”绕过确认：先完成结果核对与风险确认，并留下审计。

### 10.5 服务退出与重启

正常关闭：停止接收新运行、停止认领队列、请求执行进程退出、等待有限宽限期、持久化最终状态、关闭 SSE 与数据库。

重启后：queued 继续排队；Cron 和已持久化事件恢复调度。原 running/waiting/cancel_requested Run 不自动重放任意 TypeScript：根据是否可能存在外部副作用，标记 interrupted 或 needs_review。

初版 core.delay 的 wakeAt 和自动重试 retryAt 用于记录与观察，不能据此声称恢复了 JavaScript 调用栈。自动从持久化等待恢复流程在后续检查点版本实现。

## 11. 调度与事件触发

### 11.1 Cron

每个触发器保存表达式、显式 IANA 时区、输入模板、版本策略、enabled、nextFireAt 和错过触发策略。工作台默认时区来自明确的用户设置，可初始化为检测到的本机时区，并在创建页面展示。

建议初版统一五段 Cron，分钟级精度；对 cron-parser 支持的其他格式不自动开放。拒绝未定义的秒级表达式、随机 H 扩展和模糊日期组合，避免本产品语义随依赖能力无意扩张。

扫描到触发时间后，在同一事务创建 occurrence、创建或排队 Run、更新 nextFireAt。使用唯一约束防止重复扫描生成多个 Run。

初版 misfirePolicy 固定为 skip，并对停机期间错过的触发提供说明或摘要。后续增加 fire-once 和有上限的 catch-up，不默认补跑停机期间所有次数。

默认触发器引用某个 Workflow，入队时解析当前发布版本并写进 Run；也可选择固定版本。修改触发器不修改已经入队的 Run。

进程没有运行时，不会有后台 Cron。UI 和 README 必须明确这一点。

### 11.2 HTTP 事件

初版实现认证入口：

```http
POST /api/events
Content-Type: application/json
Authorization: Bearer <token>

{
  "source": "local-script",
  "id": "report-2026-09-24-001",
  "name": "report.generated",
  "data": { "date": "2026-09-24" }
}
```

事件匹配启用的 Trigger，再创建 Run。事件本身和分发状态先落库，不依赖进程内 EventEmitter 保证投递。

相同 source + id + 相同内容重复发送，应返回同一接收结果并避免重复 Run；同一键但不同内容应明确报冲突。一个事件可以匹配多个工作流，分发唯一键至少包含 eventId 和 triggerId。

v0.1 只提供显式 HTTP 事件接入，不自称已经监听 GitHub、文件变更、邮件或其他外部平台。后续这些入口通过 TriggerAdapter 加入。Webhook 签名、限流和来源权限属于对应适配器的要求。

## 12. API 与页面

### 12.1 最小 API 分组

| 分组 | 目标接口 |
| --- | --- |
| 健康与配置 | GET /api/health；GET /api/settings；受限的设置更新 |
| Workflow | GET /api/workflows；GET /api/workflows/:id；GET /api/workflows/:id/versions |
| 草稿 | 创建、读取、更新草稿；检查草稿；创建受控测试；确认发布 |
| 运行 | POST /api/workflows/:id/runs；GET /api/runs；GET /api/runs/:runId |
| 观察 | GET /api/runs/:runId/steps；GET /api/runs/:runId/logs；GET /api/runs/:runId/events |
| 控制 | POST /api/runs/:runId/cancel；POST /api/runs/:runId/retry；人工确认接口 |
| 触发器 | 创建、读取、修改、启用/停用 Trigger；POST /api/events |
| 对话 | 创建 AuthoringSession、发送消息、读取历史、事件流、停止生成 |
| 扩展目录 | GET /api/node-types；GET /api/tools；受认证的工具配置 |
| 产物 | GET /api/artifacts/:artifactId |

URL 中的 ID 只能查找服务端记录，不用于拼接任意模块路径。草稿更新接口是明确的所有者编辑能力，不与 Run 输入混用。SSE 与 HTTP 读取使用相同访问控制。

API 有稳定的错误结构，至少包含 code、message、requestId；输入、输出、事件和 IPC 都校验。取消、触发和重新运行有幂等处理，避免用户重复点击创建意外任务。

### 12.2 最小页面

| 页面 | 验收内容 |
| --- | --- |
| 工作流列表 | 名称、描述、发布版本、最近运行、新建入口 |
| Workflow 详情 | 输入说明、源码/版本、手动运行、触发器、历史入口 |
| 对话创建/编辑 | 对话、文件差异、检查结果、测试授权、发布确认 |
| 运行列表 | 状态、触发来源、时间、耗时、筛选 |
| 运行详情 | 活跃步骤、时间线、每次尝试的输入输出、日志、错误、产物、停止与重新运行 |
| 设置 | 工作区、CLI 工具、Pi 模型/凭据引用、默认时区、并发、保留策略 |

初版展示运行时间线，不做拖拽画布，也不展示没有可靠计算依据的“完成 83%”。步骤未开始时不伪造输入输出；数据截断、脱敏、外部状态不明均有明显提示。

SSE 至少支持稳定序号、断线重连、快照刷新和事件去重。客户端重连不能造成重复步骤或状态倒退。

## 13. 安全与运维底线

默认绑定 127.0.0.1，但不能把“仅本机监听”当成完整认证。实现本地会话令牌或等价认证、Origin/Host 校验，不开通配 CORS；浏览器写操作防跨站请求。初始认证可采用一次性引导令牌换取 HttpOnly 会话，凭据不嵌入静态 JS，也不进入普通访问日志。

非回环监听必须显式设置并启用认证；远程使用建议置于可信网络和 TLS 反向代理后。没有完成对应验证时不声明为公网多用户服务。

CLI 工具使用 executable + args 数组，不将用户输入拼接进 shell。命令参数和工作目录必须按工具定义校验，必要时固定子命令并使用参数分隔符。shell:false 防止的是 shell 解析，不代表危险命令参数本身就是安全的。

草稿、版本、产物下载都防路径穿越和符号链接逃逸。Agent 默认不能安装 npm 包、修改工作台核心代码、写任意用户目录或自行发布版本。

日志、SQLite 文件、配置和产物位于用户私有目录，尽力限制文件权限。保留策略必须保护仍被 Run 引用的版本与产物，不能为了清理空间破坏可追溯性。

第一版以 macOS 和 Linux 为验收目标。Windows 的 npm CLI 启动、路径与进程树终止单独验证后再声明支持；ProcessController 预留平台实现，不用未经测试的“跨平台”承诺。

## 14. 实施子任务

以下是同一个初始化父任务下的子任务。按依赖顺序实现；每个子任务应形成可检查的提交，不把所有功能塞进一次大提交。

### T01：工程、决策与依赖验证

建立单发布包、TypeScript ESM、Fastify、Vite/React、pnpm 锁文件与 CI。补充原需求存档、product-v1.md、architecture.md 和 AGENTS.md。

验证 Node 24、SQLite 驱动、Pi 正式 SDK 的最小运行例；只锁定实际可安装、可编译的 API。确定包名、bin 和 exports；为运行时编译依赖明确发布策略。

验收：typecheck/lint/test/build 可运行；CLI 能启动 /api/health 并提供空工作台；CI 不需要真实模型密钥。

### T02：领域契约与公开 Workflow SDK

实现 WorkflowDefinition、Run/Step/Attempt、错误模型、状态机、Node/Tool/TriggerRegistry、Context 和公共 SDK 导出。加入输入输出验证。

验收：非法状态迁移被拒绝；重复 stepId 有明确错误；通过注册新 fixture 节点或工具可执行，而无需修改调度器。

### T03：SQLite 与持久化边界

完成 schema、迁移、Repository、事务方法、事件序号、产物引用和 data-dir 初始化。加入实例锁与原子认领。

验收：建库和再次启动均通过；唯一约束有效；提交状态与事件一致；重复启动同一 data-dir 被拒绝；数据库不存测试密钥。

### T04：草稿、编译、发现与版本发布

实现受管工作区扫描、草稿文件操作、检查、构建、不可变快照、发布指针和版本查询。草稿验证进程不在 API 主进程执行模块。

验收：合法 Workflow 能发布；非法文件不导致所有工作流失效；加载失败保留旧版；新 Run 绑定版本；从全局安装的包也能编译用户工作区源码。

### T05：执行器、步骤观察与停止

实现 WorkerSupervisor、IPC、StepRunner、RunQueue、全局与 Workflow 并发、core.code/core.delay、结构化事件、取消与退出恢复扫描。

验收：hello-workflow 两步运行，输入输出完整；并发不超限；排队和运行中取消正确；子进程崩溃主服务仍可用；重启后记录不丢且状态正确。

### T06：本机 CLI 与 Pi 执行节点

实现 ProcessController、CLI ToolAdapter、PiAdapter、core.cli、ai.pi、ToolInvocation 审计、权限、超时、输出限制及可控自动重试。

验收：CLI stdout/stderr 流式可见；取消清理可控进程；Pi 有真实接入路径与可测试替身；结构化输出校验失败可查询；未知副作用不自动重试。

### T07：Cron、事件与重新运行

实现触发器存储、Cron 计算、occurrence 去重、HTTP 事件接收与分发、整次重新运行、needs_review 确认操作。

验收：同一 Cron 时间点不重复创建；事件重发不重复执行；服务重启后恢复待分发事件；重试创建新 Run 且引用原历史；未知副作用必须先确认。

### T08：工作台 API、页面与实时观察

完成最小 API 与页面矩阵、认证、SSE、分页、输入表单/JSON 编辑、步骤时间线、Attempt 详情、产物查看、取消和重新运行操作。

验收：浏览器完成“选择工作流→输入→运行→查看每步输入输出→停止/重新运行”；刷新页面后仍看到历史；断线重连不重复事件；未授权调用失败。

### T09：Pi 对话创建闭环

实现 AuthoringSession、消息存储、受限工具、草稿差异、检查反馈、测试授权和发布确认。复用 T04，不另起一套发布逻辑。

验收：用户通过对话创建“fixture CLI→Pi 摘要”工作流，经检查和确认发布后可运行；生成中的取消有效；Agent 不能未经确认发布；生产配置缺失不会伪装生成成功。

### T10：发布包、故障注入与使用文档

构建 CLI、执行进程、前端静态资源、迁移、SDK 类型及示例；配置 package.json 的 files、bin、exports 和构建产物路径。

通过 npm pack 生成安装包，在仓库外临时目录安装并运行，验证没有源码、开发服务器和 pnpm 工作区依赖也能使用。补充 README、Workflow SDK 文档、安全说明、恢复语义和迁移任务。

验收：干净环境下 CLI 启动、草稿编译、fixture 工作流运行、UI 查看、重启历史保留；测试覆盖 macOS/Linux 目标环境；发布仅在另行授权后执行。

### 推荐的三个里程碑

| 里程碑 | 内容 | 完成信号 |
| --- | --- | --- |
| M1：可运行基础 | T01–T05 + 最小观察页 | CLI 启动、SQLite、已发布 hello、两步输入输出、停止、历史 |
| M2：可用工作台 | T06–T08 | CLI/Pi 节点、触发器、重试、完整运行详情 |
| M3：初始化完成 | T09–T10 | 对话创建并发布，安装包在干净环境跑通 |

M1 和 M2 是中间产物，不等于九项需求全部完成。M3 通过后才标记 TASK-001 完成。

## 15. 验收测试矩阵

| 场景 | 必须证明的结果 |
| --- | --- |
| 第一次启动 | 自动创建数据目录和库，可打开 UI |
| 无模型配置 | hello/CLI 仍可用，Pi 返回明确未配置状态 |
| 正常两步运行 | Step 输入输出和最终结果持久化 |
| CLI 失败 | 保留 exitCode、脱敏stderr、错误及部分输出 |
| CLI 输出过大 | 产物引用可访问，达到硬上限时明确处理 |
| Pi 结构化输出不合法 | 明确失败，不将任意文本当作合格 JSON |
| Pi 内部工具调用 | 每次工具调用可审计，副作用策略不被绕过 |
| 自动重试 | Attempt 次数正确，退避可控，可取消，无无限重试 |
| 整次重试 | 新 Run 引用旧 Run、原记录不变，版本保持明确 |
| 未知外部结果 | 进入 needs_review，不自动重新提交 |
| 排队取消 | 不启动 Worker |
| 运行取消 | 显示取消请求，终止可控执行，后续步骤不启动 |
| 迟到结果 | 不覆盖已裁决状态 |
| Worker 崩溃 | API 可用，Run 状态正确 |
| 主服务重启 | queued 和触发器恢复；活跃代码运行不被冒充自动续跑 |
| 并发限制 | 全局和单 Workflow 都不超限 |
| Cron 去重 | 同一 occurrence 最多创建一个 Run |
| 停机错过 Cron | 按 skip 策略处理，不突然补跑大量任务 |
| 事件重发 | 同源同ID不重复创建；同键异内容返回冲突 |
| 事件分发中重启 | 已持久化事件可继续分发且去重 |
| 发布新版本 | 旧 Run 不换版本；失败发布不破坏旧版 |
| 草稿被更改 | 原发布确认失效，不发布未确认新内容 |
| 路径与认证 | 未授权、路径穿越、任意模块执行被拒绝 |
| SSE 重连 | 补齐/刷新状态，事件不重复，状态不倒退 |
| 安装包 | 仓库外安装、启动、编译草稿与运行全部通过 |

默认测试使用假 CLI、假 Pi 和模拟事件，不访问真实远程业务系统。真实 Pi 冒烟验证是单独、用户显式提供凭据的检查，不作为无密钥 CI 的前提。

## 16. AGENTS.md 必须写入的工程规则

遵循 product-v1.md 中明确覆盖后的需求，不重新引入“不接入 Pi”等旧决策。业务 Workflow 只依赖公开 SDK；core 不直接依赖 Fastify/Pi/Drizzle；工作流和工具不直接写数据库。

禁止在 HTTP handler 直接执行长任务；禁止拼接用户 shell 命令；禁止将真实凭据写入源码、快照、日志或测试；禁止把子进程等同安全沙箱。

任何新增节点都必须定义输入输出验证、超时、取消、错误、副作用与重试行为。任何状态迁移、事件去重、版本绑定都必须附测试。

默认不执行真实业务 Workflow、不产生真实外部副作用、不自动安装额外系统工具、不自动发布 npm 包。没有真正执行的测试只能标记未验证，不能写成已通过。

完成功能必须从 UI、API 到持久化贯通；不能仅放 TODO、mock 按钮或空实现声称完成。测试替身只能在明确的测试/演示环境使用。

## 17. 原业务 Workflow 的后续迁移任务

创建单独任务 TASK-002：迁移 phl-funding-cost-difference-workflow 及 metric-cli 适配器。附件未包含对应实现源码，初始化只依据描述建立契约与测试夹具，不宣称已经保留真实实现行为。

迁移时必须保持：目标任务身份校验、提交前历史基线、提交后的任务关联、最多 180 次轮询、30 分钟期限、读取失败有限重试、失败状态处理、缺少 dbt.output 明确失败、不明确提交状态不得重复提交。

上述业务规则留在 Workflow 或 metric-cli 适配器，不写入 Orchard 核心调度器。真实接口参数、响应字段和关联策略以迁移时取得的源码与接口为准，不能仅凭需求文件补造。

## 18. 后续可恢复执行的预留

后续另立任务实现受约束的检查点/回放协议。只有显式支持的 Workflow 才能复用已完成 Step 输出、恢复持久化等待、从失败步骤继续。需要固定代码版本、稳定步骤标识、确定性的步骤外编排、配置快照与外部结果核对协议。

随机数、当前时间、任意文件读取和外部调用不能在回放中被无条件重复执行。不能通过 JSON 序列化任意 JavaScript 调用栈。外部副作用状态不明时优先核对，不自动重放。

本任务为上述能力保留版本、Attempt、wakeAt、关联ID和副作用记录，但不会用这些字段的存在冒充能力已完成。

## 19. 完成标准与交付报告

最少提供以下工程命令：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm test:package
```

最终交付报告逐项写明实际实现范围、运行命令、已执行测试及结果、未验证的真实集成、已知限制和后续任务。不得因为只完成 M1 就将初始化父任务关闭。

交付的 README 面向使用者说明安装、启动、配置 Pi/CLI、创建流程、运行观察和数据位置；架构与实现细节放 docs，不把 README 写成内部设计总汇。

## 20. 参考依据

内部需求依据：用户上传的 REQUIREMENTS.md（429 行）和本轮九项补充。原文行号见第 1 节及迁移、安全、状态、恢复对应章节。

以下为本规划核对过的官方资料。它们用于解释选型能力，不代表 Orchard 已实现这些能力；依赖的确切发布版本仍须在 T01 安装验证后锁定。

- Node.js Releases：Node 24 的 LTS 状态与受支持运行线。
- Fastify Plugins、Validation and Serialization：插件封装、JSON Schema 验证，以及不能盲目信任动态 schema 的限制。
- Drizzle SQLite：SQLite 驱动集成，包括 better-sqlite3。
- better-sqlite3 README：原生二进制、事务及 WAL 使用。
- Pi SDK：Node/TypeScript 嵌入、独立会话、事件、工具控制与取消。
- Node.js 24 child_process：spawn/fork、IPC、shell 与进程生命周期。
- cron-parser：Cron 解析、时区和下次触发时间计算。
- Vite Building for Production：静态前端生产构建。
- esbuild Content Types：TypeScript 转译不替代类型检查。
- Fastify Type Providers：TypeBox 等 schema 的类型推导接入。
- SQLite WAL：日志模式与同主机文件系统边界。

```text
https://nodejs.org/en/about/previous-releases
https://fastify.dev/docs/latest/Reference/Plugins/
https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
https://orm.drizzle.team/docs/sqlite/get-started-sqlite
https://github.com/WiseLibs/better-sqlite3
https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/sdk.md
https://nodejs.org/docs/latest-v24.x/api/child_process.html
https://github.com/harrisiirak/cron-parser
https://vite.dev/guide/build
https://www.sqlite.org/wal.html
https://esbuild.github.io/content-types/#typescript
https://fastify.dev/docs/latest/Reference/Type-Providers/
```
