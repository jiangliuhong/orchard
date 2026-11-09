# Node.js 预处理与浏览器执行

不变更数据库。工具可使用 `execution.transport: "browser"`，旧工具及 localHttp 保持原行为。Agent 契约版本为 7，支持生成下述配置。

```json
{
  "version": 1,
  "transport": "browser",
  "preprocess": {
    "runtime": "nodejs",
    "credentials": {
      "ak": { "dictionaryId": "YOUR_ENCRYPTED_DICTIONARY_ID", "key": "ak" },
      "sk": { "dictionaryId": "YOUR_ENCRYPTED_DICTIONARY_ID", "key": "sk" }
    },
    "code": "const body = args.body; const nonce = crypto.randomBytes(16).toString('hex'); const timestamp = String(Date.now()); const signature = crypto.createHash('md5').update(args.productNo + nonce + args.apiCode + timestamp + credentials.sk + body, 'utf8').digest('hex'); return { path: request.path, method: request.method, body, headers: { Authorization: 'Bearer ' + credentials.ak, 'X-OS-Api': args.apiCode, 'Content-Type': 'application/json; charset=utf-8', nonce, timestamp, signature } };"
  },
  "response": { "mode": "fullJson", "maxBytes": 262144 }
}
```

工具仍需完整的 path、method、parameters 等定义。上述脚本要求 body 为原始字符串，productNo/apiCode 为字符串；应在参数 Schema 中声明。不进行 HTTP Date 校时。签名顺序为 productNo + nonce + apiCode + timestamp + sk + body，无分隔符、小写 MD5；这里 nonce 为随机 16 字节 hex，实际协议不同应调整。

## 运行

### 参数输入配置

测试页只按工具 `parameters` 的 JSON Schema 生成表单，不保留整段参数 JSON 编辑框或旧模式切换。根节点必须声明 `type: "object"`，各字段在 `properties` 中声明明确类型。例如：

```json
{
  "type": "object",
  "properties": {
    "productNo": { "type": "string", "title": "产品编号" },
    "content": {
      "type": "string",
      "title": "请求内容",
      "x-ui": { "widget": "textarea", "rows": 7, "placeholder": "请输入请求内容" }
    }
  },
  "required": ["productNo"],
  "additionalProperties": false
}
```

字符串默认使用单行输入框，只有显式指定 `x-ui.widget: "textarea"` 才使用多行。`x-ui` 仅适用于字符串；支持 widget（input/textarea）、placeholder 和 textarea 专用 rows（2–30）。title 用于标签，description 用于说明，required 表示必填。enum 使用保留值类型的下拉框，number/integer 使用数字输入框，boolean 使用是/否选择，object/array 使用字段级 JSON 输入框。

可选字段清空后不提交。字段类型、必填及其他 Schema 约束不满足时禁止执行。根级组合 Schema 和 `$ref`、没有明确支持类型的字段会提示修改工具定义，不回退至旧编辑器。textarea 值保持字符串，不自动解析为对象。参数控件配置不涉及数据库变更。

### 响应后处理

browser 和 localHttp 均支持在工具的“执行配置（JSON）”中添加可选的 `postprocess`：

```json
{
  "postprocess": {
    "runtime": "nodejs",
    "timeoutMs": 1000,
    "code": "return { items: response.data.list, total: response.data.total };"
  }
}
```

此片段合并到现有 `execution`，保留 version、transport、response 等配置。脚本接收 `response` 和 `args`，作为 async 函数体执行，使用 `return` 返回 JSON 值；不提供 credentials、request 或预处理局部变量，不使用顶层 import 或 console.log。提取嵌套上游字段时使用 `response.mode: "fullJson"`。

处理顺序为原始响应大小与凭据回显检查、fields/fullJson 筛选、Node.js 后处理、输出大小与凭据回显检查。后处理结果是测试、Agent 和工作流收到的最终值。未配置时保持原行为。默认后处理超时 1000ms，可配置 1–10000ms，并受工具调用剩余时间约束；输出受 response.maxBytes 限制。脚本错误、无效 JSON、超时或取消都会使调用失败，不回退为原始结果。独立进程使用与预处理相同的权限和内存限制，只执行已审阅的可信代码，不构成恶意代码安全沙箱，也不保证网络隔离。

1. 重新加载浏览器扩展以获得 scripting 和站点权限请求能力。
2. 打开目标 HTTPS 业务页签，手动完成网关登录。在扩展弹窗点击“授权当前站点桥接”。权限按站点授予，不自动请求所有站点。
3. 工作台环境配置 origin 和 profileId；多个启用环境必须选择 environmentId。
4. 同源匹配只有一个页签时使用该页签；多个匹配时要求唯一 active 页签，否则返回 TAB_REQUIRED，不猜测账号。
5. execute/write/delete/download 或 approval:user 的工具必须逐次确认。工作台“确认并执行”弹窗通过后调用 `/api/web-bridge/calls`，带 `approved:true`。API/CLI 调用方仅应在取得用户对本次参数的明确确认后传入该字段；未传则拒绝。只读测试接口不接受确认字段。CLI 对应 `--environment-id <id> --approve`，`--approve` 表示调用者已取得本次执行的用户确认。

浏览器执行在目标页签 MAIN world 以 credentials:include 发送，脚本只返回路径、headers、原始字符串 body，不在浏览器运行 Node.js。发送时不重新序列化 body。业务 Authorization:Bearer 与网关 Cookie 分别承担业务鉴权和网关登录；不会提取、回传 Cookie，也不会用 AK/SK 绕过网关。401/403 或非 JSON 登录页返回 GATEWAY_AUTH_REQUIRED；重定向被拒绝（浏览器 fetch 对此可能仅给出通用失败），请在页签手动登录后重新确认调用。不自动重试有副作用的请求。取消可终止 Node.js 预处理并移除待投递任务；已投递的浏览器 fetch 按剩余总超时截止，不能保证立即撤销，已被上游接受的业务动作不能回滚。

## 边界与保护

- Node.js 预处理在独立进程执行，开启 Node permission mode，无继承环境变量，禁止文件/子进程访问；限制堆、输出及总调用时间，取消会杀死进程。这不是用于运行恶意代码的安全沙箱，Node 24 permission mode 不保证网络隔离，只能保存及执行已审阅、可信的代码。
- `args` 为工具参数，`credentials` 为加密字典在运行时解析的字符串，`request` 含定义中的 path/method，`crypto` 是 node:crypto。代码作为 async 函数体执行，使用 return；不要使用顶层 import 或 console.log。
- 不要把真实 AK/SK 作为普通参数或写入定义：普通调用参数仍遵循原工作流历史规则。当前安全注入通道是加密字典引用，不新增独立的临时秘密参数存储。
- 浏览器支持动态同源路径：定义中的 `path` 是提供给脚本的 `request.path` 默认值，不限制为固定产品。预处理可根据参数返回其他路径，例如在接口证据支持 `/{productNo}/request` 时返回 `path: '/' + encodeURIComponent(args.productNo) + '/request'`，并在参数 Schema 中约束 productNo 为安全的单个路径段（如 `^[A-Za-z0-9_-]+$`）。浏览器不展开定义中的 `{argument}` 占位符，该模板语法仅属于 localHttp；浏览器应在脚本中生成具体路径。
- 仅允许同源绝对 pathname，无查询/片段、路径穿越或编码分隔符；脚本不能改变审阅的方法。Cookie/Host/Origin/Referer、sec-/proxy- 等保留头禁止覆盖。业务自定义头与 Content-Type 可设置。
- 浏览器轮询通道使用按资料的临时 token，限制插件来源和资料身份，任务只投递一次；关闭或恢复配置会清空会话及待执行任务。传递给页签的头自然对该页签可见，因此应只授权可信业务站点。
- fullJson 保留 JSON 值，包括数组/null，最大 256 KiB；fields 按白名单返回。已注入凭据、Authorization/signature/token 头的直接回显被拒绝，不存入业务结果。无法识别任意编码或变换后的秘密回显。
- 撤销权限可在 Chrome 扩展站点访问设置中进行。资料绑定、站点授权、网关登录三者都需要满足。

真实 Chrome、站点 CSP、网关及业务权限需要在部署环境联调；单元测试不能证明实际网关已授权。
