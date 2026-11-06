# 运行状态与数据生命周期

正式运行绑定不可变发布版本；草稿测试绑定不可变草稿快照，不创建发布版本。两者先验证输入并创建该次执行的全部节点记录。首版一个 Run 活动，其余排队；每个 Run 沿唯一选中路径串行执行。

正式运行默认使用 `~/.orchard`；执行 `pnpm dev` 时使用仓库目录下的 `.orchard`。两者都可以通过 `--data-dir` 显式覆盖。

运行状态：queued → running → succeeded / failed；活动取消经过 cancel_requested → cancelled。排队取消直接 cancelled。异常退出后遗留活动状态在下次启动时标记 interrupted，排队记录保留。成功和取消竞争按先提交者确定结果，取消获胜后不接受迟到成功。

节点状态：pending、running、succeeded、failed、cancelled、skipped、interrupted。未选中分支在流程终结时标记 skipped / branch_not_selected；上游失败使用 upstream_failed；取消或中断使用 run_terminated。共享后继不在初次选路时提前跳过。

Switch 记录匹配值、选中连线和理由。Agent 输出必须满足声明的 Schema，非法结果不会传给下游。超时属于失败，和用户取消区分。每个执行节点有 attempt，记录输入输出、配置、实际模型或进程元数据与时间。

默认不自动重试，也不从中断节点续跑。再次运行产生新 Run，外部副作用可能重复。进程控制会先 SIGTERM，随后 SIGKILL，服务等待清理后再结束取消；不能撤销已经发生的文件、网络或其他业务操作。

## 数据

新数据目录包含 `workbench.db`、`workbench.lock`、`artifacts/trees`、`artifacts/blobs` 和每次运行的 `runs/` 工作目录。结构有十二张表；初始结构批准于 OpenSpec 设计 D10，草稿测试字段变更批准于 2026-11-04 并记录在 `docs/wiki/decisions/draft-testing-design.md`。数据库只接受新工作台 application_id 与 schema version 2，自动在事务中升级 v1 并保留运行、节点、事件、产物和请求回执；不迁移旧 Orchard 库。

流程文件和编译产物以完整摘要固化；节点启动前验证。较大 JSON 结果写入摘要产物，API 返回引用，完整结果由产物端点显式读取。结果超过 16 MiB、进程输出超过 8 MiB 会失败。日志分块保存，事件按 stream 分配单调 sequence，事务提交后才通知订阅者。

版本、节点与请求去重均有唯一约束；版本禁止更新。历史不自动删除。用户显式删除工作流时，以事务清理其版本、草稿、对话、运行、节点执行、事件和相关请求回执；存在活动任务时拒绝删除。删除单个未发布草稿不影响发布版本和其他草稿。固化的摘要树、结果产物和运行工作目录不在此操作中回收，避免误删共享文件。仅 staging 可在启动时安全清除；无引用文件保留，后续可按明确引用扫描做回收。

需要备份时停止服务并完整复制新数据目录；恢复时使用同一版本应用和匹配的数据快照，保留产物与数据库的一致性。未来变更表结构须另行审核并先备份，不能只修改 user_version 回滚。
