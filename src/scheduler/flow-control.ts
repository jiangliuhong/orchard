import { v7 as uuidv7 } from 'uuid';
import type { OrchardDatabase } from '../storage/database.js';
import type { RunRepository } from '../storage/repository.js';
import { PolicyBucketRepository } from '../storage/repository.js';

export interface FlowCommand { readonly workflowId: string; readonly policyKey: string; readonly payload: unknown; readonly debounceMs?: number; readonly singleton?: 'skip' | 'cancel'; readonly singletonRunId?: string; }

/** Transactional admission decisions for debounce and singleton policies. */
export class FlowControlRepository {
  private readonly buckets: PolicyBucketRepository;
  constructor(private readonly db: OrchardDatabase, private readonly runs: RunRepository) { this.buckets = new PolicyBucketRepository(db); }
  rateLimit(key: string, limit: number, periodMs: number, at = Date.now()): { allowed: boolean; retryAt?: number } { return this.buckets.consume(key, { limit, periodMs, now: at }); }
  admit(input: FlowCommand, at = Date.now()): { decision: 'create' | 'merge' | 'skip' | 'cancel'; commandId: string; runId?: string } {
    this.db.database.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db.database.prepare("SELECT id, run_id AS runId FROM pending_commands WHERE workflow_id = ? AND policy_key = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at LIMIT 1").get(input.workflowId, input.policyKey, at) as { id: string; runId?: string } | undefined;
      if (active && input.debounceMs !== undefined) { this.db.database.prepare('UPDATE pending_commands SET command_json = ?, expires_at = ?, updated_at = ? WHERE id = ? AND status = \'pending\'').run(JSON.stringify(input.payload), at + input.debounceMs, at, active.id); this.db.database.exec('COMMIT'); return { decision: 'merge', commandId: active.id, ...(active.runId ? { runId: active.runId } : {}) }; }
      const lock = this.db.database.prepare('SELECT run_id AS runId FROM singleton_locks WHERE policy_key = ?').get(input.policyKey) as { runId: string } | undefined;
      if (lock && input.singleton === 'skip') { this.db.database.exec('COMMIT'); return { decision: 'skip', commandId: uuidv7(), runId: lock.runId }; }
      if (lock && input.singleton === 'cancel') { this.db.database.prepare("UPDATE runs SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancel_requested' END, cancel_requested_at = ?, cancel_reason = 'singleton replaced' WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted', 'needs_review')").run(at, lock.runId); this.db.database.prepare('DELETE FROM singleton_locks WHERE policy_key = ?').run(input.policyKey); }
      const commandId = uuidv7(); this.db.database.prepare('INSERT INTO pending_commands (id, workflow_id, policy_key, command_json, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(commandId, input.workflowId, input.policyKey, JSON.stringify(input.payload), input.debounceMs === undefined ? null : at + input.debounceMs, at, at);
      this.db.database.exec('COMMIT'); return { decision: lock ? 'cancel' : 'create', commandId };
    } catch (error) { this.db.database.exec('ROLLBACK'); throw error; }
  }
  bindSingleton(policyKey: string, runId: string, mode: 'skip' | 'cancel', at = Date.now()): void { this.db.database.prepare('INSERT INTO singleton_locks (policy_key, run_id, mode, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(policy_key) DO UPDATE SET run_id = excluded.run_id, mode = excluded.mode, created_at = excluded.created_at').run(policyKey, runId, mode, at); }
  settle(commandId: string, runId: string, at = Date.now()): void { this.db.database.prepare("UPDATE pending_commands SET status = 'delivered', run_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(runId, at, commandId); }
}
