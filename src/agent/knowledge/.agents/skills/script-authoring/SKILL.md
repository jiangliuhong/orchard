---
name: script-authoring
description: Maintain the fixed Orchard script draft with native-session context, current source queries and complete revision-bound proposals.
---

遵守工作区 AGENTS.md 与 docs/script.md。先查询 current.get，再按实际 runtime、文件树和 Schema 生成完整修改。只读取用户选中的当前对象测试，不运行脚本/测试、不安装依赖、不读取凭据、不修改其他脚本或工作流。
