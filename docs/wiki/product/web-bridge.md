# 浏览器桥接安装、连接与诊断

服务与网页工具使用本机 HTTP 通道。扩展通过资料注册取得临时通道 token，再轮询并投递同源网页请求；服务关闭或恢复配置后重新注册。Native Host 仅帮助扩展发现安装时指定的本机服务地址，不传递 API token、凭据或网页请求。

## 安装和自定义端口

```bash
orchard server --port 7555 --data-dir /path/to/data
orchard web-bridge install --port 7555 --data-dir /path/to/data
orchard web-bridge chrome-ext
```

在 `chrome://extensions` 启用开发者模式，加载最后一条命令输出的扩展目录。包内公钥固定扩展 ID；首次升级到含固定公钥的版本时，Chrome 可能将原先按加载路径分配 ID 的扩展视为新身份，需要重新绑定资料与站点权限。

`install` 为当前系统用户安装 Chrome Native Messaging manifest，并在所选数据目录写入 0700 可执行 launcher。macOS 使用 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts`，Linux 使用 `~/.config/google-chrome/NativeMessagingHosts`。需要连接另一个数据目录时，先用原数据目录卸载，再重新安装；不覆盖其他目录的绑定。

扩展并发尝试默认端口 7441／7443，不要求安装 Native Host，也不等待其响应。Native 发现最多等待 3 秒，超时即断开连接并释放资源，后续自动重连仍可重试。自定义端口通过安装绑定发现。安装不加载扩展、不授予站点访问或登录权限；浏览器目标站点仍须手动授权并登录。

## 环境与本机浏览器绑定

在“Web Bridge → 环境”填写环境标识（例如 `production`、`staging`）和网站 Origin。环境标识在同一应用内唯一，支持 1–100 位字母、数字、点、下划线或短横线，以字母或数字开头；同一 Origin 可以按账号用途配置多个不同标识。原有环境 UUID 保留，已有环境编辑时可补充标识。

浏览器资料可以选择“暂不绑定”，环境仍可保存和通过 [Git 配置同步](../operations/config-git.md)恢复。使用浏览器工具前，再通过下拉框选择本机已连接的资料，无需手填浏览器 ID。HTTP 工具不要求浏览器绑定。

环境标识随定义同步；以“应用 ID + 环境标识”为键的浏览器绑定只保存于当前服务数据目录的 `config/web-bridge-bindings.json`，不导出到 Git。本机旧配置中的资料 ID 会迁移到该文件，后续保存定义时移除原字段。旧环境尚无标识时暂用环境 UUID 匹配；标识改名时也会按 UUID 保留绑定。同步和本地恢复点不会覆盖浏览器绑定。网站 Origin 改变后，须重新选择本机资料。

未绑定环境会显示“本机未绑定浏览器”；已绑定资料会显示连接状态。扩展重装或资料失效后，在环境中重新选择。不会根据 Origin 或在线资料数量自动选择账号。

## 检查与卸载

```bash
orchard web-bridge status --port 7555 --data-dir /path/to/data
orchard web-bridge doctor --port 7555 --data-dir /path/to/data
orchard web-bridge uninstall --data-dir /path/to/data
```

`status` 展示最近 150 秒内注册的在线资料、扩展版本、真实待处理调用数和各环境绑定资料的连接状态。在线仅表示扩展近期注册，不能证明业务页签、网关登录或权限可用。`doctor` 分别检查 Node 版本、扩展文件、浏览器连接和 Native Host 安装情况；服务未启动时 CLI 返回 `SERVER_NOT_RUNNING`。默认端口无需 Native Host，其未安装状态不等于 HTTP 桥接不可用。

卸载仅删除与当前数据目录匹配的 Native Host manifest 和 launcher，保留扩展、浏览器权限及业务数据。不识别的安装或其他数据目录绑定会明确报冲突。

工具参数、调用时凭据、响应处理及风险确认见[执行说明](../../features/2026-11-06-web-browser-bridge/browser-scripts.md)和[调用凭据](../../features/2026-11-06-web-browser-bridge/call-credentials.md)。编码交付与验证限制见[实施状态](../../features/2026-11-06-web-browser-bridge/implementation-status.md)。
