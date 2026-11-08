# Orchard

[English](README.md) | 简体中文

## 安装与启动

需要 macOS 或 Linux，以及 Node.js 24 或更高版本。

```bash
npm install -g @jarome/orchard
orchard server
```

在浏览器中打开 http://127.0.0.1:7441。

## 项目简介

Orchard 是一个本地 AI 工作流工作台。通过本机 Codex CLI 或 Pi CLI，将想法转化为可复用的工作流，使用不同输入运行，并在浏览器中查看结果。

- 通过 AI 对话和可视化编辑器创建、修改工作流。
- 组合 AI Agent、Node.js 脚本、Shell 命令和条件分支。
- 借助 AI 构建可复用的脚本库，测试脚本，并在工作流中引用已发布的脚本版本。
- 测试工作流草稿，发布固定版本，并使用不同输入重复运行。
- 查看最终结果、节点输入输出、日志和运行历史。
- 管理 AI Provider 和模型配置，将工作流与脚本数据保存在本地。
