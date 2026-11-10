# 从远端同步配置：实施与验证

状态：**编码完成，自动化验证通过**（2026-11-10）。实际页面视觉验证仍未完成，不宣称已通过全部人工验收。产品范围见 [design.md](./design.md)。

## 已交付能力

### 同步与恢复

- “配置同步”提供“备份到远端 / 从远端同步”两条独立流程，切换不自动提交、应用或生成预览。
- `POST /api/config-git/remote-sync-source` 在同一仓库排他操作中 fetch、固定绑定分支 SHA、读取提交信息及快照类别；不移动本地 HEAD，不丢弃未推送提交。
- 用户选择类别、补齐本机映射、查看全部分页差异后确认应用；重新获取、映射/范围/偏好/绑定/本机配置变化使旧预览失效。
- 同步结果展示来源 SHA、变更统计、重连提示和同步前恢复点；恢复点仍使用非破坏性的预览/确认协议。
- 已受理操作支持刷新恢复。HTTP 回执丢失时，也会持久化原请求身份并重发同一 requestId/参数找回原操作，不创建新的应用请求。

### Git v2 与字典

- 实际导出使用六类别 v2，新增 dictionaries；加密值导出原密文，不导出密钥材料，不重新加密。
- v1 独立读取和旧版本摘要保持兼容；v1 不允许新字典字段，旧快照没有字典时保留本机字典。备份预览明确显示 v1 → v2 升级提示。
- 按稳定 ID 和 versionId 匹配。保留本机独有对象与历史；同 ID 字典以源当前版本的完整键集更新。同名不同 ID、类型不符、不可变版本内容不同均阻止应用。
- 工作流及固定脚本版本携带字典依赖索引。当前定义严格校验依赖，历史定义保留时不因当前已移除键而阻断独立类别恢复。
- 加密字典预览及应用均认证密文，缺密钥或认证失败时阻止相关范围，不开放“仅导入密文”；应用事务前后复查密钥指纹。
- 实际计划差异体现保留项及依赖补入；加密差异仅展示元数据、键名和新增/替换/移除状态，不返回值或密文。
- 恢复点、配置指纹、幂等回执及数据库提交后的文件补齐复用现有协议，覆盖进程中断恢复。

### 定义、创作和执行

- 普通字典 Binding 支持嵌套 object/array 和 JSON Pointer；固定版本上下文返回普通 JSON 副本，无按名称回退或隐式读取最新值。
- 内嵌 Node/Shell 和脚本库支持 dictionaryBindings：32 别名、合计 256 键，严格校验类型、ID、重复键、通配符及未知字段。
- 字典声明进入草稿、产物、不可变版本、复制/恢复、Agent 提案、元数据差异与编辑器保存；无声明的旧脚本继续省略字段。
- 真实引用扫描覆盖工作流/脚本当前及历史版本、草稿和固定脚本间接引用；按对象去重，损坏定义报告扫描不完整。删除键确认绑定实际引用摘要。
- 发布和草稿诊断校验缺失、禁用、类型、键、Pointer、固定脚本身份及敏感后继；Agent 创作仅接收名称/ID/类型/键等安全元数据，不接收字典值、密文或密钥。
- 四种入队入口（发布工作流、草稿工作流、草稿脚本测试、发布脚本测试）固定字典版本。文件在事务外准备；同步入队保护内完成依赖认证、绑定、回执及最终密钥指纹复查，再登记活动。
- 已排队任务不因字典编辑/禁用/恢复而换值；重试先重放原回执，不重新检查当前依赖，不重复建任务。
- Node.js 通过第二参数 ctx.dictionaries.get / ctx.secrets.get 读取；Shell 使用私有上下文文件和宿主 helper，仅注入该节点声明的键。所有执行路径统一环境白名单，不继承宿主凭据，禁用 core dump。
- 加密依赖节点及其全部可达后继视为敏感范围，禁止 Agent/Web Bridge；真实数据仍用于内存计算和 Schema 校验，在 SQLite、产物、SSE、API 和异常边界前统一保护。
- 敏感输入/输出/日志以显式标记展示，禁止原文复制、下载或输入复用；最终结果引用敏感节点时整体隐藏。临时文件成功/失败/超时/取消后清理，启动前仅清理专用尝试命名空间。
- 完整链路接入后移除阶段一临时 FEATURE_NOT_READY 门禁；缺少固定上下文或绑定仍严格拒绝。

## 关键实现与测试入口

- 依赖协议：`src/domain/dictionaries.ts`、`src/domain/validation.ts`。
- 引用、静态校验与运行绑定：`src/dictionaries/references.ts`、`validation.ts`、`execution.ts`。
- 上下文与安全执行：`src/runtime/dictionary-context.ts`、`script.ts`、`script-tests.ts`、`runner.ts`、`src/persistence/store.ts`。
- Git v2 与恢复：`src/config-git/dictionaries.ts`、`snapshot*.ts`、`restore*.ts`、`repository.ts`、`service.ts`、`routes.ts`、`cli.ts`。
- 页面：`RemoteConfigSync.tsx`、`DictionaryEditors.tsx`，及现有配置同步、脚本、工作流、运行/测试页面。
- 专项：`dictionary-dependencies.test.ts`、`dictionary-execution.test.ts`、`dictionaries-references.test.ts`、`config-git-dictionaries.test.ts`、`config-git-security.test.ts`、`remote-config-execution.test.ts`、`config-git-ui.test.ts`。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `git diff --check` | 通过 |
| `npm run migration:check` | 12 项已锁定迁移声明与生成 bundle 检查通过 |
| `TMPDIR="$(realpath "$TMPDIR")" npm test` | **621/621 通过，0 失败、0 跳过** |
| `npm run build` | 通过，218 个构建文件完成完整性封装；Vite 有大 chunk 提示，无构建错误 |
| 真实 Git 双实例往返执行 | 通过，见 `remote-config-execution.test.ts` |
| 实际页面视觉检查 | **未完成**，见下述限制 |

跨实例专项使用真实本地 bare Git 仓库和两个隔离 data-dir，通过独立密钥导出/导入恢复普通/加密字典、工作流及固定脚本并实际执行；覆盖旧排队修订、新配置恢复，以及数据库、磁盘、实际 HTTP SSE 响应不泄露用于验收的敏感值。此项不等同于两台物理电脑或 GitHub/GitLab 托管认证实测。

macOS 的默认临时目录经过 `/var` 符号链接，而仓库/密钥保护拒绝符号链接祖先。测试使用同一临时目录的真实路径，不放宽产品安全检查。UI 测试为 JSDOM 补齐视觉时钟环境，修复了此前 Toast 因缺少 requestAnimationFrame 导致的测试组件卸载。

专项审查复现并修复了三项边界：恢复时遗漏敏感后继校验；历史失效依赖阻断恢复点；prepared 后外部换钥未在事务内复查。新增七项安全回归覆盖这些窗口。完整测试最后发现的旧运行 DTO 兼容性已修复：无字典的历史运行保持原字段形状。

## 数据库与发布完整性

- 本功能无新增/修改 DDL、约束、触发器、数据库版本或迁移身份，复用已经审核并实施的 v9 四张字典相关表。
- 开工前迁移 manifest 与 frozen.ts 已有本地修改。刷新前备份到 `/private/tmp/orchard-pre-sync-release.faUsHe/`，按 `node scripts/lock-migration-release.mjs --refresh-unpublished` 更新未发布业务文件封装。
- 自动比较确认全部迁移 entries、review 和 schemaApproval 与备份完全一致；历史审核资源没有改写，现有业务改动纳入当前校验封装。
- 最终 release digest：`0395a01ff68689bf67f788af69ce889981f9ef210a9fab3bb42eece8d53c8fa7`。

## 仍需人工验收的事项

- 真实页面的浅色/深色/跟随系统、长差异、窄屏及键盘焦点视觉检查未完成。曾启动隔离测试实例及可丢弃 fixture 页面，但浏览器自动化检测到用户切换 Chrome 窗口后停止，未取得 Orchard 的有效截图；没有操作用户现有实例。
- 临时检查页面/配置及测试服务均已清理/停止；隔离诊断数据仅留在 `/private/tmp/`。
- 两台物理电脑、真实托管 SSH/HTTPS 凭据、真实 Provider 登录和浏览器扩展重新接入需在目标部署环境复验；这不影响已完成的本地 Git/独立密钥/执行自动化闭环。

本功能不提供破坏性镜像覆盖、自动执行、后台定时同步或敏感数据解密公开开关。
