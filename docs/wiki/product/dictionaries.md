# 字典与跨设备执行

普通字典保存字符串、数字、布尔值及 JSON；加密字典保存敏感字符串。保存产生不可变版本，后续新任务读取新的当前版本，已入队任务继续使用固定的旧版本。

## 在工作流和脚本中引用

工作流节点输入支持“普通字典”来源及 JSON Pointer，也支持嵌套 object/array Binding；最终结果可在高级 Binding 中引用普通字典。加密字典不能作为普通输入绑定。

内嵌 Node/Shell 和脚本编辑页的“字典依赖声明”按别名列出 ID、类型和键：

```json
{
  "service": { "dictionaryId": "<普通字典 UUID>", "kind": "plain", "keys": ["baseUrl"] },
  "credentials": { "dictionaryId": "<加密字典 UUID>", "kind": "encrypted", "keys": ["apiToken"] }
}
```

每个脚本最多 32 个别名、合计 256 个键，不支持通配符。固定脚本节点使用其所引用的不可变版本声明，不能在工作流节点上扩大访问范围。

Node.js 的默认导出函数接收第二个上下文参数：

```ts
export default async function run(input, ctx) {
  const baseUrl = ctx.dictionaries.get("service", "baseUrl");
  const token = ctx.secrets.get("credentials", "apiToken");
  const response = await fetch(baseUrl, { headers: { Authorization: `Bearer ${token}` } });
  return { ok: response.ok };
}
```

普通 JSON 值按副本返回；未声明的别名或键不能通过上下文读取。旧的单参数脚本继续兼容。

Shell 的 stdin 保留业务 JSON；宿主仅通过环境变量提供私有上下文和 helper 的路径：

```bash
"$ORCHARD_NODE_EXECUTABLE" "$ORCHARD_DICTIONARY_HELPER" plain service baseUrl
# 字符串原文：增加 --raw；敏感值请经 stdin 或私有文件传给外部程序，避免放入命令行。
```

## 敏感执行边界

声明加密字典的节点及其全部可达后继均为敏感范围：

- 隐藏输入、输出、stdout/stderr 和原始错误；只展示状态、耗时、退出码及固定字典版本等安全元数据。
- 真实值只在执行内存与私有尝试目录中流转；结果先校验再脱敏，不能用脱敏占位符代替后续计算。
- 最终结果引用敏感节点时整体隐藏，不能复制或下载原文；独立脚本测试采用相同策略。
- 敏感范围不能包含 Agent 或 Web Bridge；需要模型分析时应安排在读取凭据之前。
- 禁用字典不撤销已入队任务的旧绑定。需要立即吊销凭据时，取消任务并在外部服务撤销凭据。

这些是产品的数据访问与披露边界，不是恶意脚本沙箱；脚本仍以当前系统用户权限执行。

## Git 往返

通过“配置同步”备份工作流、固定脚本版本及字典依赖。普通字典导出定义值；加密字典只导出原密文，不导出密钥，也不因导出而重新加密。

另一台电脑先通过独立安全渠道导入密钥，再从远端获取、预览并应用配置。补齐本机接入后无需重建字典或重新编辑脚本即可执行。身份、不可变版本、密钥或认证冲突会阻止相关应用，不静默跳过。

详情见 [配置 Git 备份与恢复](../operations/config-git.md)及[实现验证记录](../../features/2026-11-10-remote-config-sync/implementation.md)。
