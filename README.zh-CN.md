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

## 从其他 Agent 调用

先在「快速执行」创建已发布脚本或网页工具的卡片，再到「设置 → Agent 接入」分别为 MCP 和 CLI 选择允许调用的卡片。两个入口默认开启，卡片需单独授权。修改卡片后需要重新授权。需要逐次确认的网页工具在工作台执行。

在同一台电脑上，把设置页生成的配置复制到 Agent 客户端。客户端通过 stdio 启动 `orchard quick-launch --stdio`，与 CLI 的发现、运行和状态查询共用同一套命令。首次发现工具时，如有必要，CLI 会在原配置端口启动本机 Orchard 服务。网页工具仍使用卡片绑定的运行环境，依赖浏览器的工具需要对应浏览器资料在线。

CLI 可以直接发现、启动和查询已开放的卡片：

```bash
orchard quick-launch list
orchard quick-launch run <卡片 ID> <卡片版本>
orchard quick-launch status <执行 ID>
```

自定义服务端口或数据目录时，为 CLI 指定与设置页一致的 `--port` 和 `--data-dir`。原有 `orchard web-bridge tool` 命令需要唯一匹配一张向 CLI 授权、参数一致的卡片，并返回快速执行回执。
