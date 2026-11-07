import { randomUUID } from 'node:crypto';
import { mkdirSync, rmdirSync, openSync, closeSync, writeFileSync, fsyncSync, readFileSync, unlinkSync, realpathSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { MigrationError } from './types.js';
import { directory, present, syncDirectory } from './journal.js';
const leases = new WeakSet<DirectoryLease>();
export class DirectoryLease {
  readonly root: string;
  readonly original: string[];
  readonly owner = randomUUID();
  private active = true;
  private constructor(root: string) {
    directory(root); this.root = realpathSync(root); this.original = readdirSync(this.root);
    const guard = join(this.root, '.workbench-lock-guard');
    try { mkdirSync(guard, { mode: 0o700 }); } catch { throw new MigrationError('INSTANCE_LOCKED'); }
    try {
      const path = join(this.root, 'workbench.lock');
      if (present(path)) {
        if (!lstatSync(path).isFile()) throw new MigrationError('INSTANCE_LOCKED');
        let pid: number;
        try { const text = readFileSync(path, 'utf8'); const parsed = JSON.parse(text); pid = typeof parsed === 'number' ? parsed : parsed.pid; } catch { throw new MigrationError('INSTANCE_LOCKED'); }
        if (!Number.isInteger(pid) || pid <= 0) throw new MigrationError('INSTANCE_LOCKED');
        try { process.kill(pid, 0); throw new MigrationError('INSTANCE_LOCKED'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new MigrationError('INSTANCE_LOCKED'); }
        unlinkSync(path);
      }
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ formatVersion: 1, pid: process.pid, owner: this.owner })); fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(this.root); leases.add(this);
    } finally { rmdirSync(guard); }
  }
  static acquire(root: string) { return new DirectoryLease(root); }
  static validate(lease: DirectoryLease, root: string) { if (!leases.has(lease)) throw new MigrationError("INSTANCE_LOCKED"); DirectoryLease.prototype.assert.call(lease, root); }
  assert(root = this.root) {
    if (!leases.has(this) || !this.active || root !== this.root) throw new MigrationError('INSTANCE_LOCKED');
    try { const record = JSON.parse(readFileSync(join(this.root, 'workbench.lock'), 'utf8')); if (record.owner !== this.owner || record.pid !== process.pid) throw new Error(); }
    catch { throw new MigrationError('INSTANCE_LOCKED'); }
  }
  release() {
    this.assert(); unlinkSync(join(this.root, 'workbench.lock')); syncDirectory(this.root); this.active = false; leases.delete(this);
  }
}
