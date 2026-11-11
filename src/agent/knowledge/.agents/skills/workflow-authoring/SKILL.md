---
name: workflow-authoring
description: Maintain the fixed Orchard workflow draft using authorized read-only asset queries and revision-bound proposals.
---

遵守工作区 AGENTS.md 与 docs/workflow.md。先查询 current.get，不从原生历史推断最新草稿。跨资源查询只读，不改变提案目标。返回宿主 Schema 要求的完整文件提案和查询基线；不得执行、发布、写工作区或重建历史。
