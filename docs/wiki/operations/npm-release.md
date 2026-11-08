# npm 自动发布

适用于 `@jarome/orchard`。最后更新：2026-11-08。

## 首次配置

工作流位于 [npm-publish.yml](../../../.github/workflows/npm-publish.yml)，使用 GitHub 托管的 Ubuntu Runner、Node.js 24 和 npm Trusted Publishing（OIDC）。无需设置 `NPM_TOKEN`。

在 npm 网站登录有包管理权限的账号，进入 `@jarome/orchard` 的 Settings，添加 GitHub Actions Trusted Publisher：

| 字段 | 值 |
| --- | --- |
| Organization or user | `jiangliuhong` |
| Repository | `orchard` |
| Workflow filename | `npm-publish.yml` |
| Environment | 留空，工作流没有指定 environment |

如果 npm 页面显示发布权限选项，需允许该 Trusted Publisher 直接发布包。配置要求以 [npm 官方文档](https://docs.npmjs.com/trusted-publishers/) 为准。GitHub 仓库所有者是 `jiangliuhong`，npm 包所有者是 `jarome`，两者不要混填。

在 GitHub 仓库设置中启用 Actions。建议为 `v*` 设置 Tag ruleset，限制版本 Tag 的创建、更新和删除权限。

## 发布新版本

已发布的 `0.0.1` 不重复发布。下次先将 `package.json` 的版本改为 `0.0.2`，完成该版本全部源码修改，再执行：

```bash
node scripts/lock-migration-release.mjs --refresh-unpublished
npm run migration:check
npm run typecheck
npm test
npm run build
```

完整性锁会记录 `package.json`、源码、脚本和锁文件等内容。将本次版本的代码与生成的 `migration-manifest.json`、`src/migrations/frozen.ts` 一并审核、提交并推送，之后对该提交创建 Tag：

```bash
git tag -a v0.0.2 -m "Release 0.0.2"
git push origin v0.0.2
```

仅支持 `v主版本.次版本.修订版本` 正式版本，必须与 `package.json` 一致。其他 `v*` Tag 会触发工作流但在版本检查时失败。分支推送不触发发布。

刷新发布锁只针对尚未发布的新版本，不能覆盖已经发布的版本身份；数据库表结构变更仍须先审核。CI 不刷新发布锁，也不自动修改版本或提交文件。

## 流水线与验证

构建任务依次完成版本检查、锁定依赖安装、迁移完整性校验、类型检查、测试、构建和打包；任何一步失败都会阻止发布。

构建产物保存为 `npm-package` artifact，包括 `.tgz`、打包清单和 SHA-256 校验文件，保留 14 天。发布任务下载并验证该安装包后直接发布，不重新安装项目依赖或构建。OIDC 权限只授予发布任务，所有版本共用发布并发组，避免取消正在执行的发布。

在 GitHub Actions 的 `Publish to npm` 查看任务结果，发布完成后验证：

```bash
npm view @jarome/orchard@0.0.2 version --registry=https://registry.npmjs.org/
npm exec --yes --package=@jarome/orchard@0.0.2 -- orchard --help
```

## 故障处理

- Tag 与版本不一致：修正下一个未发布版本的准备流程，重新提交并创建正确 Tag。
- 完整性检查失败：在本地完成改动后刷新未发布版本的发布锁，验证并提交；CI 不绕过审核或自动修复。
- 测试或构建失败：先修复失败项，再发布；不跳过检查。
- OIDC 认证失败：核对 npm Trusted Publisher 的仓库所有者、仓库名、工作流文件名及直接发布权限，确认使用 GitHub 托管 Runner。
- 版本已存在：先确认 npm 上的版本是否已成功发布；已存在的版本不能覆盖，不将该错误视为成功，也不在 CI 自动递增版本。
- 其他临时故障：修复外部配置后可以重跑失败任务；如果对应版本已发布，不重复执行发布。
