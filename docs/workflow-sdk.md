# Workflow SDK 与 Authoring

当前提供工作流定义、触发器/执行策略校验、稳定步骤标识、源码校验、编译、版本发布和受控 artifact 关联。SDK 定义本身不执行或持久化工作流；运行时通过已发布版本加载并执行。

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

TypeBox 定义可推导输入输出类型；也接受普通 JSON Schema。`defineWorkflow` 只定义工作流，不执行或持久化它。调用方必须使用运行边界校验输入和输出，不能把 TypeScript 类型断言当作运行时校验。

## 校验边界

- `validateJson` / `assertValidJson` 使用 Ajv 严格模式的 JSON Schema draft-07。
- 支持 TypeBox 的 JSON Schema 兼容构造，包括 object、array、union、literal、optional、数值范围和字符串约束。
- 不自动转换类型、填默认值或删除属性；未知关键字、未注册 format、异步 schema 明确报错。
- 仅允许 JSON 值；拒绝 undefined、非有限数值、BigInt、函数、循环引用、Date、Map 等。共享的非循环对象允许通过。
- schema 是可信代码，不能直接接收任意 HTTP schema 并在主服务编译。未来草稿检查必须放在授权 Worker 中；当前未提供相关 HTTP 接口。
- schema 编译后应视为不可变，不支持原地修改已使用 schema。

## 执行与扩展

`NodeRegistry`、`ToolRegistry` 和 `TriggerRegistry` 独立注册，拒绝重复类型及未知类型。Tool 必须声明版本和副作用类别，不确定时声明 `unknown`。

`createWorkflowContext` 校验步骤的人类可读 ID，并在重复调用时生成稳定实例 ID：第一次为 `item`，后续为 `item:1`、`item:2`。这允许循环和重放识别同一逻辑步骤的不同实例；取消后仍拒绝后续步骤。

`StepRunner` 校验节点 config/input/output，将 runId、stepId、attemptId、日志函数和 AbortSignal 传给注册节点。取消后返回的迟到结果不会作为成功输出返回，但这不代表外部副作用已经撤销。

当前 StepRunner 是内存调用原语，不负责超时强杀、持久化 Attempt、工具授权、重试、进程隔离或调度。Trigger 契约尚未接入候选触发投递事务；不可据此宣称已实现事件/Cron 调度。

## Authoring 与发布

工作流源码默认使用 `worker.ts` 作为入口。Authoring 会检查 TypeScript 入口、相对文件边界、符号链接、允许的 import 前缀和 capability 白名单；编译器生成 content-addressed ESM bundle 以及 source tree/bundle hash。发布时先写入临时 artifact 目录，再原子移动并创建不可变 Workflow Version；校验或发布失败不会切换当前激活版本。

工作流定义可以声明 `triggers` 和 `policy`，包括 event/cron/manual/invoke 触发类型、超时、重试、限流、节流、debounce 和 singleton 的结构化配置。策略值在 `defineWorkflow` 阶段进行基础校验，调度器仍需在运行边界执行其语义。

## 源码中的描述

工作流名称、描述、触发器、执行策略和并发配置只从版本关联的入口源码读取。数据库中的对应信息仅作为发布流程生成的备份，不能通过接口或 Repository 单独修改，也不能作为配置缺失时的回退来源。推荐在默认导出的 `defineWorkflow` 定义中填写 `name`、`description`、`triggers`、`policy` 和 `concurrency`；描述也支持入口默认导出前的相邻注释。缺少名称时使用工作流 ID 标识，缺少描述时显示“暂无描述”。

发布始终保存源码与 bundle 的版本副本；修改工作区代码后必须发布新版本，已有 Run 继续读取其绑定版本的源码配置。发布时生成 `workflow_versions.execution_config_json`、manifest 定义备份以及触发器/调度备份。外部 manifest 和 `createVersion.executionConfig` 不能覆盖代码定义。新建工作流会先生成 `worker.ts`，再编译发布，而非只在数据库中创建定义。

调度器按当前激活版本的代码读取触发器，任务入队、并发领取、重试和事件取消按 Run 绑定版本的代码读取策略。源码丢失或已发布入口的摘要不匹配时，运行配置读取报错，不使用数据库备份继续执行。工作流基本信息页只读展示代码中的触发器和执行策略。

Cron 使用 `triggers: [{ type: 'cron', config: { expression: '@daily', timezone: 'Asia/Shanghai', enabled: true, misfirePolicy: 'skip' } }]`；事件使用 `triggers: [{ type: 'event', config: { eventName: 'created', enabled: true } }]`。`enabled` 默认为 `true`，Cron 的时区默认为 `UTC`，`misfirePolicy` 默认为 `skip`。开关、表达式和策略的修改都必须在源码中完成并重新发布。旧数据库中独立创建的触发器和调度记录不再生效，需在工作流代码中声明并发布；数据库继续保存游标、occurrence 和运行历史等运行状态。

步骤说明来自 `execute` / `run` 请求的 `description` 字段，或步骤调用所在语句前紧邻的 `//`、`/* */`、`/** */` 注释；显式字段优先。等待、发送事件等步骤可使用前置注释。空行会切断注释与步骤的关联，外层步骤的注释不会成为嵌套步骤的说明。没有说明时不按节点类型生成文字。

```ts
export default defineWorkflow({
  id: 'report',
  name: '报告',
  description: '提交报告任务并等待完成。',
  inputSchema: Type.Object({}),
  outputSchema: Type.Object({}),
  async run(ctx, input) {
    await ctx.step.execute('submit', {
      type: 'metric.task.submit',
      description: '提交任务，记录本次提交信息。',
      config: {},
      input,
    });
    // 等待下一次查询。
    await ctx.step.sleep('wait', 1000);
    return {};
  },
});
```

定义通过 TypeScript 语法树静态解析，支持 JSON 字面量、无插值模板字符串、入口文件顶层 `const` 引用及静态对象展开。解析器不会导入或执行工作流，也不会计算函数、读取外部变量或拼接动态模板；这四类配置包含动态表达式时发布失败。步骤的显式 `description` 支持字符串字面量和无插值模板字符串。本地扫描与工作流详情使用相同的配置解析规则。旧数据库描述仍可保留为历史数据，但不用于界面的描述展示。

## 当前验证范围

`pnpm test` 覆盖状态转换、JSON 校验、步骤去重/取消、注册表和步骤调用边界。

现有 `test:e2e` 仍只是 Fastify inject 冒烟，不是浏览器测试；`test:package` 仍是打包清单 dry-run，不是仓库外安装验证；`lint` 当前复用 TypeScript 检查。T01/T10 需继续补齐真实工具链与验收。
