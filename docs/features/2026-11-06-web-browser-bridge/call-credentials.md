# 浏览器工具的调用时凭据

browser 执行模式允许调用方逐次选择加密字典引用或手动字符串；每个凭据可以独立选择来源。localHttp 的既有字典签名配置不变。

## 工具声明

在 execution 中声明所需名称，不保存真实值，也不要求绑定字典：

```json
{
  "version": 1,
  "transport": "browser",
  "credentialInputs": ["ak", "sk"],
  "preprocess": {
    "runtime": "nodejs",
    "code": "return {path: request.path, method: request.method, headers: {Authorization: credentials.ak, signature: crypto.createHash('md5').update(credentials.sk).digest('hex')}};"
  },
  "response": {"mode": "fullJson", "maxBytes": 262144}
}
```

示例只展示凭据入口，不代表目标接口的签名协议。预处理仍读取统一的 credentials 对象。

旧的 execution.preprocess.credentials 字典映射继续可用，作为默认来源。声明名称和默认映射中的名称均为必需凭据。显式调用绑定覆盖对应默认值；显式绑定解析失败不会回退。

## 调用协议

POST /api/web-bridge/calls：

```json
{
  "application": "crm",
  "tool": "query",
  "args": {},
  "credentialBindings": {
    "ak": {"source": "dictionary", "dictionaryId": "dictionary-id", "key": "ak"},
    "sk": {"source": "inline", "value": "<仅本次输入>"}
  }
}
```

两项都可以改成 dictionary 或 inline。每项只允许一个来源；未知名称、空值、缺失值和无效引用会失败。字典由既有内部解析器读取，只接受可用的已启用加密字典，并沿用本机工作台访问边界；当前没有额外的多租户字典授权体系。

## 输入与安全边界

- 测试页提供来源切换、字典 ID/键输入及密码输入框，不将值放进 JSON args、工具定义或 Agent 上下文。
- 手动值只保留在当前测试面板内存中；执行成功或失败、切换工具或离开测试面板时清空。不写入 localStorage 或调用历史。JavaScript 内存清空不等于可保证物理内存擦除。
- API 绑定通过本机 HTTP 请求体传递，独立于普通 args；不是新的加密传输协议。外部调用方也必须自行避免在命令行、聊天、模型工具调用记录、代理日志中暴露明文。
- 服务端目前关闭请求日志，凭据只在调用局部解析，经子进程 stdin 注入；不进入进程命令行和继承环境。调用接口返回 Cache-Control: no-store；格式错误及底层异常使用不包含原始载荷的错误消息。
- 浏览器通道接收脚本生成的请求，不接收完整凭据绑定。经审阅的脚本仍有能力将秘密写入请求；必须只把业务协议所需信息发给受信目标，通常不应发送原始 SK。
- 原始凭据与敏感鉴权头继续参与响应回显检查。该检查不是任意编码、散列或恶意脚本的通用数据防泄露沙箱。
- 不在工具编写 Agent 对话中索取或填写真实 AK/SK。调用方若只有会记录明文的普通模型工具入口，不能直接用该入口传 inline 值，应使用测试页或可信客户端的独立秘密输入界面。

不涉及数据库表结构变更。
