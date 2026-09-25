export interface CronSchedule {
  readonly expression: string;
  readonly timezone?: string;
  next(after: Date): Date;
}

const aliases: Record<string, string> = {
  "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *",
};

function values(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    if (!range) throw new Error(`Invalid cron field: ${field}`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step: ${part}`);
    const [startText, endText] = range === "*" ? [String(min), String(max)] : range.split("-");
    const start = Number(startText); const end = endText === undefined ? start : Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) throw new Error(`Invalid cron range: ${part}`);
    for (let value = start; value <= end; value += step) result.add(value);
  }
  return result;
}

export function parseCron(expression: string): CronSchedule {
  const normalized = aliases[expression.trim()] ?? expression.trim();
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron expression must contain five fields");
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
  if (!minuteField || !hourField || !dayField || !monthField || !weekdayField) throw new Error("Cron expression must contain five fields");
  const minutes = values(minuteField, 0, 59), hours = values(hourField, 0, 23), days = values(dayField, 1, 31), months = values(monthField, 1, 12), weekdays = values(weekdayField, 0, 6);
  return { expression: normalized, next(after: Date): Date {
    const candidate = new Date(after.getTime()); candidate.setSeconds(0, 0); candidate.setMinutes(candidate.getMinutes() + 1);
    for (let i = 0; i < 60 * 24 * 366 * 5; i++, candidate.setMinutes(candidate.getMinutes() + 1)) {
      if (minutes.has(candidate.getMinutes()) && hours.has(candidate.getHours()) && days.has(candidate.getDate()) && months.has(candidate.getMonth() + 1) && weekdays.has(candidate.getDay())) return new Date(candidate);
    }
    throw new Error("Cron expression has no occurrence within five years");
  } };
}

export interface CronJob { readonly id: string; readonly schedule: CronSchedule; readonly run: (scheduledFor: Date, signal: AbortSignal) => Promise<void> | void; }

export class CronScheduler {
  private readonly jobs = new Map<string, { job: CronJob; next: Date; controller: AbortController }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  add(job: CronJob, now = new Date()): void { if (this.closed) throw new Error("Scheduler is closed"); this.remove(job.id); this.jobs.set(job.id, { job, next: job.schedule.next(now), controller: new AbortController() }); this.arm(); }
  remove(id: string): void { const entry = this.jobs.get(id); if (entry) entry.controller.abort(new Error("Cron job removed")); this.jobs.delete(id); this.arm(); }
  async tick(now = new Date()): Promise<void> { const due = [...this.jobs.values()].filter((entry) => entry.next <= now); await Promise.all(due.map(async (entry) => { const scheduledFor = entry.next; entry.next = entry.job.schedule.next(now); await entry.job.run(scheduledFor, entry.controller.signal); })); this.arm(); }
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); for (const entry of this.jobs.values()) entry.controller.abort(new Error("Scheduler closed")); this.jobs.clear(); }
  private arm(): void { if (this.timer) clearTimeout(this.timer); if (this.closed || this.jobs.size === 0) return; const next = Math.min(...[...this.jobs.values()].map((entry) => entry.next.getTime())); this.timer = setTimeout(() => void this.tick(), Math.max(10, next - Date.now())); }
}
