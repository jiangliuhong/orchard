# Git 配置存储：真实浏览器验证

执行时间：2026-11-06T16:24:11.496Z

结果：本报告范围内全部通过。使用真实 Chromium Chromium 141.0.7390.37、生产编译服务、独立临时 data-dir 和两个独立浏览器 profile。浏览器请求均为同源真实 API 请求，无 fetch mock。Git 远端为临时 loopback sshd 与 bare repository，使用生产 SSH 传输。

- 构建 release digest：e606078926724a7bb9fc6886741090e21e39049ca88e8ffc76abd13c1e0876f0
- Node：v24.19.0
- Git：git version 2.43.0
- 代码基线：ca63ec19414dc4e3b6b8b1f0c4c1e7607b7bc518（含未提交实现）
- 隔离资料及服务日志：`/tmp/orchard-browser-verification-P6npM3`

复现命令（必须先完成生产构建）：

```sh
node tests/fixtures/config-git/browser-verification.mjs --production-build-ready --with-ssh
```

| 验证项 | 实际结果 |
| --- | --- |
| Unbound Git settings render against real production server | 通过 |
| Unsafe local remote rejected through real async connection check | 通过 |
| Dark → system persists identity and increments revision twice across reload | 通过 |
| Explicit claim conflict applies with pre-apply revision/force and does not affect profile B | 通过 |
| Acknowledged preference survives reload without a second apply | 通过 |
| Explicit keep choice retains current dark appearance | 通过 |
| Real SSH connection check and empty repository binding through UI | 通过 |
| UI commit preview requires confirmation; production SSH commit and push writes actual remote SHA | 通过 |
| Local-only UI commit leaves remote unchanged; explicit UI push advances remote | 通过 |
| UI local/remote history selects fixed SHA, restores general theme with recovery point and isolated delivery, without moving Git HEAD | 通过 |
| No JavaScript exceptions, console.error or unexpected failed network requests | 通过 |

实际初次提交/恢复来源 SHA：`a72f2b0a8e9e32812f8bba2313ddba52a9db5012`。第二次提交/恢复后保留 HEAD：`c4034b118ed85564d5e6ff8d88a8c3ddf44efc1b`。

恢复 API 操作 ID：`2dbf82b7-c10a-4c81-9842-90cb244983b4`；持久化恢复 ID：`851cab6f-e981-41ca-bcdd-8b1da140244a`。自动应用回执：`{"decision":"apply","revision":6,"force":false}`。观察到 12 次公钥认证。

本次完整运行没有 JS 异常、console.error、HTTP 错误、网络失败、主动取消事件或导航重试。16 张截图均已生成。

首轮调试曾遇到 Chromium 初次导航停滞；脚本会等待实际 DOM 并最多重载一次。若重载取消了尚未完成的资源请求，保留 net::ERR_ABORTED 记录，不将主动取消记为应用异常。最新执行的重试次数与完整请求时间线保存在 evidence。

完整操作 ID、客户端 ID、回执、浏览器异常与网络事件见 [browser-evidence.json](screenshots/browser-evidence.json)。

截图：

- [01-unbound](screenshots/01-unbound.png)
- [02-connection-error](screenshots/02-connection-error.png)
- [03-dark](screenshots/03-dark.png)
- [04-system-reloaded](screenshots/04-system-reloaded.png)
- [05-explicit-claim-conflict](screenshots/05-explicit-claim-conflict.png)
- [06-isolated-browser](screenshots/06-isolated-browser.png)
- [07-claim-applied](screenshots/07-claim-applied.png)
- [08-keep-current](screenshots/08-keep-current.png)
- [09-ssh-connection](screenshots/09-ssh-connection.png)
- [10-ssh-bound](screenshots/10-ssh-bound.png)
- [11-commit-preview](screenshots/11-commit-preview.png)
- [12-commit-pushed](screenshots/12-commit-pushed.png)
- [13-explicit-push](screenshots/13-explicit-push.png)
- [14-local-history](screenshots/14-local-history.png)
- [15-restore-preview](screenshots/15-restore-preview.png)
- [16-sha-restored](screenshots/16-sha-restored.png)

## 验证边界

未连接托管 Git 服务；连接错误用禁止的 file 协议触发真实服务校验，未验证托管 SSH 策略、HTTPS 认证、真实托管远端 clone/fetch/push、受保护分支、分叉、推送中断或跨设备 Git 往返。未安装真实浏览器扩展，未验证 Web Bridge 重握手。这里的浏览器隔离测试使用同一服务上的两个独立 profile，不能替代两台设备的完整恢复。

偏好领取部分通过真实 export/claim/pending/ack API 验证；Git 工作流使用页面操作完成真实连接、绑定、预览、提交推送、本地提交、独立推送、本地/远端历史及固定 SHA 常规类别恢复。临时 host/client keys、known_hosts、SSH 配置和 bare repository 在 finally 删除，精确终止私有 pidfile 中的 sshd PID。未在本脚本进行数据库崩溃恢复、多类别恢复、依赖扩展或本机映射测试。

系统外观在 headless Linux 中以 Chromium 默认系统配置解析；验证的是 system 偏好的选择、revision 与持久化，并未模拟操作系统实时切换。
