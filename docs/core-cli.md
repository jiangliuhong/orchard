# `core.cli`

`core.cli` is the Workflow node for invoking a registered local CLI tool.

## Boundary

A Workflow supplies only a `toolId` and tool input:

```ts
await ctx.step.execute("read-report", {
  type: "core.cli",
  config: { toolId: "local.report" },
  input: { date: "2026-09-24" },
});
```

The Workflow cannot supply an arbitrary executable, shell command, working directory,
or environment. A trusted application registration supplies those values and builds an
argument array. The implementation always uses `shell: false`.

## Tool registration

```ts
registry.register({
  id: "local.report",
  version: "1",
  executable: "/usr/local/bin/report-cli",
  sideEffects: "read_only",
  timeoutMs: 30_000,
  maxOutputBytes: 2 * 1024 * 1024,
  buildArgs: (input) => ["--date", input.date],
  parseOutput: (result) => JSON.parse(result.stdout),
});
```

A tool may validate its input and output. Its timeout and output limit are upper
bounds; a Workflow run may only make them smaller.

## Process behavior

- stdout and stderr are captured separately and streamed through `onLog`.
- A non-zero exit code produces `PROCESS_FAILED` and preserves captured output.
- Timeout produces `PROCESS_TIMEOUT`.
- AbortSignal cancellation produces `PROCESS_CANCELLED`.
- Combined stdout/stderr output above the limit produces `OUTPUT_LIMIT_EXCEEDED`.
- Unix children are started in their own process group and the group is terminated on
  cancellation, timeout, or output overflow.

This first implementation deliberately does not provide authentication or authorization.
It is an application integration boundary, not a security sandbox. The executable and
its registration are trusted; run input cannot replace them.

## Fixture CLI

`tests/fixtures/cli-fixture.mjs` is only a test executable. It simulates success,
failure, delay, and oversized output. It verifies `core.cli` behavior without invoking
real business commands and is not registered as a production tool.
