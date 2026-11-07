# 配置恢复后的真实运行验收

本验收使用已构建的 dist 生产模块、真实回环 HTTP 监听、生产恢复服务和真实 Node.js 子进程。未使用 mocks、测试 Provider、远端仓库或模型请求；未修改 src。

复现命令（先准备生产 build，本脚本不会重新构建）：

```sh
node --import tsx tests/fixtures/config-git/runtime-verification.ts
```

每次运行使用 mkdtemp 创建独立数据目录，通过生产 Bootstrap 初始化并持有目录锁；创建生产 createApp，等待 app.ready 后监听 127.0.0.1 随机端口。启动、编译和脚本执行均使用真实实现。

恢复步骤使用编译后的 serializeSnapshot → parseSnapshot → ConfigRestoreService.preview → apply；不经过 Git 远端或 HTTP 恢复路由。本用例补充恢复后的执行能力验收，不替代既有 HTTP 恢复、传输及完整回归。快照包含固定版本脚本 restored-script-v1 和固定版本工作流 restored-workflow-v1；工作流先引用该脚本，再运行自己的 TypeScript 源码。

源码顶层只向临时目录追加执行标记，并完成加法/倍增。恢复完成后确认标记文件不存在、runs 和 script_tests 均为空，然后才显式发起以下真实 HTTP 请求：

- POST /api/scripts/restored-add/tests：{scriptVersionId:"restored-script-v1",input:{a:19,b:23},requestId:随机 UUID}。
- GET /api/scripts/restored-add/tests/:testId：轮询至 succeeded，断言 sum=42、exitCode=0。
- POST /api/workflows/restored-workflow/runs：{versionId:"restored-workflow-v1",input:{a:19,b:23},requestId:随机 UUID}。
- GET /api/runs/:runId：轮询至 succeeded，断言 sum=42、doubled=84、两个节点均成功。

额外校验三个执行标记的顺序、PID 与返回值一致，且为三个独立子进程，均不等于验收进程 PID。生产运行器自行编译源码并启动 Node 子进程；fixture 未替换编译器或进程执行器。

实际观测（PID、端口和运行 ID 每次执行不同）：

```json
{
  "time": "2026-11-06T16:22:04.190Z",
  "release": "e606078926724a7bb9fc6886741090e21e39049ca88e8ffc76abd13c1e0876f0",
  "node": "v24.19.0",
  "transport": "http://127.0.0.1:38127",
  "snapshotDigest": "70c81fdc3239f8ef0c016cfb081f568a489fa48de1088d5d6222c52f3ad241b7",
  "restorePhase": "completed",
  "beforeExecution": {
    "markerExists": false,
    "runs": 0,
    "scriptTests": 0
  },
  "script": {
    "id": "59380843-3ea7-4ec2-a5dd-40a78c6cdc04",
    "status": "succeeded",
    "output": {
      "sum": 42,
      "pid": 2657673
    },
    "exitCode": 0
  },
  "workflow": {
    "id": "3c5b0fd3-3cf6-451a-af4f-c0229b2c53df",
    "status": "succeeded",
    "output": {
      "sum": 42,
      "doubled": 84,
      "scriptPid": 2657695,
      "workflowPid": 2657734
    },
    "nodes": [
      {
        "id": "add",
        "status": "succeeded"
      },
      {
        "id": "double",
        "status": "succeeded"
      }
    ]
  },
  "executions": [
    {
      "kind": "script",
      "pid": 2657673
    },
    {
      "kind": "script",
      "pid": 2657695
    },
    {
      "kind": "workflow",
      "pid": 2657734
    }
  ],
  "routes": [
    "POST /api/scripts/restored-add/tests",
    "GET /api/scripts/restored-add/tests/59380843-3ea7-4ec2-a5dd-40a78c6cdc04",
    "POST /api/workflows/restored-workflow/runs",
    "GET /api/runs/3c5b0fd3-3cf6-451a-af4f-c0229b2c53df"
  ],
  "cleanup": "app closed; directory lease released; temporary data directory and execution markers removed"
}
```

清理：成功或失败均关闭 app、释放目录锁并删除全部临时数据；成功报告仅在清理完成且确认目录不存在后写出。没有外部服务或用户数据修改。
