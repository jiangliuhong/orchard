# 字典与加密字典实施资料

状态：已完成编码。管理服务、HTTP API、页面、密钥 CLI、工作流／脚本引用、敏感执行与 Git v2 已接入；完整执行与同步验证见[远端同步实施记录](../2026-11-10-remote-config-sync/implementation.md)。

- [完整设计与验收门槛](./design.md)
- [实施记录与验证结果](./implementation-notes.md)
- [冻结结构审核记录](./schema-review-v9.md)
- [独立 v9 审核归档](./schema-approval-v9.json)

## 当前可使用的管理入口

启动本地工作台后，主导航进入“字典”创建普通或加密字典。普通条目可使用字符串、数字、布尔值和 JSON；加密条目只接收字符串。名称、说明、键名不保密，避免在这些字段填写凭据。

加密条目编辑时，默认保持原值。选中“替换”后填写新值，允许显式替换为空字符串；保存后输入清空。移除键不删除历史修订。禁用字典只改变后续引用可用性，不等同于撤销外部凭据。

“设置 → 加密字典密钥”提供生成、导入、备份、验证与切换活动密钥。首次生成后请下载备份；备份包含全部字典密钥，必须与 Git 仓库分开保管。切换活动密钥只影响后续新增或替换的值，字典详情中的“重新加密”可以为当前值创建新的密文修订。

引用查询扫描工作流／脚本的当前及历史版本、草稿和固定脚本间接依赖；遇到损坏定义会明确报告扫描不完整。加密依赖已支持执行，输入、输出、日志与敏感后继遵守[敏感执行边界](../../wiki/product/dictionaries.md)。

## 密钥 CLI

CLI 通过正在运行的本地 Orchard 服务操作密钥。使用与服务相同的 `--data-dir`；端口不是默认值时传入 `--server-url http://127.0.0.1:端口`。

```bash
orchard secrets keyring status --data-dir /path/to/data
orchard secrets keyring init --data-dir /path/to/data
orchard secrets keyring export --file /safe/location/keys.json --data-dir /path/to/data
orchard secrets keyring import --file /safe/location/keys.json --active-key-id <keyId> --data-dir /path/to/other-data
orchard secrets keyring verify --data-dir /path/to/other-data
orchard secrets keyring activate --key-id <keyId> --data-dir /path/to/data
```

导出只写入 0600 的新文件，不覆盖已有文件，不打印密钥材料。空密钥环导入必须明确选择活动密钥。备份文本不得放在命令行参数中，导入使用 `--file`。

## HTTP 调用边界

密钥变更、验证、下载和加密字典变更要求同源本地浏览器请求；无 Origin 的 API 客户端须提供有效 `x-orchard-token`。远程 Host、跨端口 Origin、扩展来源和不匹配的 Sec-Fetch-Site 均被拒绝。

管理 JSON 在转换对象前拒绝重复键及未转义控制字符。专用 `POST /api/secrets/export` 返回备份 JSON 正文并设置 attachment 与 no-store；其他管理响应均不包含密钥材料。密钥导入失败按错误码排查，响应不回显原始文本。
