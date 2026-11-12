import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { check } from "../domain/errors.js";
import { present, removeDurable, safe, writeJson } from "../migrations/journal.js";
import { canonicalJson, digest } from "../persistence/files.js";
import type { MaintenanceProcessBinding } from "./maintenance-sessions.js";

interface Record {
  format: 1;
  boot: string;
  binding: MaintenanceProcessBinding;
  groups: (number | null)[];
}

function bootIdentity(): string {
  if (process.platform === "linux") {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    check(/^[a-f0-9-]{36}$/.test(id), "PROCESS_STOP_UNCONFIRMED", "无法核对系统启动身份", 503);
    return `linux:${id}`;
  }
  check(process.platform === "darwin", "PROCESS_STOP_UNCONFIRMED", "无法核对系统启动身份", 503);
  const value = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 2000 }).trim().toLowerCase();
  check(/^[a-f0-9-]{36}$/.test(value), "PROCESS_STOP_UNCONFIRMED", "无法核对系统启动身份", 503);
  return `darwin:${value}`;
}

/** A journal is written before every spawn. Recovery only probes recorded group
 * absence and never sends signals. A crash during spawn leaves an ambiguous slot
 * that can be resolved by evidence of a new OS boot. */
export class MaintenanceStopJournal {
  readonly #boot = bootIdentity();
  constructor(private readonly root: string, private readonly assertDirectoryLease: () => void) {}

  #path(binding: MaintenanceProcessBinding) {
    this.assertDirectoryLease();
    return safe(this.root, `runtime/maintenance-processes/${digest(canonicalJson(binding))}.json`);
  }

  #read(path: string, binding: MaintenanceProcessBinding): Record {
    check(present(path), "PROCESS_STOP_UNCONFIRMED", "缺少维护进程记录", 503);
    const info = lstatSync(path);
    check(info.isFile() && info.nlink === 1 && info.size <= 4096 && (info.mode & 0o077) === 0,
      "PROCESS_STOP_UNCONFIRMED", "维护进程记录属性无效", 503);
    const record = JSON.parse(readFileSync(path, "utf8")) as Record;
    check(record.format === 1 && /^(linux|darwin):[a-f0-9-]{36}$/.test(record.boot) &&
      canonicalJson(record.binding) === canonicalJson(binding) && Array.isArray(record.groups) && record.groups.length <= 4 &&
      record.groups.every(pid => pid === null || Number.isSafeInteger(pid) && pid >= 0 && pid !== 1),
    "PROCESS_STOP_UNCONFIRMED", "维护进程记录无法核对", 503);
    return record;
  }

  reserve(binding: MaintenanceProcessBinding) {
    const path = this.#path(binding);
    check(!present(path), "PROCESS_STOP_UNCONFIRMED", "已有同一任务的维护进程记录", 503);
    writeJson(path, { format: 1, boot: this.#boot, binding, groups: [] } satisfies Record);
  }

  beforeSpawn(binding: MaintenanceProcessBinding) {
    const path = this.#path(binding), record = this.#read(path, binding);
    const slot = record.groups.length;
    check(record.boot === this.#boot && slot < 4, "PROCESS_STOP_UNCONFIRMED", "维护进程记录不可追加", 503);
    record.groups.push(null);
    writeJson(path, record);
    return slot;
  }

  afterSpawn(binding: MaintenanceProcessBinding, slot: number, pid: number) {
    const path = this.#path(binding), record = this.#read(path, binding);
    check(record.boot === this.#boot && record.groups[slot] === null &&
      Number.isSafeInteger(pid) && (pid === 0 || pid > 1), "PROCESS_STOP_UNCONFIRMED", "维护进程记录不可更新", 503);
    record.groups[slot] = pid;
    writeJson(path, record);
  }

  assertRestartStopped(binding: MaintenanceProcessBinding) {
    const record = this.#read(this.#path(binding), binding);
    if (record.boot !== this.#boot) return;
    for (const pid of record.groups) {
      check(pid !== null, "PROCESS_STOP_UNCONFIRMED", "宿主退出前未完成维护进程登记", 503);
      if (pid === 0) continue;
      try { process.kill(-pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") continue; }
      check(false, "PROCESS_STOP_UNCONFIRMED", "仍无法证明维护进程组已经退出", 503);
    }
  }

  /** Call after settling the matching task with a complete stop proof. */
  remove(binding: MaintenanceProcessBinding) {
    const path = this.#path(binding);
    if (present(path)) removeDurable(path);
  }
}
