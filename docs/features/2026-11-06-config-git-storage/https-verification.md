# 隔离环境 HTTPS 真实验证

执行时间：2026-11-06T16:19:57.551Z。

环境：v24.19.0；git version 2.43.0；OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024)。

复现命令：

```sh
node --import tsx tests/fixtures/config-git/https-verification.ts
```

脚本使用 Node HTTPS 服务和真实 git http-backend 提供 TLS smart HTTP，监听 127.0.0.1:46355，GitRepositoryService 连接生产校验允许的 https://127.0.0.1:46355/remote.git 地址，未使用 testTransport。临时 CA 签发带 IP SAN 的服务端证书，Git 通过临时 sslCAInfo 固定该 CA 且明确开启 sslVerify。临时 PATH git 启动器仅为子进程指定独立 GIT_CONFIG_GLOBAL 和 GIT_CONFIG_NOSYSTEM，不修改现有全局配置；临时 credential helper 提供 Basic 凭据，报告不记录密码或私钥。

关键实际命令由脚本执行：openssl req 生成临时 CA/CSR；openssl x509 -req -CA ... -extfile ... 签发证书；git init --bare --initial-branch=main；git config http.receivepack true；服务端逐请求启动 git-http-backend。

- 通过：严格校验证书的 HTTPS 连接检查、空仓库绑定、提交和推送；提交 SHA 为 ebe8243c0df321ea3eafc7214685d98b12166226。
- 通过：第二个 HTTPS 副本绑定并读取固定 SHA，推送新版本；第一副本 fetch 获取远端变化而不移动本地 HEAD。
- 通过：错误凭据和缺失凭据均返回 AUTH_FAILED；凭据仅由临时 helper 提供，URL 不含用户名或密码。
- 通过：服务端禁止 receive-pack 时，推送失败且远端保持不变，本地提交 351c328ff2210da41e77a4890d3255d9343556fd 被保留。复测确认 HTTP 403 错误码为 PUSH_REJECTED，符合推送被拒绝的语义。
- 通过：恢复写权限后普通 push 成功，复用已保留的本地提交。
- 通过：移除临时 CA 信任后 TLS 连接失败；重新固定 CA 后成功。全过程 sslVerify=true，从未使用关闭证书验证的配置。
- 实际观测：28 次已认证 HTTPS 请求，0 次服务端观测到的 TLS 握手错误。

发现与修复复测：首次真实验证发现 HTTP 403 拒绝写权限被误分类为 REMOTE_UNKNOWN。父代理已修复 Git 错误匹配，将 requested URL returned error: 403 分类为 PUSH_REJECTED。本次真实 HTTPS 重跑显式断言 PUSH_REJECTED 并通过，同时再次确认本地提交保留、远端未变和恢复权限后的普通推送重试。本轮仅更新验证脚本和报告，未改动 src。该用例验证真实本地 TLS HTTPS 传输、证书校验和 Basic helper 认证，不代表 GitHub/GitLab 托管凭据策略、托管平台受保护分支、代理环境或浏览器端到端验收。

同轮回归验证：`node --import tsx --test tests/config-git-repository.test.ts` 实际执行通过，17 项测试全部成功，包含 6 个真实子进程 SIGKILL 提交恢复边界。完整发布构建及全套测试由父代理随后统一执行。

清理：finally 关闭隔离 HTTPS 服务、恢复进程 PATH/XDG_CONFIG_HOME，并删除临时 CA、服务端私钥、凭据、Git 配置和所有副本。无现有远端写入，无生产全局配置修改。
