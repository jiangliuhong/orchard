## Purpose

让 Orchard 通过宿主机上已安装且自持凭证的 `pi` 与 `codex` CLI 真实执行 `ai.pi` 节点与 Pi authoring 请求，把 agent profile 接入运行时，同时不引入 HTTP 网关、不保存任何裸密钥。

## ADDED Requirements

### Requirement: CLI 可执行文件必须经受信解析且不可被运行请求注入
系统 SHALL 在启动时解析每个 CLI 后端（launcher 枚举固定为 `pi-cli` 与 `codex-cli`）的可执行文件：优先采用系统设置中保存的路径，否则在文档化的常见安装目录中自动发现，并将解析结果钉定为绝对路径。用户 SHALL 能在系统设置中查看与修改各后端的可执行文件路径，修改经保存时探测验证后立即生效。运行期的工作流与 agent 请求 MUST NOT 指定、覆盖或注入可执行文件路径；后端未解析成功时，执行 MUST 以可识别的配置错误失败，且不启动任何子进程。

#### Scenario: 自动发现并钉定
- **WHEN** 启动时用户未在系统设置中指定路径，且在常见安装目录中发现可通过版本探测的 CLI
- **THEN** 系统将其解析为绝对路径注册为该后端的可执行文件，解析路径与来源在系统设置与探测结果中可见

#### Scenario: 用户在系统设置中修改路径
- **WHEN** 用户在系统设置中为某后端保存新的可执行文件路径
- **THEN** 保存前对该路径执行版本探测，探测通过后新路径立即生效，后续执行使用新路径

#### Scenario: 无效路径被拒绝
- **WHEN** 用户保存的路径不存在或无法通过版本探测
- **THEN** 保存被拒绝并返回探测失败原因，原解析结果保持不变

#### Scenario: 未解析到后端
- **WHEN** 某 launcher 既无用户设置路径也未在常见目录中发现可用 CLI
- **THEN** 使用该 launcher 的节点或请求以配置错误失败，且没有任何子进程被启动

#### Scenario: 运行期注入可执行文件被拒绝
- **WHEN** 运行请求或 profile 数据试图携带可执行文件路径
- **THEN** 系统拒绝或忽略该路径，实际使用的可执行文件只来自受信解析结果

### Requirement: Agent profile 字段必须按 CLI 语义解析
系统 SHALL 将 `agent_profiles.provider` 解释为 launcher 枚举（`pi-cli` | `codex-cli`），枚举之外的值 MUST 在创建、更新与执行时被拒绝；创建 Agent 的界面 MUST 以选择方式提供 launcher，而非自由文本。`model` 允许为空字符串以使用 CLI 默认模型。`config_json` 只接受受控的枚举字段（超时覆盖、codex 沙箱模式、pi thinking level），任意命令行参数或其他未枚举字段 MUST 被拒绝。`allowed_tools_json` 对 pi 映射为工具白名单，对 codex 映射为沙箱授权。`secret_ref` SHALL 视为弃用：不再写入新值，读取时忽略，凭证由宿主机 CLI 自持。

#### Scenario: launcher 枚举校验
- **WHEN** 创建或更新 agent profile 时 provider 不在 `pi-cli` / `codex-cli` 枚举内
- **THEN** 请求被拒绝并返回明确的校验错误

#### Scenario: 受控字段外的命令行注入被拒绝
- **WHEN** `config_json` 包含任意命令行参数或未枚举字段
- **THEN** profile 的保存或执行被拒绝，该内容不会被拼入子进程命令行

#### Scenario: 空 model 使用 CLI 默认模型
- **WHEN** profile 的 `model` 为空字符串
- **THEN** 执行时不向 CLI 传递模型选择参数，由 CLI 使用其自身默认模型

### Requirement: ai.pi 节点必须能经宿主 CLI 真实执行
运行时 SHALL 注册 `ai.pi` 节点：按 step 配置中的 agentProfileId 解析 profile，路由到对应 CLI 后端执行；prompt MUST 经 stdin 传入子进程，不得经 shell 拼接或命令行参数传递全文；系统 MUST 从 CLI 的结构化输出中提取最终 assistant 消息及 provider/model/usage 元数据。执行记录 SHALL 可在 Run/Step/Attempt 历史中定位。

#### Scenario: 有效 profile 且 CLI 可用
- **WHEN** `ai.pi` 节点配置了指向有效 agent profile 的 agentProfileId，且对应宿主 CLI 探测可用
- **THEN** 节点真实调用 CLI 并产出输出，输出经 step 的 JSON Schema 校验后成为节点结果

#### Scenario: agentProfileId 指向不存在的 profile
- **WHEN** step 配置中的 agentProfileId 无法解析到任何 agent profile
- **THEN** 节点以可识别的配置错误失败，不启动子进程

#### Scenario: 输出元数据可用
- **WHEN** 一次 CLI 执行成功
- **THEN** 结果携带实际使用的 provider、模型与 usage 信息，可被上层展示或记录

### Requirement: CLI 子进程必须受到完整进程控制
所有 CLI 子进程 MUST 经统一的进程控制机制拉起：具备超时、输出字节上限、取消传播与进程组终止（SIGTERM 失效后 SIGKILL 兜底）；子进程工作目录 MUST 锁定在 Orchard 工作区内。超时、取消与输出超限 MUST 各自产生可识别的错误类别。

#### Scenario: 超时终止
- **WHEN** CLI 执行超过生效的超时配置
- **THEN** 子进程被终止，对应 attempt 记录超时错误

#### Scenario: 取消传播
- **WHEN** 所属运行被取消
- **THEN** CLI 进程及其子孙进程被进程组终止，attempt 记录取消

#### Scenario: 输出超限
- **WHEN** CLI 输出超过字节上限
- **THEN** 执行以输出超限错误失败，不得静默截断并视为成功

### Requirement: 默认最小权限
pi 后端 SHALL 默认不授予任何工具，仅当 profile 显式配置 `allowed_tools_json` 时才传递工具白名单；codex 后端 SHALL 默认以只读沙箱执行，仅当 profile 显式授权时才可使用可写工作区沙箱。

#### Scenario: pi 默认无工具
- **WHEN** 后端为 `pi-cli` 且 profile 未配置 allowed_tools
- **THEN** CLI 调用不携带任何工具授权

#### Scenario: codex 默认只读沙箱
- **WHEN** 后端为 `codex-cli` 且 profile 未显式授权写入
- **THEN** CLI 以只读沙箱级别执行

#### Scenario: 显式授权后才可写
- **WHEN** profile 显式授权可写工作区且后端为 `codex-cli`
- **THEN** CLI 以可写工作区沙箱执行，且授权来源可在 profile 配置中追溯

### Requirement: 输出契约校验失败必须可重试
当 step 配置了输出 JSON Schema 时，从 CLI 提取的输出 MUST 在节点返回前完成校验；校验失败 SHALL 记为该次 attempt 的可重试错误并交给 step 既有重试机制处理，系统 MUST NOT 伪造输出或将校验失败标记为成功。

#### Scenario: 输出不满足 schema
- **WHEN** CLI 最终消息可解析为 JSON 但不满足 step 的输出 schema
- **THEN** 本次 attempt 失败并进入既有重试流程

### Requirement: 宿主 CLI 可用性必须可探测并可见
系统 SHALL 在启动时与 `orchard doctor` 中探测受信 CLI 后端的可用性（可执行文件存在、版本查询可执行、pi 的 provider 就绪状态），并将探测结果（含解析路径与来源）暴露给工作台系统设置与 Agent 管理界面。

#### Scenario: doctor 输出探测结果
- **WHEN** 运行 `orchard doctor`
- **THEN** 输出包含每个受信 CLI 后端的可用性结论、解析路径、来源与不可用原因

#### Scenario: 工作台可见
- **WHEN** 用户打开工作台系统设置或 Agent 管理界面
- **THEN** 可看到各 CLI 后端当前是否可用、解析路径、来源及不可用原因

### Requirement: CLI 后端错误必须如实透出
CLI 调用失败（包括凭证过期、token 刷新被拒、地区限制 403、模型不存在、进程启动失败）SHALL 记录为明确的 failed attempt，错误信息 MUST 包含 CLI 原始 stderr 的摘要；系统 MUST NOT 伪造输出或将失败伪装为成功。

#### Scenario: 凭证或地区限制失败
- **WHEN** 宿主 CLI 因凭证过期或受限地区 token 刷新失败（如 403）而退出
- **THEN** attempt 记录失败并透出原始 stderr 摘要，运行标记为失败且可重试

#### Scenario: 模型不存在
- **WHEN** profile 指定的模型在 CLI 后端不存在
- **THEN** 执行以包含 stderr 摘要的明确错误失败

### Requirement: Pi authoring 必须可复用同一 CLI 后端
Pi authoring SHALL 可配置为与运行时相同的受信 CLI 后端，替代永不接线的 HTTP 网关路径；当未配置任何 Pi 后端时，MUST 保持现状的明确配置错误语义（如 503），不得伪造创作结果。

#### Scenario: 配置 CLI 后端后 authoring 可用
- **WHEN** 系统配置了可用的 CLI 后端并收到 draft author 请求
- **THEN** 请求经 CLI 后端真实执行并返回可校验的创作结果

#### Scenario: 未配置任何后端
- **WHEN** 系统未配置任何 Pi 后端时收到 draft author 请求
- **THEN** 返回可识别的配置错误，不创建任何工作流版本
