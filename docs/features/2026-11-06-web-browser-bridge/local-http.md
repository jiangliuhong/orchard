# 本机 HTTP 工具执行

## 边界

工具新增可选 `execution`，显式选择 `version: 1, transport: "localHttp"`。
不配置时保留旧桥接行为。本机 HTTP 不使用浏览器 Cookie、页面登录态或浏览器资料；本次没有实现浏览器请求执行器，也不支持任意内嵌代码。

不涉及数据库表结构或数据迁移。扩展配置保存在现有 `web-bridge.json`，启动/恢复和 Git 快照入口均校验执行配置；旧程序可能拒绝带有新字段的快照，不保证向旧版本降级。

当前仍仅允许 `risk: read, approval: none` 调用。POST 查询应按实际副作用分类，不能将写入接口标记为读取来绕过审批。

## 配置示例

以下只是语法示例，**不是任何实际接口的签名协议**。必须从接口文档/原始脚本确定字段顺序、分隔符、nonce 格式、时间单位、大小写及请求头名。

```json
{
  "toolId": "credit_query",
  "application": "mex",
  "site": "mex",
  "description": "查询产品信用信息",
  "parameters": {
    "type": "object",
    "required": ["productNo", "body"],
    "properties": {
      "productNo": { "type": "string", "minLength": 1 },
      "body": { "type": "string" }
    },
    "additionalProperties": false
  },
  "path": "/{productNo}/request",
  "method": "POST",
  "fields": [],
  "risk": "read",
  "approval": "none",
  "timeoutMs": 18000,
  "catalogVersion": "1",
  "enabled": true,
  "execution": {
    "version": 1,
    "transport": "localHttp",
    "body": { "mode": "rawUtf8", "argument": "body" },
    "signing": {
      "algorithm": "md5",
      "dictionaryId": "replace-with-encrypted-dictionary-id",
      "akKey": "ak",
      "skKey": "sk",
      "parts": ["ak", "sk", "nonce", "timestamp", "body"],
      "separator": "",
      "digestCase": "lower",
      "nonceBytes": 16,
      "timestampUnit": "milliseconds",
      "headers": {
        "ak": "X-AK",
        "nonce": "X-Nonce",
        "timestamp": "X-Timestamp",
        "signature": "X-Signature"
      }
    },
    "response": { "mode": "fullJson", "maxBytes": 262144 }
  }
}
```

在密钥设置中配置活动密钥，通过现有加密字典界面保存 AK/SK，再把字典 ID 和键名写入工具；不要把真实凭据放入工具参数、工具定义、Agent 对话或测试上下文。也支持显式引用普通字典的字符串键，但敏感凭据建议加密保存。未找到字典、字典停用、键类型不是字符串或解密失败时调用拒绝，不自动回退到其他来源。

## 请求语义

- `path` 中的 `{argument}` 必须在参数 Schema 中声明，运行时取顶层字符串/有限数值。替换为编码后的路径段；空值、`.`、`..`、斜线、反斜线、百分号、空白和控制字符拒绝。origin 只能来自已启用环境，参数不能覆盖。
- `body.mode: rawUtf8` 直接使用字符串；拒绝无效 Unicode。`json` 对指定参数调用一次 JSON 序列化。签名和发送使用同一份最终 UTF-8 字节。仅 POST 支持请求体映射，上限 256 KiB。Content-Type 固定为 `application/json; charset=utf-8`。
- 本模式**没有隐式参数到 query/body 的映射**；未被路径和 body 显式绑定的参数不发送。暂不支持查询字符串、非 JSON Content-Type 或任意自定义请求头。
- 签名仅支持依次拼接 `parts` 中的 `ak/sk/nonce/timestamp/body/path`，使用 `separator` 分隔后计算 MD5，输出大小写 hex。`path` 是最终编码路径，`body` 是最终发送字符串（无体为空串）。不支持额外排序、嵌套摘要、HMAC 或任意表达式；MD5 只用于兼容旧接口，不作为新安全协议推荐。
- nonce 使用密码学随机字节转小写 hex；`nonceBytes` 范围 8–64。时间戳向下取整，支持秒或毫秒。
- 可选 `signing.clock` 为 `{ "path": "/time", "field": "timestamp", "unit": "milliseconds" }`：向同 origin 固定路径发送不带鉴权的 GET，读取顶层数值时间戳，并加上半个往返耗时。校时响应上限 16 KiB，失败不回退本机时间。其他校时协议尚不支持。
- 禁止重复/保留鉴权头，SK 只参与本机摘要，不发给上游。所有请求禁用重定向，避免鉴权信息流向其他站点。
- 校时、发送及响应读取共享超时/取消信号；服务关闭也会取消在途调用。上游异常不会把原始 fetch 错误中的 URL/鉴权数据透出。

## 返回语义

`response.mode: fullJson` 返回整个 JSON 值，包括对象、数组、标量和 null，不保留原始空白格式。不返回响应头。`fields` 模式仅返回顶层字段白名单；`[]` 返回空对象，`["*"]` 只匹配名为 `*` 的字段，不代表完整响应。

响应按解压后的实际流字节计数，`maxBytes` 最大 256 KiB；超限、非法 JSON、非成功 HTTP 状态均明确失败，不静默裁剪。检测到 AK、SK 或签名值被上游原文回显时阻止结果进入后续历史；这不是通用 DLP，无法识别任意编码或变换后的敏感信息，上游仍应避免回显凭据。

## 环境选择

工具定义不绑定环境。测试界面提供环境选择；API 调用：

```json
{
  "application": "mex",
  "tool": "credit_query",
  "environmentId": "existing-enabled-environment-id",
  "args": { "productNo": "mex_export_user_credit_level_v1", "body": "{\"userId\":\"example\"}" }
}
```

POST `/api/web-bridge/calls`，或者 POST `/api/web-bridge/applications/mex/tools/credit_query/test?environmentId=...`（后者 body 直接是参数对象）。仅一个启用环境时可省略环境 ID；多个启用环境时必须显式选择。工作流 `web-bridge` 节点也支持 `config.environmentId`。不需要浏览器资料绑定。

Git 快照只包含字典引用，不包含凭据；换机器或恢复配置后需准备所引用的普通或加密字典；加密字典还需匹配的密钥。

## 验证

- `tests/bridge-http.test.ts`：固定签名向量、UTF-8 字节、校时、动态路径安全、完整响应/白名单、限额、敏感回显、真实 HTTP + 加密字典 + API 环境路由、配置持久化、取消及超时。
- `tests/bridge-http-ui.test.ts`：执行 JSON 编辑、跨字段非法输入保护、旧桥接模式重置。
- 业务接口联调需要原始签名脚本或接口文档，以及用户自行配置的测试凭据。不得将示例签名规则当作已验证业务规则。
