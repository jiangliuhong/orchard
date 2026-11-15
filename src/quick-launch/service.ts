import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AppError, check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import { canonicalJson, digest, json } from "../persistence/files.js";
import { configCoordinator } from "../config-git/coordinator.js";
import type { Store } from "../persistence/store.js";
import type { GraphRunner } from "../runtime/runner.js";
import type { ScriptTestRunner } from "../runtime/script-tests.js";
import type { WebBridgeGateway } from "../web-bridge/gateway.js";
import { checkInput, QuickLaunchTargets, resolveInput, isSensitiveField, type InputSources, type Target } from "./targets.js";

export type CardInput = { name: string; note: string; groupId: string | null; target: unknown; fixedInput: unknown; inputSources: unknown; requestId: string };
type CardRow = { id: string; name: string; note: string; group_id: string | null; target_json: string; fixed_input_json: string; input_sources_json: string; revision: number; updated_at: number };
type Execution = { id: string; status: string; underlying_kind: string | null; underlying_id: string | null; request_digest: string; privacy_policy: string; last_event_sequence: number };
type Start = { revision: number; requestId: string; confirmationToken?: string };
const active = ["accepted", "queued", "running", "cancel_requested", "unknown"];

export class QuickLaunchService {
  readonly targets: QuickLaunchTargets;
  private readonly key = randomBytes(32);
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly volatileInputs = new Map<string, unknown>();
  private readonly completions = new Map<string, { status: string; error?: unknown; claim?: string }>();
  private readonly calls = new Map<string, { cancel: AbortController; done: Promise<void> }>();

  constructor(private readonly store: Store, private readonly runner: GraphRunner, private readonly scripts: ScriptTestRunner,
    private readonly bridge: WebBridgeGateway, private readonly readDictionary: (id: string, key: string, sensitive: boolean) => unknown) {
    this.targets = new QuickLaunchTargets(store, bridge);
  }

  listTargets() { return this.targets.list(); }

  recover() {
    this.reconcile();
    this.store.exec(`UPDATE execution_records SET status='interrupted',ended_at=?,last_event_sequence=last_event_sequence+1
      WHERE status='accepted' AND underlying_kind IS NULL`, Date.now());
    this.reconcileBridge(true);
  }

  startWorker() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref();
  }

  private tick() {
    if (this.stopped) return;
    try {
      configCoordinator(this.store).assertAvailable();
      this.reconcile();
      this.reconcileBridge(false);
      if (this.calls.size === 0) this.dispatchNextBridge();
    } catch (error) {
      if (!(error instanceof AppError && error.code === "CONFIG_BUSY"))
        console.warn("快捷执行后台处理暂未完成，将重试");
    }
  }

  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const call of this.calls.values()) call.cancel.abort();
    await Promise.allSettled([...this.calls.values()].map(call => call.done));
    this.volatileInputs.clear();
    this.completions.clear();
  }

  private settleBridge(id: string, status: string, error?: unknown, claim?: string) {
    this.completions.set(id, { status, error, claim });
    this.flushCompletion(id);
  }

  private flushCompletion(id: string) {
    const result = this.completions.get(id);
    if (!result) return;
    try {
      this.finish(id, result.status, result.error, result.claim);
      this.completions.delete(id);
    } catch {
      // Retry the result write without dispatching the tool again.
    }
  }

  private reconcileBridge(restarted: boolean) {
    for (const id of this.completions.keys()) this.flushCompletion(id);
    const now = Date.now();
    this.store.transaction(() => {
      const rows = this.store.all<{ id: string; state: string; lease_until: number | null; snapshot_ref: string }>(
        `SELECT e.id,e.snapshot_ref,o.state,o.lease_until FROM execution_records e JOIN execution_outbox o ON o.execution_id=e.id
         WHERE e.underlying_kind='bridge_call' AND e.status IN ('queued','running','cancel_requested')
         AND o.operation='dispatch' AND o.state<>'settled'`);
      const uncertain = this.store.all<{ id: string }>("SELECT id FROM execution_records WHERE underlying_kind='bridge_call' AND status='unknown'");
      for (const row of uncertain) {
        const proof = this.bridge.history.outcome(row.id);
        if (proof) this.store.exec(`UPDATE execution_records SET status=?,ended_at=?,last_event_sequence=last_event_sequence+1
          WHERE id=? AND status='unknown'`, proof.status, proof.endedAt, row.id);
      }
      for (const row of rows) {
        if (this.calls.has(row.id) || this.completions.has(row.id)) continue;
        if (row.state === "dispatching") {
          const proof = this.bridge.history.outcome(row.id);
          if (proof) this.finish(row.id, proof.status);
          else if (restarted || (row.lease_until !== null && row.lease_until <= now)) this.finish(row.id, "unknown");
          continue;
        }
        if (!restarted && (row.state !== "claimed" || row.lease_until === null || row.lease_until > now)) continue;
        const snapshot = this.store.dereference(row.snapshot_ref) as { inputSources: InputSources };
        if (Object.keys(snapshot.inputSources ?? {}).length && !this.volatileInputs.has(row.id)) this.finish(row.id, "interrupted");
        else this.store.exec(`UPDATE execution_outbox SET state='pending',claim_token=NULL,lease_until=NULL,updated_at=?
          WHERE execution_id=? AND operation='dispatch' AND state='claimed'`, now, row.id);
      }
    });
  }

  private dispatchNextBridge() {
    const now = Date.now(), claim = randomUUID();
    const task = this.store.transaction(() => {
      const row = this.store.one<{ taskId: string; id: string; snapshot_ref: string }>(`SELECT o.id AS taskId,e.id,e.snapshot_ref
        FROM execution_outbox o JOIN execution_records e ON e.id=o.execution_id
        WHERE o.operation='dispatch' AND o.state='pending' AND e.status='queued' AND e.underlying_kind='bridge_call'
        ORDER BY o.created_at,o.id LIMIT 1`);
      if (!row) return;
      if (this.store.exec(`UPDATE execution_outbox SET state='claimed',attempts=attempts+1,claim_token=?,lease_until=?,updated_at=?
        WHERE id=? AND state='pending'`, claim, now + 30_000, now, row.taskId).changes !== 1) return;
      return row;
    });
    if (!task) return;
    let target: Extract<Target, { kind: "browser_tool" }>, input: unknown, approved: boolean;
    try {
      const snapshot = this.store.dereference(task.snapshot_ref) as { target: Target; fixedInput: unknown; inputSources: InputSources; confirmation: boolean };
      const contract = this.targets.contract(snapshot.target);
      check(contract.target.kind === "browser_tool", "INVALID_TARGET", "运行目标无效");
      target = contract.target;
      approved = snapshot.confirmation;
      check(!contract.confirmation || approved, "CONFIRMATION_REQUIRED", "运行缺少确认");
      if (Object.keys(snapshot.inputSources).length) {
        if (!this.volatileInputs.has(task.id)) { this.finish(task.id, "interrupted", undefined, claim); return; }
        input = this.volatileInputs.get(task.id);
      } else input = snapshot.fixedInput;
      assertSchema(input, contract.schema, "运行参数");
    } catch (error) {
      this.volatileInputs.delete(task.id);
      this.finish(task.id, "start_failed", error, claim);
      return;
    }
    const ready = this.store.transaction(() => {
      if (this.store.exec(`UPDATE execution_outbox SET state='dispatching',lease_until=?,updated_at=?
        WHERE id=? AND state='claimed' AND claim_token=? AND lease_until>?`,
        Date.now() + target.timeoutMs + 30_000, Date.now(), task.taskId, claim, Date.now()).changes !== 1) return false;
      check(this.store.exec("UPDATE execution_records SET status='running',started_at=? WHERE id=? AND status='queued'",
        Date.now(), task.id).changes === 1, "DISPATCH_CONFLICT", "运行状态已变化");
      return true;
    });
    if (!ready) return;
    this.volatileInputs.delete(task.id);
    const cancel = new AbortController();
    let dispatched = false;
    const done = this.bridge.call(target.applicationId, target.toolId, input, {
      requestId: task.id, environmentId: target.environmentId ?? undefined, timeoutMs: target.timeoutMs, approved,
      signal: cancel.signal, credentialBindings: target.credentialBindings, omitHistoryArgs: true, skipLegacyHistory: true, onDispatch: () => { dispatched = true; }
    }).then(() => this.settleBridge(task.id, "succeeded", undefined, claim),
      error => this.settleBridge(task.id, dispatched ? "unknown" : "start_failed", error, claim)).finally(() => this.calls.delete(task.id));
    this.calls.set(task.id, { cancel, done });
  }

  list(query: { q?: string; field?: string; groupId?: string; includeDescendants?: string; type?: string; availability?: string; sort?: string; cursor?: string; limit?: string } = {}) {
    this.reconcile();
    const groups = new Map(this.store.all<{ id: string; name: string; parent_id: string | null }>(
      "SELECT id,name,parent_id FROM quick_launch_groups").map(group => [group.id, group]));
    const tokens = query.q?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const cards = this.store.all<CardRow>("SELECT * FROM quick_launches ORDER BY name,id").map(row => this.card(row)).filter(card => {
      const path: string[] = [], ancestors = new Set<string>();
      for (let id = card.groupId; id && !ancestors.has(id);) {
        ancestors.add(id);
        const group = groups.get(id);
        if (!group) break;
        path.unshift(group.name);
        id = group.parent_id;
      }
      if (query.groupId === "ungrouped" ? card.groupId !== null : query.groupId && query.groupId !== "*" &&
          (query.includeDescendants === "false" ? card.groupId !== query.groupId : !ancestors.has(query.groupId))) return false;
      if (query.type && query.type !== card.target.kind) return false;
      if (query.availability && card.available !== (query.availability === "yes")) return false;
      const fields: Record<string, string> = { name: card.name, note: card.note, group: path.join(" / ") };
      const values = query.field && Object.hasOwn(fields, query.field) ? [fields[query.field]] : Object.values(fields);
      return tokens.every(token => values.some(value => value.toLowerCase().includes(token)));
    });
    if (query.sort === "recent") cards.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    if (query.cursor === undefined && query.limit === undefined) return { items: cards, total: cards.length, nextCursor: null };
    const offset = Number(query.cursor ?? 0), limit = Number(query.limit ?? 50);
    check(Number.isSafeInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit >= 1 && limit <= 100,
      "INVALID_CURSOR", "分页参数无效");
    return { items: cards.slice(offset, offset + limit), total: cards.length,
      nextCursor: offset + limit < cards.length ? String(offset + limit) : null };
  }

  get(id: string) {
    return this.card(this.requireCard(id));
  }

  private requireCard(id: string) {
    const row = this.store.one<CardRow>("SELECT * FROM quick_launches WHERE id=?", id);
    check(row, "NOT_FOUND", "快捷启动不存在", 404);
    return row;
  }

  private card(row: CardRow) {
    const target = JSON.parse(row.target_json) as Target;
    let available = true, confirmation = false;
    try { confirmation = this.targets.contract(target).confirmation; } catch { available = false; }
    const inputSources = JSON.parse(row.input_sources_json) as InputSources;
    const needsReferenceUpdate = Object.values(inputSources).some(ref => ref?.source !== "dictionary");
    if (needsReferenceUpdate) available = false;
    const recent = this.store.one<Execution>("SELECT id,status FROM execution_records WHERE launch_id=? ORDER BY accepted_at DESC,id DESC LIMIT 1", row.id);
    return { id: row.id, name: row.name, note: row.note, groupId: row.group_id, target, fixedInput: JSON.parse(row.fixed_input_json),
      inputSources, needsReferenceUpdate, revision: row.revision, updatedAt: row.updated_at, available, confirmation, recent };
  }

  save(id: string | null, input: CardInput & { revision?: number }) {
    const name = input.name.trim();
    check(name.length > 0 && Array.from(name).length <= 80 && Array.from(input.note).length <= 500, "INVALID_CARD", "名称或备注长度无效");
    const { target, schema } = this.targets.contract(input.target);
    const sources = checkInput(input.fixedInput, input.inputSources, schema);
    return this.store.command(`quick-launch:save:${id ?? "new"}`, input.requestId, { ...input, fixedInput: input.fixedInput }, () => {
      if (input.groupId !== null) check(this.store.one("SELECT id FROM quick_launch_groups WHERE id=?", input.groupId), "NOT_FOUND", "分组不存在", 404);
      const now = Date.now();
      const values = [name, input.note, input.groupId, json(target), json(input.fixedInput), json(sources)] as const;
      if (id === null) {
        const newId = randomUUID();
        this.store.exec("INSERT INTO quick_launches VALUES (?,?,?,?,?,?,?,1,?,?)", newId, ...values, now, now);
        return this.get(newId);
      }
      check(this.store.exec(`UPDATE quick_launches SET name=?,note=?,group_id=?,target_json=?,fixed_input_json=?,
        input_sources_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?`, ...values, now, id, input.revision ?? -1).changes === 1,
      "REVISION_CONFLICT", "快捷启动已变化，请重新加载", 409);
      return this.get(id);
    });
  }

  copy(id: string, requestId: string) {
    return this.store.command(`quick-launch:copy:${id}`, requestId, {}, () => {
      const { name, note, groupId, target, fixedInput, inputSources } = this.get(id);
      return this.save(null, { name, note, groupId, target, fixedInput, inputSources, requestId: randomUUID() });
    });
  }

  delete(id: string, revision: number, requestId: string) {
    return this.store.command(`quick-launch:delete:${id}`, requestId, { revision }, () => {
      check(this.store.exec("DELETE FROM quick_launches WHERE id=? AND revision=?", id, revision).changes === 1,
        "REVISION_CONFLICT", "快捷启动已变化，请重新加载", 409);
      return { deleted: true };
    });
  }

  private sign(row: CardRow, requestId: string, expires: number) {
    return createHmac("sha256", this.key).update(canonicalJson([row, requestId, expires])).digest("hex");
  }

  confirmation(id: string, input: Start) {
    const row = this.requireCard(id);
    check(row.revision === input.revision, "REVISION_CONFLICT", "快捷启动已变化", 409);
    check(this.targets.contract(JSON.parse(row.target_json)).confirmation, "CONFIRMATION_NOT_REQUIRED", "该目标无需确认");
    const expires = Date.now() + 300_000;
    return { token: `${expires}.${this.sign(row, input.requestId, expires)}` };
  }

  private confirm(row: CardRow, input: Start) {
    const token = input.confirmationToken ?? "";
    check(/^\d{13}\.[0-9a-f]{64}$/.test(token), "CONFIRMATION_REQUIRED", "请确认运行目标");
    const [timestamp, signature] = token.split(".");
    check(Number(timestamp) > Date.now() && timingSafeEqual(Buffer.from(signature, "hex"),
      Buffer.from(this.sign(row, input.requestId, Number(timestamp)), "hex")), "CONFIRMATION_REQUIRED", "确认已过期或目标已变化");
  }

  start(id: string, input: Start) {
    const scope = `quick-launch:${id}`, requestDigest = digest(canonicalJson({ revision: input.revision }));
    const admission = this.store.transaction(() => {
      const prior = this.store.one<Execution>("SELECT * FROM execution_records WHERE request_scope=? AND request_id=?", scope, input.requestId);
      if (prior) {
        check(prior.request_digest === requestDigest, "REQUEST_CONFLICT", "同一请求标识已用于其他修订", 409);
        return { id: prior.id };
      }
      this.reconcile();
      const row = this.requireCard(id);
      check(row.revision === input.revision, "REVISION_CONFLICT", "快捷启动已变化", 409);
      const card = this.card(row);
      if (card.confirmation) this.confirm(row, input);
      check(!this.store.one(`SELECT id FROM execution_records WHERE launch_id=? AND status IN ('accepted','queued','running','cancel_requested','unknown')`, id),
        "EXECUTION_BUSY", "该卡片已有未结束的运行", 409);
      const executionId = randomUUID(), now = Date.now();
      const { recent: _recent, ...safeCard } = card;
      const snapshot = card.target.kind === "browser_tool" ?
        { ...safeCard, application: card.target.applicationId, tool: card.target.toolId, environmentId: card.target.environmentId } : safeCard;
      const privateInput = Object.keys(card.inputSources).length > 0 || card.target.kind === "browser_tool";
      this.store.exec(`INSERT INTO execution_records(id,launch_id,source,target_kind,request_scope,request_id,request_digest,
        config_revision,snapshot_ref,status,privacy_policy,accepted_at,output_availability)
        VALUES(?,?,'quick_launch',?,?,?,?,?,?,'accepted',?,?,'not_recorded')`, executionId, id, card.target.kind,
        scope, input.requestId, requestDigest, row.revision, this.store.reference(snapshot), privateInput ? "restricted" : "standard", now);
      return { id: executionId, card };
    });
    if (!admission.card) return this.detail(admission.id);
    const executionId = admission.id;
    try {
      const card = admission.card;
      const { target, schema } = this.targets.contract(card.target);
      const sources = checkInput(card.fixedInput, card.inputSources, schema);
      const resolved = resolveInput(card.fixedInput, sources,
        (dictionaryId, key, field) => this.readDictionary(dictionaryId, key, isSensitiveField(schema, field)));
      const privateInput = Object.keys(sources).length > 0 || target.kind === "browser_tool";
      assertSchema(resolved, schema, "运行参数");
      this.dispatch(executionId, target, resolved, privateInput);
    } catch (error) {
      this.finish(executionId, "start_failed", error);
    }
    return this.detail(executionId);
  }

  private dispatch(id: string, target: Target, input: unknown, privateInput: boolean) {
    const now = Date.now();
    if (target.kind === "browser_tool") {
      this.store.transaction(() => {
        this.store.exec("INSERT INTO execution_outbox VALUES (?,?, 'dispatch',0,'pending',0,NULL,NULL,?,?)", randomUUID(), id, now, now);
        this.store.exec("UPDATE execution_records SET underlying_kind='bridge_call',underlying_id=?,status='queued' WHERE id=?", id, id);
      });
      this.volatileInputs.set(id, input);
      return;
    }
    const underlyingId = this.store.transaction(() => {
      const run = target.kind === "workflow" ? this.runner.create(target.versionId, input, id, privateInput, true) :
        this.store.createScriptTest(target.scriptId, target.versionId, null, input, id, undefined, undefined, privateInput, true);
      this.store.exec("INSERT INTO execution_outbox VALUES (?,?, 'dispatch',0,'settled',1,NULL,NULL,?,?)", randomUUID(), id, now, now);
      this.store.exec("UPDATE execution_records SET underlying_kind=?,underlying_id=?,status='queued' WHERE id=?",
        target.kind === "workflow" ? "workflow_run" : "script_test", run.id, id);
      return run.id;
    });
    if (target.kind === "script") this.scripts.enqueue(underlyingId);
  }

  private finish(id: string, status: string, error?: unknown, claim?: string) {
    this.store.transaction(() => {
      const now = Date.now();
      if (claim && !this.store.one("SELECT id FROM execution_outbox WHERE execution_id=? AND state IN ('claimed','dispatching') AND claim_token=?", id, claim)) return;
      const safe = error ? json({ code: error instanceof AppError ? error.code : "EXECUTION_FAILED", message: "运行未能完成，请检查目标及输入配置" }) : null;
      this.store.exec(`UPDATE execution_records SET status=?,ended_at=?,safe_error_json=?,last_event_sequence=last_event_sequence+1
        WHERE id=? AND status IN ('accepted','queued','running','cancel_requested')`, status, status === "unknown" ? null : now, safe, id);
      this.store.exec("UPDATE execution_outbox SET state='settled',claim_token=NULL,lease_until=NULL,updated_at=? WHERE execution_id=?", now, id);
    });
  }

  registerBridge(application: string, tool: string, environmentId: string | undefined, parentId?: string) {
    const id = randomUUID(), now = Date.now();
    this.store.transaction(() => {
      this.store.exec(`INSERT INTO execution_records(id,source,target_kind,request_scope,request_id,request_digest,snapshot_ref,
        parent_execution_id,underlying_kind,underlying_id,status,privacy_policy,accepted_at,started_at,output_availability)
        VALUES(?,'web_bridge','browser_tool','native:bridge_call',?,?,?,?,'bridge_call',?,'running','restricted',?,?,'restricted')`,
        id, id, digest(id), json({ inline: { name: `${application} · ${tool}`, application, tool, environmentId: environmentId ?? null } }),
        parentId ?? null, id, now, now);
      this.store.exec("INSERT INTO execution_outbox VALUES (?,?,'dispatch',0,'dispatching',1,NULL,NULL,?,?)", randomUUID(), id, now, now);
    });
    return { id, finish: (status: "succeeded" | "failed", error?: unknown) => this.settleBridge(id, status, error) };
  }

  bridgeHistory(application: string, toolId: string) {
    const rows = this.store.all<{ id: string; underlying_id: string; snapshot_ref: string; status: string; started_at: number | null; ended_at: number | null }>(
      "SELECT id,underlying_id,snapshot_ref,status,started_at,ended_at FROM execution_records WHERE underlying_kind='bridge_call' ORDER BY accepted_at DESC,id DESC");
    return rows.flatMap(row => {
      const snapshot = this.store.dereference(row.snapshot_ref) as { application?: string; tool?: string; environmentId?: string };
      if (snapshot?.application !== application || snapshot.tool !== toolId || !["succeeded", "failed"].includes(row.status)) return [];
      return [{ id: row.underlying_id, application, toolId, source: "call", startedAt: row.started_at ?? 0,
        durationMs: Math.max(0, (row.ended_at ?? 0) - (row.started_at ?? 0)), status: row.status, args: null,
        environmentId: snapshot.environmentId, redacted: true, legacy: true }];
    });
  }

  registerUnderlying(kind: "workflow_run" | "script_test", id: string, name: string, source: "workflow_page" | "script_library") {
    const scope = `native:${kind}`;
    this.store.exec(`INSERT INTO execution_records(id,source,target_kind,request_scope,request_id,request_digest,
      snapshot_ref,underlying_kind,underlying_id,status,privacy_policy,accepted_at,output_availability)
      VALUES(?,?,?,?,?,?,?, ?,?,'queued','restricted',?,'restricted')
      ON CONFLICT DO NOTHING`, randomUUID(), source, kind === "workflow_run" ? "workflow" : "script", scope, id,
      digest(id), json({ inline: { name } }), kind, id, Date.now());
  }

  reconcile() {
    for (const [table, kind] of [["runs", "workflow_run"], ["script_tests", "script_test"]] as const) {
      this.store.exec(`UPDATE execution_records AS e SET
        (status,started_at,ended_at)=(SELECT status,started_at,ended_at FROM ${table} AS t WHERE t.id=e.underlying_id),
        last_event_sequence=last_event_sequence+1
        WHERE status IN ('queued','running','cancel_requested','unknown') AND underlying_kind=?
        AND EXISTS (SELECT 1 FROM ${table} AS t WHERE t.id=e.underlying_id
          AND (e.status<>'unknown' OR t.status IN ('succeeded','failed','cancelled','interrupted')) AND
          (t.status IS NOT e.status OR t.started_at IS NOT e.started_at OR t.ended_at IS NOT e.ended_at))`, kind);
      this.store.exec(`UPDATE execution_records AS e SET status='unknown',last_event_sequence=last_event_sequence+1
        WHERE status IN ('queued','running','cancel_requested') AND underlying_kind=?
        AND NOT EXISTS (SELECT 1 FROM ${table} AS t WHERE t.id=e.underlying_id)`, kind);
    }
  }

  history(query: { q?: string; type?: string; source?: string; status?: string; from?: string; to?: string; cursor?: string; limit?: string }) {
    this.reconcile();
    const clauses = ["parent_execution_id IS NULL"], params: (string | number)[] = [];
    for (const [key, column] of [["type", "target_kind"], ["source", "source"], ["status", "status"]] as const) {
      if (query[key]) { clauses.push(`${column}=?`); params.push(query[key]!); }
    }
    for (const [key, operator] of [["from", ">="], ["to", "<="]] as const) if (query[key]) {
      const time = Number(query[key]);
      check(Number.isSafeInteger(time) && time >= 0, "INVALID_FILTER", "时间筛选无效");
      clauses.push(`accepted_at${operator}?`); params.push(time);
    }
    if (query.q) {
      clauses.push("(instr(lower(id),lower(?))>0 OR instr(lower(coalesce(underlying_id,'')),lower(?))>0 OR instr(lower(coalesce(json_extract(snapshot_ref,'$.inline.name'),'')),lower(?))>0)");
      params.push(query.q, query.q, query.q);
    }
    const total = this.store.one<{ count: number }>(`SELECT count(*) AS count FROM execution_records WHERE ${clauses.join(" AND ")}`, ...params)?.count ?? 0;
    if (query.cursor) {
      const match = /^(\d+):([\w-]+)$/.exec(query.cursor);
      check(match && Number.isSafeInteger(Number(match[1])), "INVALID_CURSOR", "游标无效");
      clauses.push("(accepted_at,id)<(?,?)"); params.push(Number(match[1]), match[2]);
    }
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    check(Number.isInteger(limit), "INVALID_LIMIT", "分页大小无效");
    const rows = this.store.all<{ id: string; accepted_at: number }>(`SELECT id,accepted_at FROM execution_records WHERE ${clauses.join(" AND ")}
      ORDER BY accepted_at DESC,id DESC LIMIT ?`, ...params, limit + 1);
    const page = rows.slice(0, limit), last = page.at(-1);
    return { items: page.map(row => this.readDetail(row.id)), total, nextCursor: rows.length > limit && last ? `${last.accepted_at}:${last.id}` : null };
  }

  detail(id: string) {
    this.reconcile();
    return this.readDetail(id);
  }

  private readDetail(id: string) {
    const row = this.store.one<Execution & { snapshot_ref: string; source: string; target_kind: string; accepted_at: number; started_at: number | null; ended_at: number | null; safe_error_json: string | null; output_availability: string }>("SELECT * FROM execution_records WHERE id=?", id);
    check(row, "NOT_FOUND", "运行记录不存在", 404);
    const snapshot = this.store.dereference(row.snapshot_ref) as { name?: string };
    return { id, name: snapshot?.name ?? row.underlying_id ?? id, status: row.status, source: row.source, type: row.target_kind,
      acceptedAt: row.accepted_at, startedAt: row.started_at, endedAt: row.ended_at, snapshot,
      outputAvailability: row.output_availability, error: row.safe_error_json ? JSON.parse(row.safe_error_json) : null,
      underlyingId: row.underlying_id, underlyingKind: row.underlying_kind,
      children: this.store.all<{ id: string; status: string }>("SELECT id,status FROM execution_records WHERE parent_execution_id=? ORDER BY accepted_at,id", id) };
  }

  cancel(id: string) {
    const record = this.detail(id);
    check(active.slice(0, 3).includes(record.status) && record.underlyingId, "CANCEL_UNAVAILABLE", "此运行无法取消", 409);
    if (record.underlyingKind === "workflow_run") this.runner.cancel(record.underlyingId);
    else if (record.underlyingKind === "script_test") this.scripts.cancel(record.underlyingId);
    else {
      if (record.status === "queued") {
        this.finish(id, "cancelled");
        this.volatileInputs.delete(id);
        return this.detail(id);
      }
      const call = this.calls.get(id);
      check(call, "CANCEL_UNAVAILABLE", "当前无法确认浏览器运行状态", 409);
      this.store.exec("UPDATE execution_records SET status='cancel_requested' WHERE id=? AND status='running'", id);
      call.cancel.abort();
    }
    return this.detail(id);
  }

  endTracking(id: string, reason: string) {
    check(this.store.exec(`UPDATE execution_records SET status='unresolved_closed',ended_at=?,ended_tracking_reason=?
      WHERE id=? AND status='unknown'`, Date.now(), reason, id).changes === 1, "INVALID_STATE", "仅可结束待确认的运行", 409);
    return this.detail(id);
  }
}
