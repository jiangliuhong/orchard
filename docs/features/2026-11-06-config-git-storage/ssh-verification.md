# 隔离环境的生产 SSH 链路验证

执行时间：2026-11-06T16:01:13.376Z。环境：Node v24.19.0、Git 2.43.0、Linux 6.17.0-1018-oracle。

复现命令：`node --import tsx tests/fixtures/config-git/ssh-verification.ts`。

脚本创建临时 Ed25519 服务端和客户端密钥，把已知服务端公钥固定到临时 known_hosts，并通过 `sudo -n /usr/sbin/sshd -D -e -f <temporary-config>` 在回环端口 38379 启动独立服务。临时 PATH 包装器调用 `/usr/bin/ssh -F <temporary-client-config> "$@"`。GitRepositoryService 使用正式校验过的 `ssh://ubuntu@127.0.0.1:38379/<temporary-bare-repository>`，没有注入 testTransport。没有修改已有远端和生产 SSH 配置。

| 结果 | 验证项及证据 |
| --- | --- |
| 通过 | SSH 连接、空仓库绑定、首次提交并推送；SHA `e75692bfd625ce480b077d788e46530e8f51a1fa` |
| 通过 | 第二个 SSH clone 读取固定 SHA；fetch 观察远端前进但不移动本地 HEAD；提交预览快进后普通推送成功 |
| 通过 | 脏工作区阻止提交并保留外部内容 |
| 通过 | 双设备分叉拒绝推送；显式重生成保留 `refs/orchard/backups/e48519dd-fc3d-41e4-81c8-1b7841452142`，推送 SHA `ad197892ededb87e9b5f5adc17716bea8fcfc5b0` |
| 通过 | 自建 SSH 服务 pre-receive hook 拒绝推送；本地 SHA `c647ab10fdfb28d659e6b2f79d02b3f24f25f6d4` 保留，取消拒绝后重试普通推送成功。这只验证服务端拒绝，不代表托管平台受保护分支 |
| 通过 | 错误客户端密钥及未知主机密钥返回 `AUTH_FAILED`；没有自动接受主机密钥 |
| 通过 | 新版未知快照格式标记为不支持，不能覆盖 |
| 通过 | sshd 日志记录 50 次公钥认证 |

首次拒绝测试发现 `git push --porcelain` 把拒绝信息写入 stdout，原先仅检查 stderr 导致错误归类为 `REMOTE_UNKNOWN`。修复后检查两个有界输出流，且不返回原始传输文本；完整复测通过。夹具使用 `UsePAM yes` 完成本机账户检查，同时关闭密码和键盘交互认证；`UsePAM no` 会使本环境锁定密码的 ubuntu 账户在公钥认证前被拒绝。

修复后 17 项仓库测试全部通过，其中包含六个真实 SIGKILL 边界。该时点发现的 service 类型诊断已在后续集成修复，最终类型检查结果见 [verification.md](./verification.md)。

清理：finally 只终止独立 pidfile 指向的 sshd，删除所有夹具仓库和密钥；执行后确认没有遗留夹具 sshd。未记录私钥内容。

限制：本次验证使用真实本地 OpenSSH/Git 传输，不是 GitHub/GitLab 托管服务验证。不能据此确认托管 SSH 策略、HTTPS 认证、托管受保护分支或真实网络中断下的推送状态。进程终止回执恢复由独立仓库测试覆盖；浏览器与 Bridge 另行记录。
