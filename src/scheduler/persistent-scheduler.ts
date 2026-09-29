import type { RunRepository, ScheduleRepository } from "../storage/repository.js";

export interface ScheduledDelivery { readonly scheduleId: string; readonly occurrenceKey: string; readonly runId?: string; }

/** Persistent scheduler: plans occurrences and delegates execution to run creation. */
export class PersistentScheduler {
  constructor(private readonly schedules: ScheduleRepository, private readonly runs: RunRepository, private readonly createRun: (workflowId: string, scheduledFor: number, occurrenceKey: string, workflowVersionId?: string) => string) {}

  tick(until = new Date(), from = new Date()): readonly ScheduledDelivery[] {
    const deliveries: ScheduledDelivery[] = [];
    for (const scheduleId of this.listEnabledScheduleIds()) {
      const occurrences = this.schedules.planDue(scheduleId, until, from);
      const schedule = this.schedules.get(scheduleId);
      if (!schedule) continue;
      for (const occurrence of occurrences) {
        const runId = this.createRun(schedule.workflowId, occurrence.scheduledFor, occurrence.occurrenceKey, schedule.workflowVersionId);
        if (this.schedules.deliverOccurrence(scheduleId, occurrence.occurrenceKey, runId)) deliveries.push({ scheduleId, occurrenceKey: occurrence.occurrenceKey, runId });
      }
    }
    return deliveries;
  }

  private listEnabledScheduleIds(): readonly string[] { return this.schedules.listEnabled().map((schedule) => schedule.id); }
}
