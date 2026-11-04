# Spec Delta

## Purpose

为工作流创作和流程内 Agent 节点提供一致且可扩展的本地 Agent 能力，明确启用、就绪、模型选择和会话隔离规则，使未来接入其他 Provider 不改变工作流的基本使用方式。

## ADDED Requirements

### Requirement: Provider 可扩展并声明实际能力
系统 SHALL 首先提供 Codex CLI 和 Pi CLI 接入，并允许通过新增 Provider 实现扩展。每个 Provider SHALL 声明模型目录、结构化输出、工具调用、原生会话恢复和事件流等实际能力；不支持的能力 MUST NOT 被伪装为可用。

#### Scenario: 注册额外 Provider
- **WHEN** 后续接入一个符合 Provider 契约的新后端
- **THEN** 它出现在统一设置和选择界面，不需要修改流程定义中的 Provider 标识规则

#### Scenario: 后端只有最终结果
- **WHEN** Provider 不提供中间文本或工具事件
- **THEN** 界面展示运行状态和最终结果，不生成虚构的中间事件

### Requirement: 启用与就绪状态独立管理
用户 SHALL 在设置中启停 Provider、配置本地连接、检测状态和刷新模型。系统 SHALL 分别展示启用状态、检测结果、模型来源及失败原因；失败 MUST NOT 被返回为成功或伪造输出。

#### Scenario: 已启用但未就绪
- **WHEN** Provider 已启用但可执行文件或登录状态不可用
- **THEN** 页面显示不可用原因，新的调用在启动前被拒绝

#### Scenario: 禁用正在使用的 Provider
- **WHEN** 用户禁用 Provider 时已有调用正在运行
- **THEN** 已启动调用沿用其配置快照直至完成或取消，后续调用被拒绝，历史记录仍可查看

### Requirement: 创作与节点均能选择 Provider 和模型
创作对话 SHALL 支持逐轮选择启用且就绪的 Provider 及明确模型。工作流 SHALL 支持默认 Provider 与模型、Agent 节点逐项覆盖，并在发布时解析和保存有效选择。无可解析的模型时 MUST 提示配置模型，不能隐式选择另一个模型。

#### Scenario: 各节点使用不同后端
- **WHEN** 创作使用 Codex，某分析节点覆盖为 Pi 及其模型
- **THEN** 创作与运行分别使用各自选择，节点结果记录实际后端和模型信息

#### Scenario: 默认配置后来变化
- **WHEN** 已发布版本运行前用户修改设置中的默认模型
- **THEN** 运行仍使用版本内已解析的模型；原选择不可用时明确失败而非自动替换

### Requirement: 应用会话持久化且运行上下文隔离
系统 SHALL 保留创作历史、轮次状态与 Provider 使用信息，刷新后可以继续。不同工作流运行的 Agent 上下文 SHALL 隔离；Provider 的原生恢复能力缺失时 SHALL 通过已保存消息重建上下文，不声称恢复了原生会话。

#### Scenario: 无原生恢复能力
- **WHEN** 用户重新打开已有创作对话并发送新消息
- **THEN** 系统使用已保存历史继续，并准确报告采用的上下文方式

#### Scenario: 同一工作流运行两次
- **WHEN** 用户以不同输入创建两次运行
- **THEN** 后一次 Agent 节点不继承前一次运行的隐式消息上下文
