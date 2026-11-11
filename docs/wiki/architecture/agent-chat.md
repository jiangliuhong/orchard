# 公共 Agent 对话

状态：已实施。最后更新：2026-11-08。

工作流场景通过可选的 `session.mode` 配置单次／多轮选择，`session.connectionState` 显示后端实际连接状态。其他场景不展示模式控制。模式切换准备新的逻辑对话，保留输入，不修改旧会话；活动任务期间锁定。工作流流式回复保留完整已接收文本，SSE 按 sequence 去重。

工作流编辑、脚本编辑和浏览器应用编辑统一使用 `src/web/agent-chat/AgentChat.tsx`。页面只传入场景配置、资源标识、业务上下文及回调；不要在页面中另写消息列表、输入区或引用按钮。

## 接入方式

```tsx
<AgentChat
  config={scriptChatConfig}
  resourceKey={`${script.id}:${script.currentDraftVersionId}`}
  context={{ script, dirty, testRefresh, onApplied, onTestInput }}
/>
```

`resourceKey` 必须区分不能共享会话状态的资源，例如脚本及其草稿版本。更换此值会清空输入、引用、错误及对话状态，终止旧资源的订阅和轮询。

公共组件负责标题栏、历史抽屉、消息样式、Provider/模型选择、发送、停止、快捷键、引用标签与错误展示。`useAgentChat` 负责发送去重、失败时保留输入和请求标识；成功发送相同内容的新一轮使用新标识。阅读历史时不强制滚到底部。

## 场景适配器

配置中的 `useSession(context, choice, choose)` 返回统一的 `ChatSession`：会话、消息、活动状态、可编辑状态和业务操作。适配器负责场景 API、上下文、后端能力和应用变更；公共组件不根据工作流、脚本或浏览器应用类型写业务分支。

| 场景 | 适配器 | 业务行为 |
| --- | --- | --- |
| 工作流 | `adapters/workflow.tsx` | 原生会话、流式回复及活动轮询兜底；保留历史管理、重建上下文、已有草稿保存行为 |
| 脚本 | `adapters/script.tsx` | 轮询、测试记录引用；普通回复直接展示，变更由用户展开并确认保存 |
| 浏览器应用 | `adapters/browser-application.tsx` | 轮询、应用和工具上下文、可选测试引用；变更交给应用编辑器审阅 |

消息文字由公共组件渲染。领域专属内容通过消息的 `content` 放入公共消息内部，例如脚本差异预览、应用变更审阅入口、工作流文件入口。

脚本历史接口返回 `summary`、`hasChanges` 和 `hasTestInput`，不携带完整源码提案。只有用户展开变更时才请求详情。普通问答不显示变更卡片。现有后端 API 和持久化方式保持兼容，没有数据库表结构调整。

## 接入方自定义引用

`config.attachments` 是可选扩展：

- 不配置时隐藏“+”按钮。
- 配置 `enabled(context)` 时由接入方决定当前是否展示；省略时默认展示。
- `renderPicker` 返回接入方自己的选择器，负责数据查询和添加内容。
- `onAdd({ id, kind, label, payload })` 添加引用，`onClose()` 关闭公共弹层。同一 `kind` 和 `id` 的引用再次添加时替换原值。
- 公共组件统一标签和移除按钮，发送时原样交给适配器。
- `resetKey(context)` 用于使过时的引用失效，例如当前浏览器工具或测试结果改变；隐藏入口、切换会话或切换资源也会清除引用。

脚本选择器将测试 ID 放入 `payload`，适配器转换为现有 `testId` 请求字段；浏览器应用适配器转换为 `testContext`。后端负责归属检查和上下文边界，不能把前端配置当作权限校验。

工作流目前不配置引用扩展，因此不展示“+”。接入新的引用类型只需修改场景配置及相应适配器，不修改公共对话组件。

## 验证

在仓库根目录执行：

```sh
npm run typecheck
node --import tsx --test tests/interface.test.ts tests/script-library.test.ts tests/bridge-agent.test.ts
```

测试覆盖三个场景，以及自定义引用、隐藏添加入口、失败重试、重复发送、资源隔离和普通问答。产品操作见[对话创作与发布](../product/authoring.md)与[脚本库](../product/script-library.md)。
