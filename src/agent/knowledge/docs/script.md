# 脚本维护

## 固定范围和输出
在 project.json 查找固定草稿，从其目录读取 script.json 和 src/ 下的源码。提交 change: {operation: "replace", definition: {...}}，definition 包含完整脚本定义及 files 路径到源码的映射。保留仍需的文件、元数据和字典绑定，保持 id 和 runtime。通过 mcp__orchard__submit_proposal 提交，原样使用宿主的 target 和 baseline。

files 使用版本内相对路径，去掉投影目录的 src/ 前缀。目录段使用 ASCII 字母、数字、_、-，文件名允许 .，路径不得含 ..。Node 文件为 .ts/.js/.mjs，Shell 为 .sh。最终 1–100 个文件、每文件最多 1 MiB、总计最多 4 MiB，entryFile 必须存在。

## Node.js
Node.js 24 使用 esbuild 打包 ESM。导出 default async function run(input, ctx)，返回 JSON 可序列化值，不要返回 JSON.stringify 的结果或 BigInt/循环对象。不要自行读 stdin、启动服务或 process.exit；console 输出是日志。

只允许 Node 内置模块和最终文件树中的完整相对导入，扩展名精确匹配；无 npm、package.json、tsconfig 或宿主文件导入。resultMode 为 json，不可设为 process。生成网络代码时需有真实端点证据并处理非成功响应；维护 Agent 本身不发请求。

## Shell
宿主用 /bin/bash 执行入口，stdin 是可能没有末尾换行的 JSON；用 cat 读完整输入，不能在 set -e 下假定 read -r 总会成功。引用路径/变量。执行环境不继承用户 Shell 或凭据，不假定 jq/python/curl/npm 已安装。

JSON 处理使用 ORCHARD_NODE_EXECUTABLE 的 Node 内置能力。process 模式输出为 {stdout,stderr,exitCode}；json 模式必须向 ORCHARD_RESULT_FILE 写入一个合法 JSON 值，stdout 仍是日志。非零退出码会失败。

## Schema、测试与字典
输入输出 Schema 必须与源码和 resultMode 一致，使用宿主 strict Ajv 接受的 JSON Schema；不引入 $async、$data 或未解析外部引用。输入界面支持明确类型、properties/required/items、标量 enum；字符串 x-ui.widget 可为 input/textarea，textarea rows 为 2–30。

x-history:{record:false} 继承拒绝记录，不能通过子节点放宽。测试由用户在平台发起。

dictionaryBindings 是完整依赖映射替换，保留仍需的别名和键。仅使用宿主列出的真实 dictionaryId/kind/keys，不能查询值。Node 使用 ctx.dictionaries.get 或 ctx.secrets.get；Shell 使用受控 ORCHARD_DICTIONARY_HELPER。不要读取背后上下文文件或返回/记录密钥。显示令牌 {{dictionary:...}} 不是业务输入，不能写入源代码或默认值。
