# 浏览器桥接当前实施状态

状态：已完成编码；外部业务站点、真实登录和安装扩展联调仍需在目标环境验收。

日期：2026-11-10。

## 当前链路

当前实现以 HTTP 注册／轮询通道执行 browser 工具，不再以最初设计中的 Unix Socket／Native Messaging 作为业务请求通道。localHttp 在服务端执行。Native Host 用于发现本次安装绑定的本机服务地址，使扩展可连接自定义端口；不传输凭据、API token 或工具请求。初始 design.md 的 Socket 架构是规划记录，当前执行方式以本页及 browser-scripts.md 为准。

- 工具管理、应用环境、Agent 提案、调用时凭据、参数表单、风险确认、响应后处理与历史策略均已接入。
- status 从 HTTP 资料注册、实际待处理调用和环境绑定计算连接状态，返回扩展上报的版本；不再查询未提供服务端的旧 Socket。
- doctor 提供 Node、扩展文件、浏览器资料、Native Host 安装的分项结果；不把资料在线当作业务页签可调用。
- install 在 Chrome 的平台用户目录写入受限 manifest，path 指向真实可执行 launcher，参数不依赖 Chrome 不支持的 manifest.args。重复安装幂等，其他 data-dir 绑定冲突，不覆盖；卸载校验归属。
- 扩展 manifest 含固定公钥，扩展 ID 与 allowed_origins 从同一身份计算。Native Host 校验 Chrome 传入的精确来源，仅支持有界、拆包安全的 discover 命令。
- 扩展并发连接默认端口，并通过 Native Host 发现自定义本机端口，拒绝远程或携带认证信息的来源。Native 发现使用可断开的连接，3 秒超时后释放监听与连接，不阻塞默认 HTTP 或后续重试；挂起、断开、排队重试和恢复均有回归覆盖。

使用说明见[浏览器桥接安装、连接与诊断](../../wiki/product/web-bridge.md)。

## 验证

新增 `tests/feature-completion.test.ts` 覆盖真实临时文件安装、平台路径、权限、幂等与冲突卸载、Native 拆包／截断／来源、自定义服务发现和 HTTP 状态／待处理数。`tests/web-bridge.test.ts` 增加扩展发现与远程来源拒绝；已有 browser／localHttp／凭据／历史测试继续回归。

本轮实际检查和结果见[补齐验证记录](../2026-11-04-agent-conversations/completion-verification.md)。本轮不会修改用户的 Chrome 安装、站点授权、业务数据或数据库结构。真实扩展首次加载、授权、业务网关登录和上游接口响应仍需目标环境联调，不能用模拟扩展测试替代。
