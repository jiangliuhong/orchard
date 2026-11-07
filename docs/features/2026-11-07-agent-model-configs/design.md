# Agent 模型配置与工作流动态引用

状态：已完成；产品方案及本文数据库结构已获用户审核通过。
创建日期：2026-11-07。
最后更新：2026-11-07。

## 目标与已确认范围

用户创建具名的 Agent 模型配置，例如「xxx 分析」对应 Codex CLI 和一个明确模型。工作流引用稳定的配置 ID，后续只需修改配置，新创建的运行即使用新的模型，无需修改或重新发布工作流。

- 设置新增「Agent 模型配置」，支持新增、编辑、启用、禁用及引用查询。
- 工作流默认 Agent 配置、Agent 节点统一引用 `agentConfigId`。
- 节点未指定配置时，继承工作流默认配置；不分别继承或覆盖 Provider、模型。
- 工作流配置删除直接绑定的 `providerId`、`modelId`，不提供旧工作流转换、自动映射或兼容运行分支。
- 不修改、清理或重写已有工作流和历史运行数据；旧格式不作为新版工作流的有效输入。
- 工作流创作对话、脚本创作对话仍直接选择 Provider、模型，保留其现有会话契约。
- 提示词、超时、输入输出 Schema 仍属于工作流节点，不放入模型配置。
- 第一版不提供删除配置、自动切换模型、自动故障转移和固定配置修订的工作流选择项。

数据库结构已按[仓库规则](../../../AGENTS.md)获用户审核通过。下文保留已审核结构及实施约定。

## 用户流程与界面

### 设置

「设置 → Agent 模型配置」列表显示名称、说明、Provider、模型、启用状态、当前修订、工作流引用数。编辑表单只允许选择已启用的 Provider 和模型；模型 ID 必须明确，不能使用 Provider 的默认模型作为隐式回退。

列表区分配置自身禁用与底层 Provider、模型不可用。修改名称不影响引用；修改绑定、名称、说明或启用状态都创建新修订。保存前展示引用范围，说明只影响后续新运行。编辑使用 `expectedRevision` 防止覆盖其他页面的修改。

同名配置不允许创建；名称在服务端去除首尾空白。列表名称按 SQLite `NOCASE` 规则唯一。

### 工作流编辑

工作流「Agent 默认配置」改为选择一个模型配置，下面展示它当前对应的 Provider、模型和修订。Agent 节点可选「继承工作流默认配置」或指定另一项配置。

选择列表隐藏禁用的配置，不自动替换已有的失效引用。已引用的配置被禁用或底层模型不可用时，展示原名称及原因，要求用户修复配置或重新选择。

工作流配置示例：

```json
{
  "defaults": {
    "agent": {
      "agentConfigId": "analysis-config-id"
    }
  }
}
```

节点覆盖示例：

```json
{
  "config": {
    "agentConfigId": "classification-config-id",
    "prompt": "判断输入内容的分类",
    "timeoutMs": 120000
  }
}
```

同一层级不接受 `providerId`、`modelId`。节点没有配置 ID 且工作流没有默认 ID 时，该 Agent 节点校验不通过。不含 Agent 节点的工作流不强制设置默认配置。

### 运行详情

每个 Agent 节点展示创建运行时保存的配置名称、配置修订、Provider、模型。历史名称从历史修订读取，不随改名变化。

底层 Provider 的实际调用信息、实际模型和用量继续记入节点执行记录。运行快照不包含凭证、完整连接配置或后端会话引用。

## 生效、快照与并发规则

1. 保存草稿允许暂时无效，沿用现有校验诊断；发布必须验证所有实际使用的配置存在、已启用，且具体 Provider、模型可用。
2. 发布保留配置 ID，不再调用现有 `ProviderRegistry.freeze()` 把具体模型写入工作流定义。
3. 新建已发布工作流运行及草稿测试时，在入队事务中统一读取配置、解析每个 Agent 节点并写入运行绑定；所有节点共享该事务看到的配置状态。同一配置在同一次运行中不能对应多个修订。
4. 模型配置、底层 Provider 或模型无效时，入队失败，不产生部分运行或部分节点绑定。结构存在但本机连接不可达时，沿用运行阶段的连接检测和错误报告。
5. 已排队和执行中的运行只从运行绑定读取 Provider、模型，禁止根据配置的最新修订重新解析。配置更新、禁用后只阻止新的运行绑定，不改写已创建的绑定。
6. 底层 Provider 或模型若在运行创建后被禁用、删除，执行时仍遵守现有可用性检查并明确失败，不绕过禁用状态。连接不可达同样明确失败。
7. Provider 的连接参数不随模型配置一起冻结。绑定记录创建时的 Provider 修订；执行记录保存实际调用时的 Provider 修订，便于区分后续连接设置变动。
8. 幂等请求先命中已有 `command_receipts`，返回原运行；不能先读取最新配置或因最新配置失效而拒绝已有的成功请求。
9. 用户重新发起运行会使用最新配置；历史运行查看与原幂等请求重试使用原绑定。
10. 草稿测试仍保存工作流文件和脚本编译产物快照；模型绑定独立入库，不向快照内的工作流定义注入旧格式字段。

## 数据库审核提案

实施前数据库版本为 7，已新增 v7 → v8 增量迁移，并同步新建数据库定义。

本次只新增三张表及相关索引，不重建或扩列现有业务表。复用现有 `provider_settings`、`runs`、`node_runs`、`command_receipts` 及 `node_attempts.execution_json`。

### 1. 当前模型配置：`agent_model_configs`

```sql
CREATE TABLE agent_model_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE
    CHECK(length(trim(name)) BETWEEN 1 AND 100),
  description TEXT NOT NULL DEFAULT ''
    CHECK(length(description) <= 2000),
  provider_id TEXT NOT NULL REFERENCES provider_settings(id),
  model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX agent_model_configs_by_provider
  ON agent_model_configs(provider_id);
```

`id` 由系统生成，修改名称不修改 ID。当前配置服务查询与编辑，启用和禁用统一通过更新接口处理。

模型目录目前保存在 `provider_settings.models_json`，不是独立模型表，因此 `model_id` 由服务端验证归属和启用状态，不创建无对应目标的模型外键。

### 2. 不可变修订：`agent_model_config_revisions`

```sql
CREATE TABLE agent_model_config_revisions (
  config_id TEXT NOT NULL REFERENCES agent_model_configs(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK(length(description) <= 2000),
  provider_id TEXT NOT NULL REFERENCES provider_settings(id),
  model_id TEXT NOT NULL CHECK(length(trim(model_id)) BETWEEN 1 AND 200),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(config_id, revision)
);
```

创建配置时，同时插入当前记录和修订 1。每次更新使用乐观锁，在同一事务中更新当前记录并插入新修订；任一操作失败全部回滚。当前记录必须与对应修订一致，由存储服务统一维护。

历史修订不提供修改和删除接口，不保存连接密钥。禁用操作也新增修订，保留先前运行引用的历史绑定。

### 3. 每次运行的节点绑定：`run_agent_bindings`

```sql
CREATE TABLE run_agent_bindings (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  config_id TEXT NOT NULL,
  config_revision INTEGER NOT NULL CHECK(config_revision > 0),
  provider_revision INTEGER NOT NULL CHECK(provider_revision > 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, node_id),
  FOREIGN KEY(run_id, node_id)
    REFERENCES node_runs(run_id, node_id) ON DELETE CASCADE,
  FOREIGN KEY(config_id, config_revision)
    REFERENCES agent_model_config_revisions(config_id, revision)
);
CREATE INDEX run_agent_bindings_by_config
  ON run_agent_bindings(config_id, config_revision);
```

现有 `node_runs` 已有 `UNIQUE(run_id,node_id)`，可作为复合外键目标。先创建运行和节点记录，再插入 Agent 节点绑定，全部在同一事务中提交。

通过历史修订获得当次配置名称、说明、Provider 和模型，不再重复存储同一组字段。每个 Agent 节点必须恰好一条绑定，非 Agent 节点不写绑定；该业务约束由创建运行的统一路径验证。

删除工作流及其运行时，跟随 `node_runs` 删除绑定。数据库启用外键约束；现有数据清理入口需要纳入回归测试。历史配置和修订继续保留。

### 升级与数据范围

- 迁移只执行上述建表及索引操作，再更新数据库版本。
- 迁移前复用现有完整备份、事务、完整性及外键检查。
- 三张新表初始为空；不读取旧工作流生成配置，不改写旧草稿、版本文件、节点执行信息。
- 不删除历史数据，不清空 Provider，不自动启用 Provider 或模型。
- 失败时回滚；降级需使用对应版本程序及升级前备份。
- 结构变更沿用 `src/persistence/schema.ts` 中已审核的 v7 → v8 SQL，注册到显式迁移向导，预览并确认后在备份副本实施；Store 不执行隐式升级。测试使用独立临时数据目录，不直接操作用户运行中的数据库。
- v6 发布清单与原审核归档保持不变，历史迁移标识和校验值保留；v7、v8 和 v8 初始化使用补充归档，发布包单独锁定当前执行代码，已有迁移账本仍可验证。
- Git 配置快照将具名模型配置随其 Provider 保存；恢复保留配置 ID，产生本地新修订，不复制运行绑定或历史执行。恢复工作流时验证其具名配置引用。

## 接口提案

| 接口 | 行为 |
| --- | --- |
| `GET /api/agent-model-configs` | 查询配置、当前可用性与引用摘要，支持启用状态筛选 |
| `POST /api/agent-model-configs` | 创建配置及首个修订，支持 `requestId` |
| `GET /api/agent-model-configs/:id` | 配置详情 |
| `PATCH /api/agent-model-configs/:id` | 修改名称、说明、绑定或启用状态，要求 `expectedRevision` 和 `requestId` |
| `GET /api/agent-model-configs/:id/references` | 返回引用该配置的草稿和已发布版本，注明是否为工作流当前发布版本 |

引用数按工作流去重，草稿引用单独统计，不能将「几个节点」「几个版本」「几个工作流」混算。禁用配置仍显示引用。第一版不新增删除、回滚或修订固定接口；用户可通过编辑将绑定改回原模型，并产生新修订。

运行详情接口补充每个 Agent 节点的模型配置绑定信息，保持输入输出和脚本执行接口不变。新增配置接口复用现有请求校验、错误格式和命令回执机制。

## 实施边界

数据库审核通过后按以下顺序实施：

1. 数据库 v8、新建库定义、存储方法、原子修订与幂等操作。
2. 配置服务和 API，Provider、模型归属及启用校验，引用查询。
3. 工作流领域契约、JSON Schema、Agent 创作提示和生成约束、示例与测试夹具改为配置 ID。
4. 发布验证、运行创建、草稿测试和节点执行统一使用运行绑定。
5. 设置页模型配置管理，工作流默认配置及节点继承选择器，运行详情展示。
6. 验证全部流程，更新正式 Wiki 和实施状态。

`AgentChoice` 仍用于创作对话和底层 Provider 调用；工作流使用独立的配置引用类型，避免将对话会话和工作流绑定混为同一个接口。

## 验收标准

- 同一模型配置可以被多个工作流、多个 Agent 节点引用。
- 工作流定义仅包含配置 ID；Agent 节点直接携带 Provider 或模型时校验失败。
- 修改、改名模型配置不修改工作流版本和内容哈希；新运行使用新修订。
- 节点覆盖优先于工作流默认配置；缺少有效继承来源时明确诊断。
- 在一次运行创建后修改配置，其尚未执行的节点仍使用创建时修订；排队运行亦如此。
- 一次运行内多个节点引用同一配置时使用同一修订。
- 草稿测试与已发布运行使用同一绑定规则，不在文件中保存直接模型绑定。
- 禁用配置、禁用 Provider、禁用或删除模型时不自动回退；新建运行失败原因清晰。
- 原幂等请求在配置更新、禁用后仍返回原运行，不产生新快照。
- 节点成功、失败和跳过时均可从运行绑定追踪创建时选择。
- 配置编辑冲突返回冲突错误，不覆盖他人修改；修订写入失败不留下半更新记录。
- 删除运行不会留下悬空的节点绑定，历史配置修订不因删除工作流而消失。
- 工作流和脚本创作对话、模型验证继续使用原有 Provider 与模型选择。
- 数据库升级只新增表和索引；不迁移、转换或删除旧工作流。
- 完成领域、存储、服务、API、运行和界面回归，以及类型检查和生产构建。

## 当前实施状态

已实现 v8 结构及增量迁移、配置与修订服务、配置 API、工作流引用校验、运行节点绑定、配置管理界面、工作流选择器及运行信息展示。

## 验证结果

2026-11-07：

- `npm run typecheck` 通过。
- `npm test` 全部 249 项通过；本地 HTTP/SSE 测试在允许监听本地端口的环境下执行。
- `npm run build` 通过，Monaco 产物仍有现有的大块资源提示。
- `git diff --check` 和本次涉及文档的相对链接检查通过。
- [模型配置专项测试](../../../tests/agent-model-configs.test.ts)覆盖配置校验、命令幂等、名称冲突、编辑冲突、修订写入失败的事务回滚、直接模型引用拒绝、运行中与排队绑定、草稿节点覆盖、底层 Provider 禁用、绑定随运行删除、v7 → v8 升级和配置 API。
- [界面测试](../../../tests/interface.test.ts)覆盖新增、编辑、禁用、引用链接、节点继承及失效选择保留、工作流默认配置 ID 保存、历史运行模型信息展示。
- 测试使用临时数据目录和模拟 Provider；没有启动付费模型请求，没有重启用户运行中的服务或直接升级其数据库。应用服务重启并载入新版本后，旧数据库进入迁移向导，确认后备份并升级至 v8。
