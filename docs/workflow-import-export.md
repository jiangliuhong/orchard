# Workflow Import/Export

Orchard 工作流包格式为 `orchard-workflow`，当前 `formatVersion` 为 `1`。包通过服务 API 或 CLI 传输，不暴露实例内部绝对路径。

## 包结构

```json
{
  "format": "orchard-workflow",
  "formatVersion": 1,
  "app": { "id": "orchard" },
  "workflow": { "id": "order-flow" },
  "version": { "id": "version-id", "number": 1, "manifest": {} },
  "files": {
    "source/worker.ts": {
      "sha256": "...",
      "contentBase64": "..."
    }
  },
  "integrity": {
    "fileTreeSha256": "..."
  }
}
```

`files` 至少包含 `source/worker.ts` 或 `worker.ts`。每个路径必须是规范化的相对路径，不能使用绝对路径、反斜杠、空路径、`.`、`..` 或符号链接逃逸。每个文件必须通过 SHA-256 校验，`fileTreeSha256` 按排序后的路径和文件摘要计算。

## 导入流程

1. 服务校验格式、身份、版本、路径、Base64、文件摘要和文件树摘要；
2. 将文件写入实例根目录下的临时目录；
3. 校验入口、依赖、能力和 manifest；
4. 将临时目录原子移动到 `artifacts/<app>/<workflow>/<version>`；
5. 在数据库事务中登记不可变版本并激活；
6. 若元数据事务失败，记录 orphan candidate，原激活版本保持不变。

导入包不得携带内部绝对路径，也不得直接在 API 主进程中 import 未验证的源码。

## 导出流程

导出当前或指定版本的定义、触发器、执行策略、manifest、源码和可选 bundle 元数据。导出结果只包含可移植路径、内容和摘要；导出过程不会修改正在运行的 Run。

CLI 和服务入口分别复用 `src/import-export` 的同一套校验逻辑，避免 CLI 绕过服务的安全边界。
