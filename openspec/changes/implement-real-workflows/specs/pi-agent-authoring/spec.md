## Purpose

允许用户在 Orchard 内使用 Pi agent 协作编写工作流代码，同时将模型输出限制在可审查、可校验和可发布的工作流创作边界内。

## ADDED Requirements

### Requirement: Pi agent 必须通过受控创作会话修改工作流
系统 SHALL 为 Pi agent 提供带有工作流上下文、文件范围和结果契约的创作会话；agent 输出必须经过系统校验后才能保存或发布。

#### Scenario: Agent 生成有效工作流
- **WHEN** 已配置的 Pi agent 根据用户请求生成工作流代码且代码通过校验
- **THEN** 系统展示变更摘要并允许用户保存或发布该版本

#### Scenario: Agent 输出无法校验
- **WHEN** Pi agent 生成的代码不符合工作流契约
- **THEN** 系统保留错误信息和修正上下文，但不得发布或伪装为成功

### Requirement: Pi 不可用时必须明确失败
系统 SHALL 检测 Pi 配置、调用和响应错误，并向用户返回明确错误；不得在 Pi 不可用时生成虚假的 agent 结果或运行结果。

#### Scenario: 未配置 Pi
- **WHEN** 用户请求使用 Pi agent 编写工作流但系统没有有效配置
- **THEN** 请求以可识别的配置错误结束，且不创建工作流版本

#### Scenario: Pi 调用超时或失败
- **WHEN** Pi 调用超时、被取消或返回错误
- **THEN** 系统记录失败状态并允许用户重试或改用手工创作
