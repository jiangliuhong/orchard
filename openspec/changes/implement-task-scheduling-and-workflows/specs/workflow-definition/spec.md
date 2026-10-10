# Spec Delta

## Purpose

为 Orchard 提供可版本化、可校验和可发布的工作流定义能力，使工作流能够通过稳定的触发器和步骤描述形成可执行契约。

## ADDED Requirements

### Requirement: Workflow definitions SHALL be versioned and validated
系统 MUST 为每个工作流保存唯一标识、名称、版本、状态、触发器、步骤定义和执行策略，并在发布前校验结构、引用和策略参数。

#### Scenario: Publish a valid workflow
- **WHEN** 用户提交包含有效触发器和步骤的工作流定义
- **THEN** 系统创建不可变版本并将其标记为可执行

#### Scenario: Reject an invalid workflow
- **WHEN** 工作流包含无效触发器、重复步骤标识或不支持的策略
- **THEN** 系统拒绝发布并返回结构化校验错误，且不改变当前激活版本

### Requirement: Workflow steps SHALL have stable identities
系统 MUST 为每个步骤保留稳定的逻辑标识，并 MUST 为同一工作流中的重复步骤生成可区分的实例标识。

#### Scenario: Re-evaluate a workflow
- **WHEN** 同一版本的工作流因重试或恢复再次执行
- **THEN** 相同逻辑步骤解析为相同步骤标识，已完成步骤可以被识别

### Requirement: Workflow versions SHALL be immutable
系统 MUST 将运行绑定到创建时的工作流版本，后续发布新版本不得修改已有运行使用的定义。

#### Scenario: Publish a new version during an active run
- **WHEN** 工作流已有运行时发布新版本
- **THEN** 新运行使用新版本，已有运行继续使用原版本

### Requirement: Workflow management SHALL expose lifecycle operations
系统 MUST 支持创建、编辑、校验、发布、启用、停用和查看工作流及其版本。

#### Scenario: Disable a workflow
- **WHEN** 用户停用一个已发布工作流
- **THEN** 系统阻止新的触发创建运行，但不强制删除或修改已有运行历史
