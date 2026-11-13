# 配置 Git 备份与恢复

适用范围：支持配置快照 v2 的 Orchard（兼容读取 v1）。最后更新：2026-11-10。实现及验证见 [远端配置同步](../../features/2026-11-10-remote-config-sync/implementation.md)。

## 前置条件

在运行 Orchard 的主机安装 Git，准备 SSH 或 HTTPS 仓库访问凭据。SSH 必须预先确认主机密钥；HTTPS 使用主机上的凭据管理器。URL 不能携带口令。设置页面不会接收私钥或 token。首次绑定时填写分支、配置子目录和提交身份。

Git 备份包含常规外观、Provider（含 Agent 模型配置）、Web Bridge、工作流、脚本及固定版本依赖、普通／加密字典。加密字典只导出密文，密钥必须通过独立安全渠道迁移；仓库不保存密钥材料。运行记录、对话、认证信息和浏览器在线状态不导出。Provider 可执行文件路径使用本机映射，跨设备恢复时需要提供目标值。Web Bridge 只同步环境 UUID、环境标识、Origin 和启用状态；浏览器资料 ID、扩展 ID 及其本机映射不进入 Git。

## 设置页面操作

进入“设置 → Git 仓库配置”检测连接并创建托管副本；同步操作位于左下角“配置同步”。

- **备份到远端**：填写提交说明、生成提交预览、查看全部差异并确认，然后提交并推送。普通保存不会自动触发 Git。
- **从远端同步**：点击“获取远端配置”，核对分支和固定 SHA；选择类别、预览差异、补齐本机映射并重新预览；加载全部差异后勾选确认，点击“应用到本机”。
- **浏览器环境**：允许在本机尚未连接浏览器时完成同步。同步保留本机已有绑定；新环境显示“本机未绑定浏览器”，在“Web Bridge → 环境”中选择本机资料即可。旧快照中的浏览器 `localRef` 兼容读取，不再要求补填。
- **本地恢复点**：结果页的“查看同步前配置”或“查看恢复点”可进入同样的预览／确认流程；不是删除已导入版本的全量回滚。未完成操作引用的恢复点不能删除。

同步保留本机独有对象；同 ID 字典使用远端完整键集，键的移除也会显示在差异中。同名不同 ID、字典类型冲突、不可变版本内容冲突会阻止相关应用。缺少解密密钥时先前往“设置 → 加密字典密钥”独立导入，不支持只导入不可用密文。

同步不移动本地 HEAD、不丢弃未推送提交，也不提交或推送；分叉本身不会阻止读取远端快照。应用的是获取时展示的 SHA，不会悄悄切换到后来新增的远端提交。首次备份升级为 v2 时有明确提示，旧版程序不能读取新版快照，历史 v1 仍可恢复且不清空本机字典。

补齐密钥、Provider 登录、运行时安装及浏览器接入后，恢复的工作流和脚本无需重新编辑字典依赖即可执行。同步本身不会自动执行任何任务。仅本地提交、完整历史和分叉重生成等高级操作可通过 CLI/API 使用。

预览有效期为 30 分钟。配置、绑定、本地 HEAD 或预览约束改变后，应重新预览。恢复期间会阻止配置写入和新执行活动；仍有活动时立即返回忙碌状态。

## CLI

以下命令默认连接 `http://127.0.0.1:7441`。自定义实例添加 `--server-url` 和 `--data-dir`。服务端命令不会直接打开数据库。

```sh
orchard config-git status --pretty
orchard config-git export --theme system --pretty
orchard config-git commit-preview --message "更新配置" --theme system --push
orchard config-git operation --id <operation-id> --pretty
orchard config-git commit --token <preview-token> --request-id <stable-request-id> --theme system
orchard config-git fetch
orchard config-git history --limit 20
orchard config-git restore-preview --sha <full-sha> --categories general,providers,webBridge,scripts,workflows,dictionaries --mappings-json '{}'
orchard config-git restore --token <preview-token> --request-id <stable-request-id>
```

长操作返回 `operationId` 和 `statusUrl`，查询完成结果后再使用其中的预览 token。网络中断重试时沿用同一个 `request-id`。同一标识不得用于不同参数。

导出首次必须显式提供外观；已有服务端常规快照时 CLI 可以省略 `--theme`。CLI 恢复外观不会直接改变任意浏览器，可在设置页面明确领取快照。

## 手工编辑快照

对独立克隆中的配置目录进行修改，然后更新索引并校验：

```sh
orchard config-git validate --directory /path/to/repository/orchard --refresh-manifest
orchard config-git validate --directory /path/to/repository/orchard
```

配置 TypeScript 仅允许静态声明，不会导入或执行。manifest 保存完整文件集合、摘要、对象版本和依赖索引；刷新只修改 manifest，保留其他文件原始字节。符号链接、路径穿越、不合法编码、超限文件、未声明文件和损坏的依赖会被拒绝。

应用托管副本有外部修改时会停止 Git 操作。不要直接删除操作日志或在恢复过程中修改托管文件。

## 故障处理

- `CONFIG_BUSY`：等待创作、执行、测试或其他配置操作结束后重试。
- `PREVIEW_EXPIRED`：重新生成并审阅预览。
- `LOCAL_MAPPING_REQUIRED`：补齐目标主机的 Provider 可执行文件映射，重新预览。
- `ENVIRONMENT_KEY_CONFLICT`：同一应用内存在相同环境标识的不同环境对象，先核对 UUID 和标识并处理冲突，再重新预览。
- `AUTH_FAILED`：在 Orchard 主机修复凭据或 SSH 主机密钥。
- `PUSH_REJECTED`：检查远端写入策略；本地提交仍在，可以稍后推送。
- `RECOVERY_REQUIRED`：查询操作状态并重试恢复；启动时会先补齐已提交事务的文件阶段，再启动业务服务。不要用旧数据库副本覆盖新事务。

浏览器外观恢复绑定到发起客户端及其偏好版本。如果等待期间用户修改过外观，页面要求选择“应用恢复外观”或“保留当前外观”。其他浏览器不会自动接收该客户端的恢复。
