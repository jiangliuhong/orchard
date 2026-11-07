# 配置 Git 备份与恢复

适用版本：0.1.0。最后更新：2026-11-06。实现及验收记录见 [配置 Git 存储](../../features/2026-11-06-config-git-storage/design.md)。

## 前置条件

在运行 Orchard 的主机安装 Git，准备 SSH 或 HTTPS 仓库访问凭据。SSH 必须预先确认主机密钥；HTTPS 使用主机上的凭据管理器。URL 不能携带口令。设置页面不会接收私钥或 token。首次绑定时填写分支、配置子目录和提交身份。

Git 备份包含常规外观、Provider 定义、Web Bridge 定义、工作流和脚本及其固定版本依赖。运行记录、对话、认证信息、浏览器在线状态不导出。可执行文件路径和浏览器实例引用使用本机映射，跨设备恢复时需要提供目标值。

## 设置页面操作

进入“设置 → Git 配置”。检测仓库连接，选择或填写分支，创建托管副本。已有配置必须通过完整格式校验，才能恢复或覆盖。

- **仅本地提交**：生成差异预览，查看全部分页并确认；普通保存不会自动提交。
- **提交并推送**：预览前检查远端。推送失败时本地提交仍保留，修复认证或权限后重试推送。
- **获取远端历史**：显式 fetch 后浏览固定提交。远端更新不会自动覆盖业务数据。
- **从提交恢复**：选择完整 SHA、恢复类别、本机映射，重新生成最终预览并确认。目标独有对象保留；同一发布版本 ID 对应不同内容时阻止恢复。
- **分叉重生成**：查看累计差异后明确确认，先备份本地历史，再基于远端生成当前配置快照。
- **本地恢复点**：每次恢复前保存独立配置资料，可再次预览恢复。未完成操作引用的恢复点不能删除。

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
orchard config-git restore-preview --sha <full-sha> --categories general,providers,webBridge,scripts,workflows --mappings-json '{}'
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
- `LOCAL_MAPPING_REQUIRED`：补齐目标主机的本机映射，重新预览。
- `AUTH_FAILED`：在 Orchard 主机修复凭据或 SSH 主机密钥。
- `PUSH_REJECTED`：检查远端写入策略；本地提交仍在，可以稍后推送。
- `RECOVERY_REQUIRED`：查询操作状态并重试恢复；启动时会先补齐已提交事务的文件阶段，再启动业务服务。不要用旧数据库副本覆盖新事务。

浏览器外观恢复绑定到发起客户端及其偏好版本。如果等待期间用户修改过外观，页面要求选择“应用恢复外观”或“保留当前外观”。其他浏览器不会自动接收该客户端的恢复。
