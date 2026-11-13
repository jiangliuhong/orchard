import { cpSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { DirectoryLease } from "../src/migrations/lock.js";
import { AGENT_RUNTIME_SCHEMA } from "../src/agent/schema.js";
import { AgentStore } from "../src/agent/store.js";
import { createKnowledgeManifest, installedKnowledgeDirectory, loadKnowledgeBundle } from "../src/agent/knowledge-bundle.js";
import { KnowledgeService } from "../src/agent/knowledge-service.js";
import { AgentKnowledgeInstallationHost } from "../src/agent/knowledge-store.js";

export function temporaryKnowledgeRoot(t: TestContext, beforeCleanup: () => void = () => {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orchard-knowledge-")));
  t.after(() => {
    beforeCleanup();
    // Test-owned read-only directories only; never follow any deliberately injected symlink.
    const writable = (path: string) => {
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (!info || info.isSymbolicLink() || !info.isDirectory()) return;
      chmodSync(path, 0o700);
      for (const child of readdirSync(path)) writable(join(path, child));
    };
    writable(root); rmSync(root, { recursive: true, force: true });
  });
  return root;
}
export function knowledgeFixture(t: TestContext) {
  let lease: DirectoryLease | undefined, db: DatabaseSync | undefined;
  const root = temporaryKnowledgeRoot(t, () => { db?.close(); if (lease && existsSync(join(lease.root, "workbench.lock"))) lease.release(); });
  const dataRoot = join(root, "data"), sourceRoot = join(root, "package-knowledge");
  mkdirSync(dataRoot, { mode: 0o700 });
  cpSync(resolve(installedKnowledgeDirectory()), sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "manifest.json"), loadKnowledgeBundle().manifestText);
  lease = DirectoryLease.acquire(dataRoot);
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE provider_settings(id TEXT NOT NULL PRIMARY KEY); INSERT INTO provider_settings VALUES('third-provider'); CREATE TABLE command_receipts(scope TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(scope,request_id));");
  db.exec(AGENT_RUNTIME_SCHEMA);
  const store = new AgentStore(db);
  let stop: (signal: AbortSignal) => Promise<void> = async () => {}, stops = 0;
  const host = new AgentKnowledgeInstallationHost(store, async signal => { stops++; signal.throwIfAborted(); await stop(signal); });
  const options = { dataRoot, sourceRoot, lease, host };
  const service = new KnowledgeService(options);
  const update = (version: string) => { writeFileSync(join(sourceRoot, "manifest.json"), JSON.stringify(createKnowledgeManifest(sourceRoot, version), null, 2) + "\n"); };
  return { root, dataRoot, sourceRoot, workspace: join(dataRoot, "agent/workspace"), staging: join(dataRoot, "agent/staging"), lease, db, store, host, service, options, update, stops: () => stops, setStop: (callback: typeof stop) => { stop = callback; } };
}
export function deferredKnowledge() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
export const knowledgeSignal = () => new AbortController().signal;
export const knowledgeTick = () => new Promise<void>(resolve => setImmediate(resolve));
