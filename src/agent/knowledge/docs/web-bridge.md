# 浏览器工具维护

在 project.json 查找当前应用。browser-tools/<应用 ID>/resource.json 包含应用和可见环境信息，每个工具子目录的 tool.json 是已有定义。结合用户提供的业务证据确定端点、参数和响应。

## 提案边界
使用 change: {operation: "tools", changes: [...]}。changes 内每项带 operation、toolId、definition，create/update 提供完整定义，delete 的 definition 为 null。通过 mcp__orchard__submit_proposal 提交，原样使用宿主的 target 和 baseline。新工具的 application/site 取当前应用 ID，默认 timeoutMs 为 18000、catalogVersion 为 "1"、enabled 为 true。具体字段遵守提交工具 Schema。

只提议工具定义修改。运行环境、浏览器绑定和登录由用户配置。环境列表为空仍可提交有接口证据的提案。risk 按实际副作用判断，新只读工具使用 approval:none，非只读默认 approval:user。

## 参数与敏感值
parameters 是参数 JSON Schema，不实现签名或请求映射。测试表单要求根 type:object 和明确类型的 properties；字符串默认单行，x-ui.widget=textarea 时 rows 2–30。复杂组合 Schema 不适合表单时明确说明，不能伪造参数。

凭据与业务 args 分离。credentialSchema 声明平面字符串凭据字段，敏感值/父对象用 x-history:{record:false}；credentialInputs 为兼容声明，不代表需要在聊天中提供真实值。调用时由受保护输入或字典引用提供，定义中只保存安全引用。{{dictionary:...}} 仅为显示令牌，不是凭据值。

## 执行定义知识（生成文本，不执行）
- origin 属于环境配置，工具只声明同源 pathname。新 site 使用当前 application，更新保留已有合法 site。
- localHttp 为显式选择的原生 HTTP，不携带浏览器 Cookie；支持受约束的参数路径模板和声明式映射。
- browser 通过选定 profile、扩展权限及同源已登录标签页发送请求；业务 Authorization 不能代替网关登录，不能通过脚本管理 Cookie 或绕过登录。
- browser preprocess 是 Node.js 函数体，使用 args、credentials、request、crypto，不写 import。返回对象必须含 path、method 和 headers。即使无需自定义请求头，也必须返回 headers: {}。固定路径的 GET 用 `return { ...request, headers: {} };`，因为 request 默认值只有 path 和 method。body 可选，GET/HEAD 省略。动态 path 可从有证据的参数计算，但必须同源、安全单路径段、无查询/片段/越界或编码分隔符，method 不可改变。
- body 为精确 UTF-8 字符串，不能签名后再次序列化。GET/HEAD 无 body。Cookie/Host 和受保护头不可覆盖。
- fields 为显式字段白名单，[] 或 ["*"] 不等于完整 JSON。需要完整 JSON 时使用宿主支持的 execution.response.mode=fullJson，并遵守大小/凭据回显限制。
- 两种传输可使用受控 execution.postprocess；函数体使用 response/args 并返回 JSON，不带 import、不依赖 preprocess 变量或密钥，默认 1000ms、最大 10000ms。
- 签名算法、字段顺序、分隔符、大小写、nonce、时间单位、header 和时钟来源均须有证据，不能猜测 MD5 或其他业务协议。

生成代码不代表签名符合业务系统或测试成功。提案只有经宿主校验与用户确认后才会应用。

## 浏览器请求链
- browser preprocess 返回的 `query` 可选，为参数名到字符串的映射。扩展用 URLSearchParams 构造查询串。path 仍是独立 pathname。
- 使用可选 `execution.flow: { capture?, steps }` 在同一已登录页签中执行请求链。定义的 path/method 及 preprocess 决定第一条请求，其后执行 1–8 个已审阅步骤。扩展在隔离执行环境中运行整条链；每条响应遵守 response.maxBytes，整条链受调用超时限制。配置请求链后应同步更新浏览器扩展。
- 初始 preprocess 还可返回 `variables` 字符串映射。初始响应和每个后续步骤可用 `capture: { 变量名: { at: ["result", "field"], secret?, optional? } }` 提取标量。可选字段缺失时不设置变量。保护值 `secret:true` 仅能插入后续请求头，从不作为中间响应返回。扩展检查最终响应是否包含保护值。
- 步骤支持 `{path,method,headers?,query?,bodyFrom?,when?,capture?,poll?}`。path、头和查询参数值里的 `{变量名}` 会替换；path 变量限 ASCII 字母、数字、下划线和连字符。查询参数值可用 `{变量名:rison}` 生成带引号的 Rison 字符串。bodyFrom 引用字符串变量作为完整请求体。when 表示仅在普通变量存在时执行，首个后续步骤必须执行。最后一个已执行步骤的响应进入常规字段筛选和 postprocess。
- GET 步骤可配置 `poll: { at, success, failure, intervalMs, maxAttempts }`，用 at 路径读取状态，与成功和失败列表进行不区分大小写的比较。间隔 100–10000 毫秒，最多 120 次；到达次数或调用期限时失败。任何非 GET/HEAD 步骤要求声明非 read 风险并设置 approval:user。
- 按名称解析 ID 可在初始响应或后续响应声明 `capture: { databaseId: { at: ["result"], match: { field: ["database_name"], equalsFrom: "databaseName", value: ["id"] }, positiveInteger: true } }`。at 指向数组，field 与 value 是相对每项的路径。equalsFrom 引用 preprocess 或前序捕获的普通字符串。比较区分大小写，零条或多条匹配分别返回明确错误。使用实际响应字段；Superset 原始数据库列表使用 database_name，工具归一后的输出可能使用 databaseName。
- 后续步骤可以把捕获的 ID 插入 path，例如 `/api/v1/database/{databaseId}/tables/`。POST 可在 `bodyFrom` 引用的初始 JSON 对象上设置 `jsonFields: { database_id: { from: "databaseId", type: "positiveInteger" } }`，以 JSON 数字写入字段。type 也支持 string。保护值只可用于请求头。默认连接名可由 preprocess 在参数省略时填入 variables。
