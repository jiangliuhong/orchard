# Proposal

## Why

当前项目以 TypeScript `run()` 函数为工作流本体，通过源码扫描展示步骤，难以让流程定义、条件路由、节点运行结果和页面视图保持一致。用户已确认不要求保留旧功能或兼容旧数据，改为在独立目录建设以显式流程定义为核心的本地 AI 工作流工作台。

切换授权：用户于 2026-11-04 确认验证通过，要求将工作台合并到仓库根目录并提交推送。以下独立目录限制适用于初始建设阶段；验收后的切换以 tasks 第 10 组为准，使用工作台已有数据目录，不迁移旧数据库。

## What Changes

- 在仓库内独立的 `workbench/` 项目建设新应用，独立依赖、启动入口、端口和数据目录；现有应用保留为参考。
- **BREAKING**：新应用采用声明式节点、连线与输入绑定，不支持旧 SDK、工作流包、HTTP API、数据目录和历史记录迁移。
- 建立可注册的 Agent Provider 接口，首期支持本地 Codex CLI 与 Pi CLI；设置管理启用状态、连接配置、模型目录及默认选择。
- 创作对话选择 Provider 与模型；工作流默认配置与各 Agent 节点覆盖配置在发布时解析为明确选择，运行不静默切换后端或模型。
- 支持 Agent 多轮创建和修改流程、受控草稿变更、结构与脚本校验、显式发布不可变版本、多次手动运行。
- 提供 Node.js、Agent、Shell、Switch 节点，首期支持无环、单活动路径的串行与条件分支。
- 将节点输入输出、分支理由、日志、取消、超时和中断记录纳入第一版，运行页展示流程与节点结果。
- UI 使用 React、TypeScript、Vite、shadcn/ui、Tailwind CSS、React Flow，代码编辑按需加载 Monaco。
- 开发阶段完成类型检查、核心逻辑与接口集成测试；真实 CLI、浏览器和业务场景综合验收作为后续独立阶段，不以模拟测试替代。
- 新数据库结构先提交审核，获明确批准后才编写、启用或执行建表与迁移实现；本次只产出规划。

## Capabilities

### New Capabilities

- `workbench-foundation`：独立项目、本地启动、隔离数据、数据库审核边界及分阶段验证。
- `agent-provider-management`：可扩展 Provider、启用与就绪状态、模型选择、会话及能力声明。
- `workflow-graph-definition`：显式流程、脚本文件、输入输出、条件路由和不可变版本。
- `graph-workflow-authoring`：基于 Provider 的多轮创作、受控变更、校验和版本发布。
- `graph-workflow-runtime`：图执行、四类节点、多次运行、节点结果、取消与事件追踪。
- `workbench-interface`：统一 UI、创作工作区、流程画布、运行详情与 Provider 设置。

### Modified Capabilities

无。当前 `openspec/specs/` 未发布能力；新能力仅约束新项目，不改写现有变更及旧应用行为。

## Impact

- 实施目标：`workbench/`，规划保存在本变更；不得顺带重构根目录现有 `src/`、迁移或依赖配置。
- 新依赖按实现时官方文档确认兼容版本并锁定；后端拟采用 Node.js 24+、TypeScript、Fastify，持久化拟采用 SQLite。
- 新建数据库及关系结构见 `design.md` D10；用户于 2026-11-04 明确批准本项目初始结构，旧数据库审批不作为本次依据。
- 旧项目的 Inngest 对齐、调度、工具注册和兼容要求不继承到新项目。

## Non-goals

- 旧功能及数据兼容、删除旧项目、替换现有服务或发布上线。
- 第一版提供拖拽编排、并行汇合、循环、自动失败重试、崩溃后自动续跑、定时调度、远程 Worker、多租户或第三方 Provider SDK。
- 本次规划阶段执行真实场景验收或实现应用代码。
