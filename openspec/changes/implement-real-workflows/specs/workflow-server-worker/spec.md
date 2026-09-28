## Purpose

定义服务端与执行 Worker 之间可靠的任务协作协议，使工作流执行能够并发处理、故障转移并避免租约失效后的重复认领。

## ADDED Requirements

### Requirement: Worker 必须从受控 Node.js/TypeScript 文件执行
系统 SHALL 仅从 `~/.orchard/` 受控目录加载数据库已登记的 Node.js/TypeScript Worker 文件，并在执行前校验版本、规范化相对路径和 SHA-256 摘要；不得加载任务请求提供的任意路径。

#### Scenario: artifact 校验成功
- **WHEN** Worker 领取任务且对应 artifact 文件存在、版本匹配且摘要校验通过
- **THEN** Worker 加载该 Node.js/TypeScript 文件并开始执行

#### Scenario: artifact 缺失或摘要不匹配
- **WHEN** Worker 找不到登记文件或文件摘要与 SQLite 记录不一致
- **THEN** Worker 拒绝执行、记录可识别错误并使任务进入失败或可恢复状态

### Requirement: Worker 必须通过租约领取任务
系统 SHALL 以可见的租约状态分配待执行任务；Worker 必须能够领取、续租并确认完成或失败。

#### Scenario: 任务被成功领取
- **WHEN** 可用 Worker 领取待执行任务
- **THEN** 系统原子地设置租约和 Worker 标识，并阻止其他 Worker 同时领取该任务

#### Scenario: 租约过期后重新领取
- **WHEN** Worker 在租约期限内未续租或确认任务
- **THEN** 系统将任务恢复为可领取状态并允许其他 Worker 接管

### Requirement: 系统必须限制并发并隔离 Worker 错误
系统 SHALL 按工作流或运行配置限制并发；单个 Worker 的异常不得使其他已领取任务永久丢失。

#### Scenario: 达到并发上限
- **WHEN** 某工作流已达到配置的并发上限
- **THEN** 新任务保持排队状态，直到已有任务释放执行额度

#### Scenario: Worker 异常退出
- **WHEN** Worker 在执行任务时异常退出
- **THEN** 任务在租约过期后可被接管，并保留原尝试的失败或超时记录；重启后的 Worker 依据 SQLite 状态重新加载登记的 Node.js/TypeScript 文件
