# Spec Delta

## Purpose

为 Orchard 提供可校验、可移植且不会破坏现有版本的工作流导入导出能力，覆盖定义、版本、触发器、源码和执行产物元数据。

## ADDED Requirements

### Requirement: Users SHALL be able to export a workflow
系统 MUST 导出工作流定义、版本、触发器、执行策略、源码或受支持的产物元数据、格式版本和完整性摘要。

#### Scenario: Export a published workflow
- **WHEN** 用户导出指定工作流版本
- **THEN** 系统生成包含完整版本信息和校验摘要的可移植包

### Requirement: Imports SHALL be validated before activation
系统 MUST 在导入激活前校验包格式、路径、摘要、版本、依赖、触发器、能力和安全边界。

#### Scenario: Reject a path traversal import
- **WHEN** 导入包包含绝对路径、`..` 路径或符号链接逃逸
- **THEN** 系统拒绝导入且不创建可执行版本

#### Scenario: Reject a checksum mismatch
- **WHEN** 包内文件内容与其声明摘要不一致
- **THEN** 系统拒绝导入并报告具体完整性错误

### Requirement: Import activation SHALL be atomic and versioned
系统 MUST 先将导入内容作为不可变版本验证和登记，激活失败时保持原激活版本可用。

#### Scenario: Import a valid workflow
- **WHEN** 导入包通过全部校验
- **THEN** 系统创建新的不可变版本并可按用户选择激活，已有运行仍绑定原版本

### Requirement: Import and export SHALL be available through service and CLI
系统 MUST 通过受保护的服务 API 和 CLI 提供导入导出操作，并返回操作 ID、版本 ID 或结构化错误。

#### Scenario: Export from the service
- **WHEN** 用户通过服务接口请求导出
- **THEN** 系统返回可下载的导出结果或异步操作状态，不直接暴露内部文件路径
