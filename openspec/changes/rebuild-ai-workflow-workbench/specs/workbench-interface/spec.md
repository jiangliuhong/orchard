# Spec Delta

## Purpose

提供面向对话创作、流程查看和节点结果检查的一致工作台，使用户无需阅读编排源码就能理解流程与每次运行，同时清楚管理可用的 Provider 和模型。

## ADDED Requirements

### Requirement: 工作台提供完整使用入口
界面 SHALL 包含工作流列表、创作工作区、运行记录和设置入口，支持创建草稿、打开工作流、发布、输入运行参数及查看历史。无 Provider、无模型、无工作流和加载失败 SHALL 有可区分的提示及相关操作入口。

#### Scenario: 首次使用
- **WHEN** 用户尚未配置任何 Provider
- **THEN** 页面引导进入 Provider 设置，不展示虚假的已就绪状态

### Requirement: 创作工作区联动对话流程与节点详情
桌面工作区 SHALL 提供对话、流程画布和节点详情三个区域，选中节点后展示其配置、代码或 Agent Provider 与模型。画布 SHALL 支持缩放、平移和选择；窄屏 SHALL 能切换各区域。第一版不要求拖拽编排。

#### Scenario: 查看脚本节点
- **WHEN** 用户在流程中选择 Shell 节点
- **THEN** 详情展示关联脚本及输入输出约束，查看操作不执行业务脚本

### Requirement: 运行页展示版本流程和逐节点结果
运行详情 SHALL 展示对应版本流程，并持续更新活动节点、执行路径和终态。节点详情 SHALL 展示输入、输出、日志、耗时、错误和跳过原因；Switch SHALL 展示选中分支及理由。页面 SHALL 提供取消操作并准确区分失败、取消和中断。

#### Scenario: 分支被跳过
- **WHEN** Switch 未选择通往 Shell 的路径
- **THEN** 页面显示 Shell 跳过原因，不能把它显示为成功或持续等待

### Requirement: Provider 设置与选择保持一致
设置页 SHALL 支持启停、连接检测、模型刷新、配置模型及默认选择。创作和 Agent 节点选择器 SHALL 使用同一目录，区分后端不可用、模型目录为空及调用失败；已有工作流中失效的选择 SHALL 保留可见并标注原因。

#### Scenario: 已发布选择失效
- **WHEN** 工作流使用的 Provider 被禁用
- **THEN** 工作流详情仍显示原选择及不可用提示，不悄悄清空或替换为其他 Provider
