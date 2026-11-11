#!/usr/bin/env node
// 独立的无模型生命周期假协议；仅操作测试分配 CODEX_HOME 下的 fixture-state.json。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.CODEX_HOME;
const file = join(home, "fixture-state.json");
const log = join(home, "fixture-log.jsonl");
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), home }) + "\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    const message = JSON.parse(line);
    appendFileSync(log, line + "\n");
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (message.method === "initialize") { send({ id: message.id, result: {} }); continue; }
    if (message.method === "initialized") continue;
    if (message.method === "thread/read") {
      const present = [...state.active, ...state.archived].includes(message.params.threadId);
      if (state.scenario === "read-invisible" && present) send({ id: message.id, result: { thread: { id: message.params.threadId } } });
      else if (state.scenario === "read-error") send({ id: message.id, error: { code: -32600, message: "storage permission denied" } });
      else if (state.scenario === "read-wrong-id") send({ id: message.id, result: { thread: { id: "other" } } });
      else send({ id: message.id, error: { code: -32600, message: `thread not loaded: ${message.params.threadId}` } });
      continue;
    }
    if (message.method === "thread/list") {
      if (state.scenario === "invalid-list") { send({ id: message.id, result: {} }); continue; }
      if (state.scenario === "list-error") { send({ id: message.id, error: { code: -32000, message: "private diagnostic" } }); continue; }
      if (state.scenario === "loop") { send({ id: message.id, result: { data: [], nextCursor: "same" } }); continue; }
      const data = (state.scenario === "read-invisible" ? [] : message.params.archived ? state.archived : state.active).map(id => ({ id }));
      send({ id: message.id, result: message.params.cursor === null ? { data: [{ id: "unrelated" }], nextCursor: "page2" } : { data, nextCursor: null } });
      continue;
    }
    if (message.method === "thread/delete") {
      if (state.scenario === "delete-error") { send({ id: message.id, error: { code: -32000, message: "attached resource secret" } }); continue; }
      if (state.scenario !== "delete-no-effect") {
        state.active = state.active.filter(id => id !== message.params.threadId);
        state.archived = state.archived.filter(id => id !== message.params.threadId);
        writeFileSync(file, JSON.stringify(state));
      }
      if (state.scenario !== "delete-lost-response") send({ id: message.id, result: {} });
      continue;
    }
    send({ id: message.id, error: { code: -32601, message: "only lifecycle methods allowed" } });
  }
});
