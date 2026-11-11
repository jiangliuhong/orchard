# Orchard Wiki

这里集中放置项目的通用说明、使用指南、技术规范和验收记录。

## 使用与产品说明

- [页面使用说明](./product/interface.md)
- [对话创作与发布](./product/authoring.md)
- [脚本库、Agent 创作与版本复用](./product/script-library.md)
- [Agent 模型配置与工作流引用](./product/agent-model-configs.md)
- [Git 项目分析与存储空间](./product/git-project-analysis.md)
- [字典与跨设备执行](./product/dictionaries.md)
- [浏览器桥接安装、连接与诊断](./product/web-bridge.md)

## 技术规范

- [流程格式和脚本协议](./architecture/workflow-format.md)
- [Provider 扩展与配置](./architecture/providers.md)
- [API 与事件](./architecture/api.md)
- [公共 Agent 对话与场景接入](./architecture/agent-chat.md)

## 运行与验收

- [npm 自动发布](./operations/npm-release.md)
- [运行状态与数据生命周期](./operations/runtime.md)
- [配置 Git 备份与恢复](./operations/config-git.md)
- [开发验证与后续验收](./operations/verification.md)

## 决策记录

- [仅支持原生协议的设计与数据库迁移方案](../features/2026-11-06-native-only/design.md)

- [草稿运行测试设计](./decisions/draft-testing-design.md)

功能专项设计和实施记录统一放在上级的 [`features`](../features/) 目录。当前 feature：[Agent 对话](../features/2026-11-04-agent-conversations/)；[工作流脚本库](../features/2026-11-06-script-library/)；[版本升级与数据迁移向导（已完成并验收）](../features/2026-11-06-data-migration/design.md)；[配置定义信息 Git 存储（实现与验证记录）](../features/2026-11-06-config-git-storage/design.md)。

- [Agent 模型配置与工作流动态引用](../features/2026-11-07-agent-model-configs/design.md)
- [字典、加密字典与 Git 同步方案（编码完成，执行与同步已接入）](../features/2026-11-09-dictionaries/design.md)

- [Git 项目工作区、Agent 分析与设置存储空间查看（已实现，验证记录见 feature）](../features/2026-11-10-git-project-agent/design.md)

- [统一 Agent 对话、内置知识与原生会话生命周期（实施中，尚未生产切换）](../features/2026-11-11-unified-agent-runtime/README.md)

Wiki 分类规则和新增文档要求见 [`docs/AGENTS.md`](../AGENTS.md)。
