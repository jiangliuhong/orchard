# Provider 直接删除：可行性评估

状态：用户已决定取消归档，改为直接删除；本文替代 archive-provider-plan.md 的推荐方案。独立适配器、锁/guard 核心与持久存储身份已编码；两个 CLI 的临时会话基本删除流程已实测，生产接入和完整故障验收未完成。未操作已有用户会话或修改数据库结构，最新状态见[实施清单](./implementation-status.md)。

## 1. 结论

**可行，且比归档方案简单。** 保留 Provider 抽象，移除 archive/restore，只提供 deleteSession 与 inspect。平台直接删除对话消息、未应用提案及对应原生上下文，无回收站或应用内恢复入口。已应用业务资产、发布版本、运行记录和共享 workspace 不受影响。

Pi 不再需要构造官方没有提供的归档/恢复语义；Codex 已有官方直接删除协议。其他 P0 问题（宿主反馈、受控查询、只读共享 cwd）仍需解决。

“不恢复”不等于安全擦除或删除全部备份，不承诺磁盘立即释放同等容量。

## 2. 原生实现证据与方案

| Provider | 已确认事实 | Adapter 实现 | 尚待验证 |
|---|---|---|---|
| Codex 0.167.0 | 本机生成协议有 `thread/delete { threadId }`，响应为空对象 | 精确引用调用原生删除，不先归档，不解析或手动修改 Codex 历史文件 | 本机版本的重复删除、空会话、附件冲突、派生子会话范围、状态核对 |
| Pi 1.5.1 | 官方 session-format 明确支持删除原生 JSONL 文件；交互删除是 trash → unlink | 停止目标写入进程后，由 Pi Adapter 对确切受管文件执行删除；不用 trash，不依赖交互 UI，不修改 JSONL 格式 | 专属伴随文件/分支引用、权限失败、路径与进程竞争、重复删除 |

### Codex 注意事项

查阅官方固定提交的 thread_delete.rs：

- 删除调用原生 thread store，并处理派生子会话，不只是一个文件 unlink。
- 存在附件引用检查，可能拒绝删除；不能强制移除业务关联绕过检查。
- 未持久化 ephemeral thread 被拒绝；single 无持久引用时由宿主按 not_applicable 处理。
- 目标不存在可能返回错误，不可假定原生 delete 已经幂等。由 Adapter 在原存储身份下核对精确目标后归一化为 already_absent；连接失败、权限错误不能归一化成功。
- 原生实现尝试停止 thread 不能替代宿主先确认 stopped。派生子会话必须证明属于目标操作，不能误删其他平台对话。

来源：

- 本机 `codex app-server generate-ts` 的 ClientRequest、ThreadDeleteParams/Response、ThreadListParams。
- [官方 thread_delete.rs（固定提交，非本机行为保证）](https://github.com/openai/codex/blob/d9a32c178951695f365faa36a39d542e06a96e4f/codex-rs/app-server/src/request_processors/thread_delete.rs)。

### Pi 注意事项

- 官方明确支持文件删除，因此这不是“移动未知文件冒充归档”，也不要求新增 CLI RPC 命令。文件布局和文件操作完全留在 Provider 内部。
- 文件必须来自服务端保存的准确引用并属于 Provider 分配范围；检查路径组件、symlink、常规文件和身份。对外部/未知归属文件拒绝删除，不能按 cwd 扫描整个用户 home。
- 确认进程退出后再删，否则 CLI 可能继续写入、重建文件或持有未释放句柄。宿主锁只约束 Orchard 进程，无法宣称控制任意外部 CLI；因此新会话应采用平台私有受管存储。
- 不照搬交互 deleteSessionFile：其优先系统回收站，不符合直接删除产品语义；也不能对 Provider 根目录递归 rm。
- 必须核实附件、fork/parentSession 引用及会话专属副资源；共享资源不能随意级联删除。不存在的确切受管目标才可判 already_absent。

来源：本机安装包 docs/session-format.md、docs/sessions.md，dist/core/session-manager.js，以及 dist/modes/interactive/components/session-selector.js 的 deleteSessionFile。

## 3. Provider 契约

```ts
interface AgentSessionProvider {
  // 其他创建、恢复执行连接、发送、切模型方法不变。
  deleteSession(reference: ProviderSessionReference, operation: OperationContext): Promise<DeleteResult>;
  inspect(reference: ProviderSessionReference): Promise<NativeSessionState>;
  release(handle: SessionHandle): Promise<void>;
}
```

- DeleteResult 区分 deleted / already_absent；未知交付或失败不得包装成功。
- inspect 至少区分 present / absent / unknown；absent 必须是在正确且可访问的原生存储下核对的精确缺失。
- operation 固定 requestId、目标 reference/generation。Runtime 只保存阶段、归一化结果和内部引用，不解析原生 ID/路径。
- nativeResume 继续保留，含义是恢复尚存在会话的执行连接，不是恢复已删除内容。
- 能力门禁已从 nativeArchive/nativeRestore/archiveStateQuery 改为 nativeDelete/deleteStateQuery，保留 nativeResume，总计九项必要能力。新增代码和假协议测试不等于安装版本的真实能力已验收。

## 4. 跨存储一致性：不可省略的复杂度

推荐可恢复流程：

1. 用户永久删除确认；服务端权限、revision、无活动/不确定任务检查。
2. 持久登记 delete operation 与不透明引用；置 deleting，阻断发送、切模型、旧提案应用和反馈投递，撤销工具授权。
3. 确认目标进程停止，调用 Provider 删除；记录 confirmed/unknown/failed。
4. 原生确认删除后，事务删除平台对话内容及无保留义务的关联记录。业务外键先解耦，不能级联删除业务资产。
5. 保留不含正文的最小幂等回执，随后按审核策略清除无需继续核对的原生引用。成功删除内容不再出现在对话列表/API。

原生已删除、平台事务失败时只能向前完成，不能回滚原生上下文；因此 deleting/失败视图和操作进度不可省略。Provider 未安装或不可访问时保留引用等待重试，不能先删平台引用后留下无法定位的原生数据。single 若有临时资源残留，必须明确报告并跟踪释放阶段，不能宣称全部资源已释放。

删除回执是操作幂等记录，不是可恢复的软删除对话。保留内容、周期、外键及唯一约束属于后续 schema review；用户确认产品语义不等于数据库审批。

## 5. 影响面与风险

- **移除**：archiving/archived/restoring 状态、归档列表、archive/restore API、恢复测试和 Pi 归档目录搬移方案。
- **保留/新增**：active/deleting、delete operation、失败重试、最小删除回执；DELETE conversation 与操作进度查询。
- **风险提高**：误操作不可恢复、原生/平台部分成功、删除与提案应用竞争；通过明确确认、同一互斥边界、持久阶段和幂等收敛控制。
- **存储边界**：删除单个对话不等于新增批量磁盘清理功能，不增加定时/LRU 清理或容量驱逐。
- **备份边界**：旧备份可能含已删内容；本功能不重写备份、不 VACUUM/擦盘、不删除用户外部日志。整库备份恢复可能重新带回旧数据，不属于应用内恢复入口。

## 6. 编码前/验收清单

- Codex：独立临时会话直接 delete，不先 archive；重复删除、响应丢失、原生不存在核对、附件冲突、派生范围隔离。
- Pi：受管测试会话删除后文件确实消失；未停止、symlink、越界、权限失败、文件缺失、伴随资源及并发写入负例。
- 跨存储：原生删除后 DB 失败、服务崩溃、回执丢失重试；删除/发送/切模型/应用提案竞争；失败对象保留诊断和引用。
- 范围：共享 workspace、其他对话、业务定义/版本/运行记录均保留；已删除正文 API 不可读，旧提案不能再应用。
- UI：永久删除文案、禁用/待处理/失败/重试状态，无归档恢复入口；实际页面检查待实施。

评估结果：可进入删除适配的编码与临时资源实测，但整体 P0、具体数据库结构和迁移仍未通过验收/审核。评估阶段未运行真实删除或付费模型。

## 7. 后续编码进展

已实现独立 P0 模块，尚未接入旧 ProviderRegistry/业务入口，不开放删除 API：

- `src/agent/provider-contract.ts`：九项 multi 能力门禁，以及 ProviderSessionLifecycle、DeleteResult、NativeSessionState、SessionLifecycleGuard。
- `src/providers/codex-session-lifecycle.ts`：独立控制连接使用统一进程调度，显式绑定 CODEX_HOME、无工具启动和原生 thread/delete；先精确 thread/read，明确缺失后再完整分页核对活动/归档两类目标。实测发现列表可隐藏仍存在的会话，已修复只凭列表误判 absent 的问题。重复游标、错误响应、原生删除后仍存在均不能报告成功；响应丢失不自动补发，下次先核对。
- `src/providers/pi-session-lifecycle.ts`：显式接收平台受管根，不从 cwd 推导；固定版本引用、相对路径、父目录与文件链接检查、有界 UTF-8 v3 header 身份核对、根 inode/device 校验，只 unlink 确切文件，重复删除返回 already_absent。
- 两种适配器的删除均要求宿主注入 SessionLifecycleGuard。后续已实现 BoundSessionLifecycleGuard 核心、对话锁与多读者/写者公平锁；持久化宿主端口仍待数据库审批后接入。Provider 受管根新增持久 storeId marker 并写入不透明引用，跨重启也拒绝新空根/根被替换，不把缺失挂载或未知存储当作删除完成。
- Pi 模块仅供已确认无未知伴随依赖的 v3 单文件会话；完整附件/分支依赖验证、生产引用创建/恢复适配、Codex 派生删除范围与真实安装版本实测仍未完成。因此能力矩阵尚不标 verified。

验证：新增生命周期 12 项测试与原契约 6 项通过；连同现有 Codex/Pi/进程调度/项目 Provider 测试共 85 项通过，`npm run typecheck` 通过。假协议与临时受管文件测试覆盖精确删除、幂等、响应丢失、状态未知、链接/越界、身份不匹配和范围保留。

首轮 `npm test` 被 pretest 的 `Incomplete local dependency lock` 阻塞；后续已通过未发布版本刷新工具解决，并完成全量运行（存在一个在 HEAD 基线可复现的既有 UI 失败）。上述为首轮验证范围；后续真实 CLI 临时会话删除、锁/存储身份补全及最新测试结果见[实施清单](./implementation-status.md)。未执行付费模型调用、数据库变更或 UI 验证，也未删除已有用户会话。
