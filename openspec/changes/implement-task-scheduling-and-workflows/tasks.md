# Tasks

## 1. 数据模型与迁移审核

- [x] 1.1 梳理现有 workflow、run、step、queue、event 和 artifact 模型，形成新模型与旧模型的兼容映射清单，并通过代码审查确认不重复定义状态事实来源
- [x] 1.2 设计 Workflow、WorkflowVersion、Run、Step、Attempt、Task、Lease、Schedule、History、Trace 和 Artifact 的字段、唯一约束、索引及状态转换，交付 `docs/workflow-data-model.md` 并完成数据库结构变更审核
- [x] 1.3 在审核通过后新增可回滚的 SQLite migration，验证迁移可在空库和现有库上成功执行，且审核未通过时不执行数据库操作
- [x] 1.4 实现 Repository/Store 的事务边界和状态转换接口，添加并发更新、唯一约束、回滚和旧数据兼容测试

## 2. 工作流定义、版本与 Authoring

- [x] 2.1 扩展 Workflow SDK 定义 Function、Trigger、Step、执行策略和稳定 Step ID，验证顺序、重复步骤和循环步骤产生确定性标识
- [x] 2.2 实现工作流草稿创建、编辑、结构校验和版本发布服务，验证非法触发器、重复步骤及非法策略会被拒绝且不影响激活版本
- [x] 2.3 实现源码入口、依赖边界、能力白名单、编译和可执行 artifact manifest 校验，验证非法依赖和路径逃逸会失败
- [x] 2.4 实现不可变版本激活和运行版本绑定，添加新版本发布期间旧 Run 继续使用原版本的回归测试
- [x] 2.5 更新 authoring/发布文档和 CLI 使用说明，验证文档中的创建、校验和发布命令可以在本地服务执行

## 3. Artifact 导入导出

- [x] 3.1 定义带格式版本、源码清单、产物元数据和 SHA-256 摘要的导入导出包契约，并添加 fixture 兼容性测试
- [x] 3.2 实现安全导出，验证导出包含定义、版本、触发器、策略、源码/产物元数据且不暴露内部绝对路径
- [x] 3.3 实现临时目录解包、路径规范化、符号链接检查、摘要校验和依赖/能力校验，验证 traversal、checksum mismatch 和非法入口均被拒绝
- [x] 3.4 实现导入版本登记与原子激活，验证导入失败时原激活版本不变、已有 Run 不被切换
- [x] 3.5 增加 API、CLI 的导入导出端点和操作状态查询，验证成功响应返回 operation/version 标识且不返回内部文件路径
- [x] 3.6 编写导入导出安全和迁移文档，验证导出的包可以在干净实例中通过校验并重新发布

## 4. Run 与 Step 执行状态机

- [x] 4.1 实现 Run、Step、Attempt 的创建、推进、终态和错误记录，验证所有状态转换具有合法前置状态并可事务回滚
- [x] 4.2 实现 Step 结果和错误 memoization，验证重放已完成步骤不重复执行并能恢复序列化错误
- [x] 4.3 实现 Run Step、并行 Step、Send Event 和 Invoke Workflow，验证并行步骤独立记录且子 Run 保存 parent_run_id
- [x] 4.4 实现 Sleep、SleepUntil 和 Wait For Event 的持久化暂停与恢复，验证暂停不占用 Worker，时间到期或匹配事件后只恢复一次
- [x] 4.5 实现按 Step 和 Run 的重试退避、最大尝试次数和失败终态，验证重试不会重复已成功的前置步骤
- [x] 4.6 实现用户取消、取消事件、超时和 Singleton 替换取消，验证取消会阻止后续 Task 并记录原因
- [x] 4.7 实现从指定 Step 重放的 Run 创建流程，验证重放运行可追踪、复用更早结果且不修改原 Run
- [x] 4.8 为执行状态机补充单元和集成测试，并更新 SDK/运行时文档验证错误、重试、暂停和重放语义

## 5. 调度器与队列策略

- [x] 5.1 实现 Event、Cron、手动和子工作流触发统一创建 Run command，验证所有触发类型使用同一版本绑定和幂等边界
- [x] 5.2 实现事件 ID 与 Cron occurrence 去重、重启补偿和游标恢复，验证重复投递只产生一个 Run
- [x] 5.3 实现 Cron 计算、时区/抖动配置及到期调度，验证服务重启后遗漏 occurrence 按策略补偿且不重复
- [x] 5.4 实现优先级、全局/按 Key 并发、Rate Limit 和 Throttle，验证超限任务按配置等待、进入 backlog 或拒绝而不突破限制
- [x] 5.5 实现 Debounce 和 Singleton skip/cancel 策略，验证分组触发合并以及旧 Run 取消行为
- [x] 5.6 为每项调度策略添加决策 History/操作日志和测试，验证用户可以解释 Run 为何被延迟、合并或拒绝
- [x] 5.7 更新事件与 Cron 调度文档和配置示例，验证示例可创建、启用和观察对应 Run

## 6. Server + Worker 运行时

- [x] 6.1 定义可序列化 Task claim/heartbeat/complete/fail/cancel 协议，验证协议字段包含 task、run、attempt、lease 和错误上下文
- [x] 6.2 实现事务化任务领取、优先级排序和并发额度检查，验证两个 Worker 竞争时只能一个成功领取同一 Task
- [x] 6.3 实现租约心跳、过期扫描、任务接管和 Attempt 保留，验证 Worker 失联后 Task 能被重新调度
- [x] 6.4 实现 lease/version fencing，验证旧租约迟到成功或失败回报不能覆盖接管后的结果
- [x] 6.5 将 API、coordinator、scheduler、queue 和 Worker loop 集成到默认单进程服务，验证单个服务可创建并执行完整工作流
- [x] 6.6 提供独立 Worker 可复用的边界接口和健康/队列/租约状态查询，验证查询包含活动 Worker、队列深度和最近接管信息
- [x] 6.7 增加租约竞争、心跳、崩溃恢复和同进程运行集成测试，并记录独立 Worker 拆分约束

## 7. History、Trace 与查询 API

- [x] 7.1 实现追加式 Run/Step/Attempt History，验证状态转换、重试、暂停、取消和结果事件按序可查询
- [x] 7.2 实现 Trace 投影和 Step 时间线，验证并行步骤、父子 Run、耗时和错误信息可正确展示
- [x] 7.3 实现工作流及版本列表/详情 API，验证返回触发器、执行策略、版本和启停状态
- [x] 7.4 实现 Run 列表、Function Run、Event Run、Run 详情和分页筛选 API，验证按工作流、状态、事件和时间范围查询
- [x] 7.5 实现 History/Trace/输出按需加载和访问控制，验证未请求 output 时不加载完整输出且敏感字段遵循现有安全边界
- [x] 7.6 实现 Cancel、Rerun 和 Rerun From Step API，验证接口返回可追踪 ID 并复用执行状态机
- [x] 7.7 更新 API 契约、错误码和工作流/Run/Trace Web 页面，验证用户可以从工作流列表进入 Run 时间线并执行取消或重放

## 8. 管理入口与端到端验收

- [x] 8.1 完成 CLI 的 workflow create/edit/validate/publish/enable/disable/run/import/export 和 run cancel/rerun 命令，验证命令只调用服务契约而不直接修改数据库
- [x] 8.2 完成 Web 的工作流新建、编辑、发布、导入导出、版本查看、手动运行和 Run 详情操作，验证发布前展示校验结果和 diff
- [x] 8.3 增加完整端到端测试：事件触发、Cron、Step 重试、Sleep、Wait For Event、并行、子 Run、取消、重启恢复、导入导出和同进程 Server+Worker
- [x] 8.4 运行 `pnpm test`、项目类型检查和 OpenSpec 校验，修复全部失败项，并记录数据库迁移审核结果和兼容性说明
