# 功能编码补齐验证

日期：2026-11-10。范围：Agent 对话与浏览器桥接的编码缺口，以及字典功能状态文档校正。当前工作区原有脚本 Schema 编辑与测试面板改动保留，纳入回归。

## 已补齐

- 工作流对话支持单次／多轮选择，切换准备新对话，保留未发送输入；活动任务与未保存草稿锁定模式。
- 对话连接状态从活动轮次及生产 Provider 的实际句柄／代次派生，包含空闲回收与停止状态。
- 单次调用记录 sending／accepted／settled，使用独立临时工作区，释放句柄并清理目录；不保存可复用后端引用。
- 会话懒创建、上下文、轮次和幂等回执统一受理事务。上下文失败不留下新会话；延迟到达的并发回执重放不会在原轮次结束后再次调用模型。
- 流式文本按 50 ms／4 KiB 批量落库；超大单条增量按 UTF-8 边界拆分，使 SSE 文本保持 inline。保留 offset／itemId，非文本与终态前刷新；定时落库失败按失败终止。
- 成功终态携带 conversationId／appliedRevision，失败和取消补齐会话身份。前端保留完整当前轮文本、按序列去重，查看或切换历史不清空该轮已收到的文本。
- 桥接 status／doctor 读取 HTTP 注册、真实待处理调用、扩展版本及环境资料状态。Native Host 安装到 Chrome 的平台用户目录，使用真实可执行 launcher、固定扩展身份与归属校验。
- 扩展使用 Native Host 发现安装指定的自定义本机端口，同时保留默认端口直接 HTTP 连接；Native 通道不传输凭据或 API token。
- 字典设计、入口及实施记录已同步到引用／执行／敏感策略／Git v2 的实际交付状态，历史阶段待办明确标注。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run migration:check` | 12 条锁定迁移声明与生成 bundle 一致 |
| `npm run build` | 通过；250 个构建产物完整性封装，大 chunk 提示仍存在 |
| `TMPDIR=/private/tmp npm test` | 728 项：725 通过、3 跳过、0 失败（含 review 修复） |
| `git diff --check` | 通过 |

新增 `tests/feature-completion.test.ts`，并扩展 `tests/interface.test.ts`、`tests/web-bridge.test.ts`。覆盖实际安装文件与权限、冲突／幂等卸载、Native 拆包／来源／截断、HTTP 状态与待处理数、自定义端口、落库定时／阈值／大 UTF-8 增量、取消与失败、单次／多轮受理状态、原子回滚、并发重放、模式输入保留、长文本去重和历史切换。

一次并行定向运行中 Pi 握手用例超时；随后 Pi 专项与完整回归通过，未修改超时阈值或跳过该用例。默认跳过的三项仍为真实 Pi／Codex 模型与真实 SSH 集成，本轮没有启用付费模型请求。

## 真实页面与进程检查

使用生产构建、隔离 data-dir 和独立 Chrome headless profile，不接管用户现有浏览器。Fixture 使用确定性 Provider；Bootstrap 状态由该隔离页面夹具返回 ready，不将本项计为迁移向导验收。

- 实际生成并执行 Native Host launcher，通过包含空格、单引号与 shell 字面字符的路径，正确返回安装指定的随机本机端口。
- 1440×1000 浅色／深色／跟随系统、390×844 深色：模式控件可见，视口无横向溢出。
- 跟随系统在不刷新页面时响应深色 → 浅色变化。
- 使用 Chrome 键盘事件选择单次模式，真实 HTTP 创建对话并完成确定性 Provider 调用；服务端确认 mode 为 single。
- 无未捕获浏览器异常；临时服务、Chrome、数据目录、Native Host 安装与测试身份均在检查后清理。截图、检查脚本与 JSON 证据仅保存在 `/private/tmp/orchard-completion-*`，不包含用户业务数据。

## 数据与发布

没有修改数据库表、字段、索引、约束、SQL、迁移身份或历史审核资源。与 HEAD 比较，manifest 中除 contentDigest／fileChecksums／bundleChecksum 之外的所有字段保持一致。

按现有 `lock-migration-release.mjs --refresh-unpublished` 刷新当前未发布业务源码锁和 frozen bundle，review 修复后的交付 release digest 为 `fa856cf7d74deb60aa3a5122730432c39fe6367127c48cba4d79fc8b39742c38`。

## Review 问题修复

- 字段重命名迁移 ID 映射，删除清理映射；新增“重命名 → 复用旧名称 → 删除 → 再添加”回归，验证 DOM 身份、显示值和最终 Schema 一致，无重复 React key。
- Native 发现使用可断开的 connectNative 连接，3 秒超时释放监听与连接；默认端口并发连接，不依赖发现成功。新增挂起、排队重试、恢复和断开回归，确认不会阻塞自动重连或遗留计时器。
- 参数表单按字典绑定字段数调整根级 minProperties／maxProperties 校验；绑定已超过上限时直接拒绝。仍校验手动必填、字段类型、约束及额外属性；服务端对解析后的完整输入执行原 Schema 校验。
- 定向 22 项回归、类型检查、构建及全量 728 项验证通过。隔离 Chrome 实际完成字段增删改和保存，并在只有字典引用、minProperties=1／maxProperties=1 的脚本上成功运行；覆盖浅色／深色及 390px 窄屏，未发现浏览器异常或横向溢出。

## 仍需目标环境验收

Chrome 真实扩展首次加载、站点授权与业务网关登录，Pi／Codex 创作的真实三轮／取消／重启，以及跨物理设备／托管 Git 的完整往返仍按原专项记录保留。编码完成与确定性回归不能替代这些外部环境验收。

扩展新增固定公钥后，原来按加载路径分配的 ID 可能变化；升级时需重新加载扩展，并按页面重新绑定资料和站点权限。安装和使用步骤见[浏览器桥接说明](../../wiki/product/web-bridge.md)。
