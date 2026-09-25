# Workflow SDK（开发中）

当前提供定义、注册表和内存步骤调用边界，尚未接入持久化、发布、Worker 或浏览器运行操作，不代表 T02/T05 已完成。

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

`createWorkflowContext` 检查一次 Run 内 stepId 唯一性，并在取消后拒绝后续步骤。当前 ID 支持小写字母、数字和连字符；循环可使用 `item-0` 等稳定标识。

`StepRunner` 校验节点 config/input/output，将 runId、stepId、attemptId、日志函数和 AbortSignal 传给注册节点。取消后返回的迟到结果不会作为成功输出返回，但这不代表外部副作用已经撤销。

当前 StepRunner 是内存调用原语，不负责超时强杀、持久化 Attempt、工具授权、重试、进程隔离或调度。Trigger 契约尚未接入候选触发投递事务；不可据此宣称已实现事件/Cron 调度。

## 当前验证范围

`pnpm test` 覆盖状态转换、JSON 校验、步骤去重/取消、注册表和步骤调用边界。

现有 `test:e2e` 仍只是 Fastify inject 冒烟，不是浏览器测试；`test:package` 仍是打包清单 dry-run，不是仓库外安装验证；`lint` 当前复用 TypeScript 检查。T01/T10 需继续补齐真实工具链与验收。
