# 内置知识与共享工作区实施记录

状态：源码资源、manifest、打包、初始化/恢复及持久化适配已编码并测试。尚未连接生产启动/Provider 工具传输或新增设置页面，不能据此宣告统一 Runtime 完成。

## 源码与构建

- `src/agent/knowledge/`：公共 AGENTS.md、三个场景文档、三个 SKILL.md、声明式 `.agents/mcp.json`、manifest，共 9 个资源。
- `src/agent/knowledge-bundle.ts`：模块相对路径定位，不依赖启动 cwd；校验必需文件、profile/契约/策略版本、精确文件清单、UTF-8、逐文件字节/SHA-256、大小/数量预算、路径/符号链接、重复 JSON 键与额外目录。
- 文件数最多 64、单文件最多 1 MiB、资源总计最多 4 MiB；manifest 最多 64 KiB。返回冻结的 metadata 和不可变 UTF-8 字符串，不暴露可变 Buffer。
- `.agents/mcp.json` 只能包含固定只读工具声明，拒绝 token、endpoint、command 等配置。它不是 CLI 自动启用 MCP/Skills 的证据；实际授权和传输由后续 Provider/Gateway 实现。
- `scripts/agent-knowledge.mts` 提供显式生成、校验和构建复制；predev/pretest/prebuild 会校验，build 将全部资源（含隐藏目录）复制到 dist/agent/knowledge，postbuild integrity 自动记录这些字节。

更新源码知识后显式更新版本和 manifest，不支持用户知识 overrides：

```sh
node --import tsx scripts/agent-knowledge.mts --update --bundle-version <reviewed-version>
node --import tsx scripts/agent-knowledge.mts --check
```

复制脚本只处理清洁构建下的固定 dist 目标，不覆盖已有目标或跟随父目录 symlink。已安装包在无 src/scripts、不同 cwd 下可从模块位置加载。

## 初始化、租约与故障恢复

- `KnowledgeService` 必须持有真实 DirectoryLease；共享知识读写锁按该租约共享，多个 service 实例也不会绕过彼此的活动读者。不同维护会话可持并发读租约，升级 FIFO 等待所有读者。
- 使用固定 `<data>/agent/workspace`，不按 conversation 复制。文件为 0444、目录为 0555；权限位不构成完整 CLI 沙箱，Provider 禁写及全局规则隔离仍需协议验证。
- 激活前必须由宿主确认旧受管 CLI 已停止并撤销工具授权；未知进程状态阻止初始化。DB 还会独立拒绝旧知识上 queued/active/发送不确定的轮次，不能只凭一个不可靠宿主回调热替换。
- 在私有 staging 写入、刷盘、验证，然后在独占锁内切换。macOS 跨父目录 rename 需要临时允许宿主更新目录的 '..'，权限只在 quiesced 独占阶段调整，移动后恢复只读。
- 初次物化与升级使用持久 knowledge_install operation 和固定安装日志。日志的 UUID/hash/hadWorkspace 必须与数据库操作匹配，不能靠自写 manifest 猜测文件归属。
- 准备、staged、旧目录移开、激活及 DB 提交五个边界均有故障测试。未提交切换恢复旧目录后从当前安装包重试；已提交切换只清理本操作的旧副本，不重复提交安装。
- 普通内容/权限篡改从安装包重新物化；同 hash 修复不让旧对话无故过期。新 hash 激活在同一数据库事务中使旧 multi 只读。
- 链接/硬链接、超预算树、未知 workspace、伪造/缺失安装日志属于诊断失败，不以修复名义遍历或删除未知资源。未知 staging、sessions、runtime 均不作为知识清理目标。
- 等待写锁期间取消不会破坏健康缓存；激活失败则拒绝新租约。另一个实例激活新 hash 后，旧实例不能继续把旧缓存显示为当前有效知识。

`AgentKnowledgeInstallationHost` 直接使用获批的 AgentStore 数据库及 knowledge_installation/workspaces/operations，不建知识 JSON sidecar 真相库。staging 日志仅是带 DB 归属的可恢复文件切换意图。旧副本只用于未完成安装恢复，成功后移除，不提供历史知识库或恢复 UI。

## 验证

- 新增 28 项知识测试通过；连同既有 Provider/生命周期/持久化等共 153 passed、2 个 opt-in native 测试 skipped。
- 实际 npm tarball 测试验证 Markdown、manifest 和隐藏 `.agents` 均包含，解包后无源码、改变 cwd 仍可加载正确 hash；测试使用独立临时 package，不修改工作树 dist 或用户安装。
- `npm run typecheck`、`npm run migration:check`、`npm run build` 通过。开发中的 release lock 经原工具刷新，14 个历史迁移 ID/checksum 不变。
- 全量测试已完整运行：840 项中 834 passed、1 failed、5 skipped。唯一失败仍是已在 HEAD 基线复现的工作流脚本选择器 inputSchema 断言，未改动相关 UI。
- 没有调用收费模型、连接生产知识初始化、激活 v11 或重置用户数据；没有 UI 改动/视觉验收。

## 剩余接入

1. 受控平台查询工具与授权/敏感过滤、当前对象查询证明。
2. Provider 实际知识加载和只读 cwd 验证、原生查询传输/宿主反馈/模型切换。
3. 新 Runtime 在 v11/新旧切换后调用 KnowledgeService，提供真实 quiesce 端口；先前的 TS 教学 prompt 暂保留给旧入口，不能同时加载新旧整套规则。
4. 只读设置 API/UI 和存储展示，以及完整全场景切换。当前内部 snapshot/readFile 不是已开放的设置 API，不提供写/清理接口。
