# 配置 Git 存储验证记录

日期：2026-11-06。当前结论：编码、自动化检查及本报告所列隔离真实环境验证通过；托管服务、真实扩展等未执行项目明确保留为待验证，不声明设计中全部外部验收完成。

## 构建与数据库基线

- Git 基线：`ca63ec19414dc4e3b6b8b1f0c4c1e7607b7bc518`，本次实现为工作区未提交变更。
- Node `v24.19.0`，Git `2.43.0`，Linux `6.17.0-1018-oracle`，Chromium `141.0.7390.37`。
- 最终发布完整性 digest：`e606078926724a7bb9fc6886741090e21e39049ca88e8ffc76abd13c1e0876f0`。
- 数据库 schema、已审核 SQL、schema approval 和数据库版本均未修改。7 个既有迁移声明身份保留；仅按 `--refresh-unpublished` 刷新新增源码/依赖的完整性封套和生成文件。
- schema approval digest 保持 `b4ab6ac54d809210022ed6e304de944931b2512388dae89933bc8962120d34a4`。

## 自动化检查

| 命令 | 最终结果 |
| --- | --- |
| `npm test` | 369/369 通过；0 失败、0 取消、0 跳过；耗时 162287.062257 ms |
| `npm run typecheck` | 通过 |
| `npm run migration:check` | 通过；7 个锁定声明与 frozen bundle 一致 |
| `npm run build` | 通过；生产前端、服务端及 152 个产物完整性索引生成成功 |
| `git diff --check` | 通过 |

构建报告前端部分 chunk 超过 500 kB 的提示，未导致构建失败。

最终完整测试日志：`/tmp/orchard-config-git-final-acceptance-tests.log`；退出码：`/tmp/orchard-config-git-final-acceptance-tests.exit`；构建日志：`/tmp/orchard-config-git-build.log`。这些临时路径用于本次会话排查，复现以仓库内测试和脚本为准。

覆盖范围：严格静态快照解析、文件摘要与依赖闭包、本机映射及脱敏、不可变版本冲突与本机序号分配、草稿/目标保留、脏仓库、固定 SHA、快进/分叉、请求幂等、活动协调、浏览器偏好回执、API 操作状态、CLI 子进程退出码。新增启动测试证明恢复等待期间不执行业务恢复、Provider 注册和队列启动；恢复完成后 Bridge 读取新文件，恢复失败则不激活服务。

真实 SIGKILL 夹具覆盖六个 Git 提交回执边界及九个配置恢复边界；HTTP 集成测试使用实际服务器与隔离本地 Git 仓库验证绑定、预览、提交推送、历史、恢复点、恢复及浏览器偏好协议。该 HTTP 集成的本地传输测试选项与下述无传输注入的 SSH 验证分开统计。

补充回归验证：显式导出主题可领取；服务实例重建后提交/恢复可重放持久化回执，保持原 SHA/结果并拒绝复用请求 ID 的不同参数；已完成提交重放不会覆盖后来保存的主题。

## 真实环境执行

| 场景 | 实际状态与证据 |
| --- | --- |
| 本地 OpenSSH 生产传输 | 通过；无 testTransport，严格固定主机公钥；空仓库、提交推送、第二 clone、fetch/快进、脏工作区、分叉备份重生成、新版格式阻断、错误密钥、未知主机、hook 拒绝及重试。详见 [ssh-verification.md](./ssh-verification.md) |
| 生产构建与两个 Chromium profile | 11 项检查通过：真实页面连接/绑定、确认预览、SSH 提交推送、本地提交后独立推送、本地/远端历史、固定 SHA 常规类别恢复及恢复点、偏好修订持久化、显式冲突应用/保留和另一浏览器隔离；无 JS 异常及非预期网络失败。含 16 张截图和操作回执，详见 [browser-verification.md](./browser-verification.md) |
| 本地 HTTPS/TLS 生产传输 | 通过；真实 git-http-backend、临时 CA 严格校验、credential helper、成功提交推送/fetch/固定 SHA、错误或缺失凭据、未知 CA、HTTP 403 保留本地提交并同 SHA 重试。详见 [https-verification.md](./https-verification.md) |
| 托管 Git SSH/HTTPS、平台受保护分支 | 未执行：没有提供可写的独立托管测试仓库及相应认证/策略管理条件；未使用项目现有 origin |
| 真实网络中断后的推送两种远端状态 | 未执行网络层断流；进程终止和回执恢复测试不能替代此项 |
| 恢复后的真实执行 | 通过；最新生产构建与隔离 data-dir。恢复本身未执行源码，随后真实 HTTP 显式执行脚本得到 `sum=42`，执行固定脚本引用与自有源码的工作流得到 `doubled=84`；三个独立 Node 子进程与标记一致。详见 [runtime-verification.md](./runtime-verification.md) |
| 真实 Web Bridge 扩展重新握手 | 未执行：隔离浏览器未安装配对扩展；代码路径、缓存重载和配置状态已有自动化覆盖 |
| 两台独立机器的完整 Git 往返 | 未执行；本机第二 clone 和两个 profile 不等同于独立设备 |

## 验证期间的修复与复测

并行开发阶段曾出现源码/依赖锁不完整以及源文件变更使完整性摘要失效，相关测试被停止或标为失败，未计入最终通过结果。冻结最终源码后刷新未发布完整性封套，重新执行完整测试、构建和迁移检查均通过。

真实 SSH 验证发现 push porcelain 拒绝写到 stdout 的分类缺陷；HTTPS 验证补充发现 HTTP 403 被误归类为远端状态未知。修复后真实 HTTPS 流程与 17 个仓库测试通过，403 返回 `PUSH_REJECTED`，本地提交保留、远端不变，恢复权限后推送同一 SHA 成功。服务编排补齐脱敏累计差异、映射/冲突信息、固定 SHA 预览上下文、显式导出常规快照及跨实例确认重放。实现说明见 [implementation.md](./implementation.md)。

最终浏览器干净复测为 11/11 通过、16 张截图；启动和结束均为最终发布 digest。没有 JS 异常、控制台错误、网络失败、取消事件或导航重试。隔离应用、Chrome、sshd 均已停止，临时密钥、配置和 bare 仓库已删除。

浏览器验证保留所有异常和网络事件。测试自身明确导航/重载导致的 `net::ERR_ABORTED` 仅在记录的操作时间窗口内单独归类，原事件不删除；未知失败仍使脚本失败。不能把重载后的成功误称为从未发生导航延迟。
