# 浏览器工具的调用时凭据

browser 执行模式允许调用方逐次选择普通或加密字典的字符串键引用，或手动字符串；每个凭据可以独立选择来源。localHttp 的既有字典签名配置不变。

## 字典引用选择器设计

采用左右分栏布局，字典和 Key 分别独立搜索，不按普通／加密类型分组或标注类型。

```text
┌────────────────────┬─────────────────────────┐
│ 搜索字典…          │ 搜索 Key…               │
├────────────────────┼─────────────────────────┤
│ ▸ REX_COL_ENV      │ LOCAL_SECRET_ID         │
│   生产环境配置     │ LOCAL_SECRET_KEY        │
│   公共配置         │ API_URL                 │
└────────────────────┴─────────────────────────┘
```

- 左侧只按字典名称搜索，搜索覆盖所有分页；右侧只搜索当前字典的 Key。
- 未选字典时，右侧提示先选择字典；切换字典时清空 Key 搜索。
- 点击字符串 Key 即完成引用并关闭选择器，不再设置“引入”确认按钮。
- 连续配置其他凭据时优先定位上次使用的字典；点击已有引用可重新选择，清除后恢复手动输入。
- 字典禁用或不可用时禁止选择并显示原因；非字符串 Key 禁止选择并提示“仅支持字符串”。加载、失败重试、无搜索结果均有明确反馈。
- 仅展示字典名称和 Key，不展示值。引用仍保存稳定的 dictionaryId 和 key；普通字典由后端直接读取，加密字典在执行时由后端解密，不将解密明文返回前端或写入日志。读取或解密失败时明确报错，不自动回退。
- 使用紧凑字号、中性边框和独立滚动列表；支持浅色、深色、窄屏、长名称换行，以及 Tab、Enter／Space 和 Esc 键盘操作与可见焦点。

## 工具声明

新工具推荐在 execution.credentialSchema 中声明凭据的 JSON Schema。凭据根节点为 object，properties 最多 20 个字符串字段，additionalProperties 必须为 false；required 控制必填，长度、pattern 等限制在解析后校验。字段或父对象可声明 `"x-history": {"record": false}` 禁止记录手动值；未声明则允许记录。业务参数 parameters 使用相同策略，不根据字段名猜测。不要把真实凭据写进 Schema 的 default、enum、const 或工具代码。

旧 credentialInputs 继续兼容，自动转换为必填字符串字段，默认 `x-history.record: false`。下面是兼容声明：

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

新的声明示例：

```json
"credentialSchema": {
  "type": "object",
  "properties": {
    "ak": {"type": "string", "minLength": 1, "x-history": {"record": false}},
    "sk": {"type": "string", "minLength": 1, "x-history": {"record": false}},
    "label": {"type": "string"}
  },
  "required": ["ak", "sk"],
  "additionalProperties": false
}
```

旧的 execution.preprocess.credentials 字典映射继续可用，作为默认来源。使用 credentialSchema 时，旧声明、必填项和默认引用中的名称必须在 properties 中定义。只使用旧声明时，声明名称和默认映射中的名称均为必需凭据。显式调用绑定覆盖对应默认值；显式绑定解析失败不会回退。

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

两项都可以改成 dictionary 或 inline。每项只允许一个来源；未知名称、空值、缺失值和无效引用会失败。字典由既有内部解析器读取，接受可用的已启用普通或加密字典，仅支持字符串类型的键，不自动转换数字、布尔值或 JSON；敏感凭据建议使用加密字典，并沿用本机工作台访问边界；当前没有额外的多租户字典授权体系。

## 输入与安全边界

- 测试页提供来源切换、字典 ID/键输入及密码输入框，不将值放进 JSON args、工具定义或 Agent 上下文。
- 测试面板中的手动值在执行结束、切换工具或离开测试面板时清空，不写入 localStorage。历史中是否记录原值由 JSON Schema 的 x-history.record 决定；旧 credentialInputs 默认不记录。字典引用保留来源，永不保存解析后的值。JavaScript 内存清空不等于可保证物理内存擦除。
- API 绑定通过本机 HTTP 请求体传递，独立于普通 args；不是新的加密传输协议。外部调用方也必须自行避免在命令行、聊天、模型工具调用记录、代理日志中暴露明文。
- 服务端目前关闭请求日志，凭据只在调用局部解析，经子进程 stdin 注入；不进入进程命令行和继承环境。调用接口返回 Cache-Control: no-store；格式错误及底层异常使用不包含原始载荷的错误消息。
- 浏览器通道接收脚本生成的请求，不接收完整凭据绑定。经审阅的脚本仍有能力将秘密写入请求；必须只把业务协议所需信息发给受信目标，通常不应发送原始 SK。
- 原始凭据与敏感鉴权头继续参与响应回显检查。该检查不是任意编码、散列或恶意脚本的通用数据防泄露沙箱。
- 不在工具编写 Agent 对话中索取或填写真实 AK/SK。调用方若只有会记录明文的普通模型工具入口，不能直接用该入口传 inline 值，应使用测试页或可信客户端的独立秘密输入界面。

## 执行历史与还原

- 本机 `runtime/bridge-history.json` 原子持久化，文件权限 0600；最多保留 500 条，单工具展示最近 100 条。不进入配置 Git 快照。
- 新历史携带 formatVersion:2、执行时 parameters / credentialSchema 快照、工具定义摘要，以及 argSources / credentialSources。普通值记录原值，字典来源仅记录 `{source:"dictionary",dictionaryId,key}`；被禁止的手动值记录 `{source:"omitted",reason:"schema-policy"}`。
- 来源路径为 JSON Pointer：根节点为空字符串，`/user/password` 表示嵌套字段，`/items/0` 表示数组项；键中的 `/`、`~` 分别转义为 `~1`、`~0`。
- 对象中被省略的字段不保存原值；数组用 null 保留索引，并由来源元信息明确标为未记录。该 null 不能被当作历史原值自动执行，需要用户编辑相应数组参数。父级禁止记录时，子字段不能通过 record:true 覆盖；组合分支按更严格策略处理。
- 点击载入仅恢复参数及引用，不自动执行。未记录值按当前 Schema 补填；必填凭据缺失时阻止执行。字典引用重新读取当前已启用字典并检查字符串键和解密材料。
- 重新执行使用当前工具定义。定义变化会提示；保存工具、服务启动、配置恢复、读取历史时，会按当前更严格策略清除已保存值，已清除值不能因策略放宽而恢复。
- 旧历史没有来源信息时不能猜测字典来源；旧脱敏字符串被转为结构化占位，凭据提示来源未知、需要重新选择。无法恢复历史明文。

不涉及数据库表结构变更。
