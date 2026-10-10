# Spec Delta

## Purpose

为 Orchard 提供面向服务、CLI 和 Web 的工作流生命周期管理，使用户无需直接修改运行时数据库即可创建、发布、启停和手动运行工作流。

## ADDED Requirements

### Requirement: Users SHALL be able to create and edit workflows
系统 MUST 支持创建工作流草稿、修改定义和查看校验结果，未发布草稿不得被调度执行。

#### Scenario: Create a draft
- **WHEN** 用户提交一个新的工作流定义
- **THEN** 系统保存草稿并返回校验状态，不自动创建运行

### Requirement: Management operations SHALL be available through service interfaces
系统 MUST 通过受保护的 HTTP API 和 CLI 暴露创建、校验、发布、启停、手动运行和查看操作；Web 界面可以调用相同契约。

#### Scenario: Manually run a published workflow
- **WHEN** 用户对启用的已发布工作流提交输入
- **THEN** 系统创建可追踪 Run 并返回 Run ID

### Requirement: Publishing SHALL be atomic
系统 MUST 在定义、依赖和可执行产物校验成功后原子地发布版本，失败时保持原激活版本不变。

#### Scenario: Compilation fails
- **WHEN** 工作流发布所需的校验或编译失败
- **THEN** 系统返回错误且既有激活版本继续可用

### Requirement: Management SHALL enforce security boundaries
系统 MUST 对管理请求执行认证/来源校验，并禁止通过工作流管理接口绕过受控工具、依赖和执行路径校验。

#### Scenario: Unauthorized management request
- **WHEN** 未授权请求尝试发布或启动工作流
- **THEN** 系统拒绝请求且不产生版本、Run 或执行副作用
