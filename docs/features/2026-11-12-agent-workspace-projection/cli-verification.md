# CLI 协议核对与非生成验证

状态：协议基线与关键负例已核对；私有 IPC/MCP stdio、Pi 工具适配层及真实 Pi RPC 的无模型组合探测已通过，**生产 launcher、模型工具调度、原生会话和进程树验收仍未完成**。本记录不能作为启用新维护模式的依据。

## 1. 本轮执行范围

真实安装版本：Pi **1.5.2**，Codex **0.167.1**。不是前置方案记录的 1.5.1/0.167.0。

可复现命令（把 package 路径替换为与 pi 可执行文件匹配的安装包根目录）：

```sh
node scripts/probe-workspace-cli.mjs \
  --pi "$(command -v pi)" \
  --pi-package /absolute/path/to/@earendil-works/pi-coding-agent \
  --codex "$(command -v codex)"
```

脚本会：

- 在自己分配的临时目录工作，清空继承凭据/配置环境，使用隔离 HOME、PI_CODING_AGENT_DIR 和 CODEX_HOME；Pi 设置 offline、禁遥测。
- 检查 CLI 版本与 Pi 工具模块安装包版本一致；核对真实 CLI help，生成 Codex experimental TypeScript 协议。
- 启动真实 Pi RPC，只发送 get_state、clear_queue、abort，随后关闭 stdin 并等待进程退出。不发送 prompt/turn/start，不调用模型。
- 直接调用同版本安装包的原生 createReadTool，仅读取脚本自己创建的 workspace 内外测试标记文件。这里不是模型工具调度或 Orchard 授权实现测试。
- 打印 JSON 证据并仅清理脚本自己创建的临时根目录；不访问现有用户 session、凭据或业务数据库。

本轮执行成功。Pi 参数基线：

```text
--mode rpc --offline --no-extensions --no-mcp --no-skills
--no-prompt-templates --no-themes --no-context-files --no-approve
--tools read,grep,find,ls
```

**这组参数用于暴露原生边界缺口，不是生产安全启动参数。**

## 2. 真实结果

| 检查 | 实际结果 | 能证明什么 / 不能证明什么 |
|---|---|---|
| Pi RPC + --no-session | get_state 成功、isStreaming=false、无 sessionFile、临时根无 JSONL 历史 | 能启动非持久空闲进程；不等于已验证完整 single 推理工具链 |
| Pi --session-dir + --session-id | 返回准确指定 ID 和预分配 sessionFile；未执行轮次时目录中实际历史文件数为 0 | 有引用不等于文件已经持久化；尚未测试生成后的恢复 |
| Pi clear_queue / abort（空闲） | ACK 成功 | 不等于运行中 abort 已停机 |
| Pi stdin EOF | 两个进程均正常退出，exit code=0，无 agent_start/message_start | 空闲进程关闭可用；尚未证明带工具子进程/重试/压缩的退出边界 |
| 原生 read：相对 cwd 内文件 | 读取成功 | 常规读取可用 |
| 原生 read：绝对 cwd 外文件 | **读取成功** | cwd 不是读取沙箱 |
| 原生 read：../ 越界文件 | **读取成功** | read allowlist/只读权限不能提供目录隔离 |
| Codex generate-ts --experimental | 成功生成 ThreadStart/Resume、DynamicToolSpec、SandboxPolicy 等类型 | 只有真实二进制协议声明，不是沙箱运行或受控工具调用证据 |

Pi help SHA-256：`47d1839ce42f284c8253ae1cfa5859324e84a21f1cc4c15aae09279aa48aae43`。

Codex 生成类型 SHA-256：

| 文件 | SHA-256 |
|---|---|
| v2/ThreadStartParams.ts | dc8bebec4181a5502fc141b0122cc48e066b3b5c77d9fd2a4de875fcd6d66a68 |
| v2/ThreadResumeParams.ts | 6ea6561448792277f9b52ac9d920d71ef8c9be6e43621ee6329fb948329e8ff7 |
| v2/DynamicToolSpec.ts | bd4b06afea9395a426f8facc9d800f4b201fea44fab667f854710acff4c8f393 |
| v2/SandboxPolicy.ts | f5a4b24c0de4945e77c1573306ae4cb98a29103a6c64ee23264dc9d35a977e85 |

临时路径、session UUID 每次不同，不作为固定契约；版本/声明变化须重新复核，不自动更新 hash 当作通过。

## 3. 官方协议/实现核对

Pi 依据安装包 README、docs/rpc.md、rpc-commands.md、sessions.md、security.md、sdk.md、mcp.md 和工具 read.d.ts：

- --no-extensions 禁止自动发现，但显式 -e 仍可加载；生产仅允许安装包指定的桥接扩展及必要内置 MCP 支持，不允许用户资源发现。
- --tools 的普通读取列表**不自动排除所有 MCP 工具**；明确 mcp__ allowlist 与禁用自动 codemode/tool_search 必须另外落实。MCP 使用 direct exposure，关闭 autoEnableCodemode；动态工具列表变化不能绕过宿主 allowlist。
- MCP 可以由可信扩展 registerMcpServer 注入 stdio command/args/env，无须把 grant 写进共享项目。该配置机制有官方文档，但本轮没有验证与范围受限读取工具同时启用。
- Pi 的 createReadTool 支持 ReadOperations（readFile/access/stream/image 检测等）；只包装其中一个操作不足以证明路径隔离。grep/find/ls 遍历及工具输出临时文件也须检查，不允许搜索工具通过链接读出宿主内容。
- --no-context-files 与显式技能/规则加载应配套使用；信任项目不等于 sandbox。自动发现的祖先规则、项目 sessionDir、系统提示文件和扩展资源都是独立启动面，不能只禁止模型 edit/write。
- agent_settled 才是无自动继续的轮次空闲边界，agent_end 不足；随后关闭 stdin，等待进程与工具子进程退出，再释放 workspace 读取边界。
- 精确恢复必须按已验证的绝对 session 文件，并核对 sessionId/cwd/存储归属；不能使用 --continue、模糊 ID 或“最近会话”。

Codex 依据本机生成的实际协议：

- ThreadStartParams 有 cwd、runtimeWorkspaceRoots、sandbox、ephemeral、dynamicTools；ThreadResumeParams 有准确 threadId，且 history/path 会改变恢复选择语义，因此生产只使用受管准确引用，不传重放 history 或任意 path。
- DynamicToolSpec 支持 function/namespace 声明，不等于已接好 Orchard MCP 或通过调用授权。
- SandboxPolicy.readOnly 只有读写/网络策略声明，没有声明“只能读 runtimeWorkspaceRoots”。不能据此宣称数据库、凭据或 home 不可读取。
- 当前适配器把 shell/unified_exec/MCP 等禁用；若为了文件读取重新开放 shell，必须重新验证，不能只以 readOnly 名称放行。首版 Codex 维护新模式保持不可用。

## 4. 已知现有适配器缺口

| 位置 | 缺口 | 后续要求 |
|---|---|---|
| src/providers/pi-rpc.ts | 默认 --no-tools/--no-mcp；旧路径可从 cwd 推导 session 根 | 新维护模式单独 capability/profile 接线；显式受管原生存储，不改变非维护 single 边界 |
| src/providers/codex-app-server.ts | 现为禁工具策略，项目分析 profile 可能允许 shell | 不复用项目分析策略给维护 workspace；未验证的 Provider 拒绝准入 |
| src/providers/transport/jsonl.ts | env 合并 process.env；close 等主进程 close，单靠它不能证明任意 MCP 子树均退出 | 新 profile 使用受控环境 allowlist、独立工具凭据通道、可验证子进程归属/退出；不得继承所有宿主凭据 |
| 原生 read/search | 绝对路径/../ 越界已证实；仅工具名 allowlist 不够 | 安装包可信范围包装器或经验证的 OS 进程沙箱，覆盖所有 I/O 通路 |

## 5. 生产门禁和后续实测

冻结方向：Pi RPC 优先，MCP stdio 为首个 Orchard 传输；仅包内显式规则/Skills；范围受限文件工具；每个逻辑轮次关闭进程后再应用。Codex 不满足能力时明确禁用，不提供不安全降级。

仍须真实验证（本轮未执行）：

- 安全包装器 + Orchard MCP 同时存在时，允许工具的完整集合、越界/链接/第三方工具拒绝、祖先和用户规则隔离。
- 真实模型读取资产并 submit_proposal，MCP grant 取消/超时/代次变更失效；伪造确认、跨对象应用及泄漏负例。
- 两个 multi 会话的两轮上下文隔离、生成后持久化、进程回收后准确恢复，以及缺失/错误引用拒绝。
- 运行中 clear_queue/abort、自动重试/压缩、MCP 未结束及子进程退出不确定；此时投影必须继续阻断。
- apply_proposal 在活动轮次只 queued，轮次关闭后平台应用；single 确认应用不产生第二次模型调用。

这些属于后续安全实现/端到端验收，不能用本脚本或协议夹具的通过替代。需要模型调用的实测应明确说明使用模型与计费范围后再执行。

## 6. 已实现范围读取操作的真实工具验证

新增 `ScopedWorkspaceReader.nativeReadOperations()` 覆盖 read/access/MIME/stream 的全部 I/O 入口，只返回已验证的不可变项目快照，不读任意宿主文件。

```sh
node --import tsx scripts/probe-workspace-reader.mts \
  --pi-package /absolute/path/to/@earendil-works/pi-coding-agent
```

本机 Pi 1.5.2 实际 createReadTool 实现验证通过：可读取登记文件；绝对外部路径、../、磁盘中存在但未登记文件和释放后的租约均拒绝。脚本不调用模型，不读取现有会话/凭据；其结果**不证明 RPC 已加载该包装器，也不证明 MCP 同时启用、规则发现或进程关闭已完成生产验收**。这两层证据必须分开。

## 7. 私有 IPC 与独立 MCP stdio 的实际验证

实现：`src/agent/maintenance-ipc.ts`、`maintenance-ipc-client.ts`、`maintenance-ipc-wire.ts` 和 `maintenance-mcp-stdio.ts`。这里只增加平台自己的传输和 helper，没有修改 Pi 的 Provider 启动配置，也没有启用新的维护模式。

- 服务仅绑定随机 `127.0.0.1` 端口，不是 HTTP。使用角色独立的随机密钥、双向 HMAC challenge/response、连接内单调序号和一次角色连接；不自动重连。密钥本身不在网络握手中发送。
- bootstrap 只写平台分配的继承管道。独立 MCP helper 从 fd 3 读取，拒绝命令行连接参数；stdin/stdout 仅 MCP，错误只写固定、无凭据的 stderr 文本。不把凭据放进 workspace、配置文件、环境或模型消息。
- reader 仅提供登记快照的 read/ls/find/字面 grep；MCP 仅提供 submit/apply/status。服务端绑定实际 reader 快照 hash、业务观察器/目录租约、任务/代次和实时全项目授权，前后复核；没有 SQL、shell、确认、发布、执行或宿主路径工具。
- 帧/并发/连接/时间预算均有限；unauthenticated 与 reader 帧 4 KiB、MCP 帧 9 MiB、响应 512 KiB。拒绝无效 UTF-8、HTTP、伪造认证、跨角色、重放、额外连接和超限输入。
- grant/reader/父任务撤销会中止在途调用并关闭整个工具通道；close 等待 listener、socket 和所有在途处理完成。MCP helper 在 IPC 丢失时退出，即使原生 stdin 尚未关闭。**桥接资源关闭不等于 Provider 进程树已停止，也不擅自结算 DB 任务。**
- 使用真实 loopback 连接与 Node 子进程验证了继承 fd、MCP 初始化/通知/工具列表/拒绝资源访问、输出断管、错误诊断、原生 stdin 未关时退出及撤销中止提案提交。子进程测试只保留必要 PATH，不继承模型凭据、NODE_OPTIONS 或用户扩展配置；没有模型调用。

```sh
TMPDIR="$(node -e 'process.stdout.write(require("node:fs").realpathSync(require("node:os").tmpdir()))')" \
  node --import tsx --test tests/agent-maintenance-ipc.test.ts
```

这是认证的本机明文 IPC，不是 OS 沙箱或加密网络隧道，不承诺隔离具有 OS 管理员/同用户进程检查权限的主体。此处不采用文件 socket，因此没有崩溃后扫描/猜测删除路径的行为。

**仍未完成生产验收**：正式受控 launcher/包完整性及发现策略、模型工具调度、原生会话持久化/准确恢复及真实运行中进程树退出。下节仅补充真实 Pi 的无模型组合探测。不能降级成环境/共享文件凭据或重放历史来使测试通过。正式 Provider 受控环境 allowlist 也尚未实现；Node helper 测试清空环境不等于生产 launcher 已接线。Pi/Codex 维护模式继续禁用，实际模型验收另行说明模型与计费范围后执行。

## 8. Pi 工具适配层与真实 RPC 无模型组合探测

新增 `maintenance-pi-tools.ts`：显式注册 read/ls/find/字面 grep 与 3 个 Orchard 提案工具；读取只走认证 reader IPC，提案只走独立 helper 的 MCP stdio。与服务端复用读取 Schema；工具清单必须恰好 7 个，额外参数、未确认应用、通道丢失、活动工具集漂移均拒绝。取消关闭两个通道，等待中的提案不得迟到提交；MCP 错误转换成 Pi 执行异常，不把 MCP 的 `isError` 误当成 Pi 的错误标记。

新增 `maintenance-mcp-client.ts`：只接受 launcher 提供的私有输入/输出流，不接受命令、环境、连接地址或文件凭据。严格检查 ID/UTF-8/响应结构、大小/并发/请求数/超时；断管永久撤销，无自动重连、资源发现或原始错误正文。

Pi 扩展层另外拦截 `user_bash`，因为 RPC `bash` 不受活动工具列表控制；取消切换/分叉/树导航/压缩，禁用空闲 cache warming。适配器不是完整 launcher，须在 `session_start` 内注册，不能在未绑定的扩展 factory 阶段使用运行时工具 API。

```sh
ORCHARD_MAINTENANCE_PI_CLI=/absolute/path/to/pi-coding-agent/dist/cli.js \
TMPDIR="$(node -e 'process.stdout.write(require("node:fs").realpathSync(require("node:os").tmpdir()))')" \
  node --import tsx --test tests/agent-maintenance-ipc.test.ts tests/agent-maintenance-mcp-client.test.ts tests/agent-maintenance-processes.test.ts
```

本机 Pi **1.5.2** 已执行通过。测试在隔离 HOME/agentDir、清空继承凭据的环境启动真实 CLI，关闭自动资源/规则发现，显式加载临时测试扩展；reader bootstrap 使用继承 fd 3，MCP 请求/响应经 fd 4/5 由测试宿主接到独立 helper。实际验证：活动工具集恰好 7 个、无技能/模板/扩展命令、RPC shell 被拒绝、new_session 被取消、登记快照读取成功、外部/../及未登记文件被拒绝、提案入库但不应用。Pi 和 helper 现由 `MaintenanceProcessRegistry` 分别以受管独立进程组启动，RPC 请求同时登记在途回调；关闭 stdin 后等待两个子进程退出、stdio close、回调 drain 及受管组消失；assistantMessages=0，未调用模型。

**证据边界**：临时测试扩展有仅供探测的 input driver，它直接调用真实注册适配器的 execute，不是模型发出工具调用的完整 Pi 调度链。业务授权/投影和停机回调仍用明确的隔离 fixture；正常 EOF 退出也不是生产取消/重启后的进程树证明。没有正式 launcher、生产扩展入口、版本/包指纹准入或原生 session 恢复，不可据此启用 Provider。未设置上述 CLI 路径时组合探测明确 skip，不伪造通过。

## 9. 受管进程组与关闭负例

`maintenance-processes.ts` 是独立宿主 registry，不是正式 launcher 或生产 factory。只能通过本实例的内存 capability 登记启动，绑定 task/session/generation；只启动固定 Node 可执行文件及平台传入的编译包入口，没有 shell、任意 PID 接管、文件恢复或 HTTP/MCP 暴露。入口完整性须后续 launcher 独立验证，绝对路径本身不构成信任。

- 真实 ChildProcess 在任何 await 前登记；独立组/显式环境/继承管道。没有 process.env 合并；额外阻止 Node 的隐式 NODE_V8_COVERAGE 复制，避免向宿主覆盖率目录写入。macOS CoreFoundation 编码变量使用 OS uid 派生值，不复制父值。
- 停止先冻结准入、abort lease，再按有限单调预算等待 EOF、发 TERM、必要时 KILL。发信号不是证据，必须等待真实退出、stdio 关闭、所有登记回调结束和受管组不存在。超时不释放全项目准入，不清理失败记录；重试须重新核对真实条件。
- 观察组不存在后锁存结果；主进程已退出而组仍存活时继续拒绝，不能对可能复用的数字 PGID 猜测发信号。不扫描/采纳重启遗留进程，不能凭数据库无活动任务构造证明。
- stop/close 在 abort 回调可能重入前先登记共享 promise；重复关闭不重复发起停机。新回调即使排在微任务中，只要 lease 已取消也不会执行。
- 本机 macOS **12 项真实进程测试全部通过**：EOF、TERM、忽略 TERM 后 KILL、两个独立组、普通同组后代、主进程退出但后代存活时阻断、预启动失败、干净环境、伪造/跨实例 capability、归属不符、回调挂起/失败及重入。孤儿回收负例只在 macOS 执行，Linux 最小容器 init 可能不回收 zombie，应继续阻断而非放宽证明；Windows registry 明确不可用。

**不是全进程树认证**：子进程若逃逸到新组，单纯原组消失无法证明其停止。本模块只提供 `assertOwnedStopped`，不得单独实现服务的全项目 `assertQuiescent` 或会话的完整 `assertStopped`。可信运行时、包/模型准入、禁止派生未登记进程及工具通道关闭/授权证明尚待组合；没有重新启用维护 Provider。
