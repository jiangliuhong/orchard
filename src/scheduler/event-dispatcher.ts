export interface TriggerMatcher { readonly id: string; readonly eventName: string; readonly filter?: (data: unknown) => boolean; readonly dispatch: (event: { source: string; eventId: string; name: string; data: unknown }) => Promise<void> | void; }

export class EventDispatcher {
  private readonly triggers = new Map<string, TriggerMatcher>();
  register(trigger: TriggerMatcher): void { this.triggers.set(trigger.id, trigger); }
  unregister(id: string): void { this.triggers.delete(id); }
  async dispatch(event: { source: string; eventId: string; name: string; data: unknown }): Promise<number> {
    const matches = [...this.triggers.values()].filter((trigger) => trigger.eventName === event.name && (!trigger.filter || trigger.filter(event.data)));
    await Promise.all(matches.map((trigger) => trigger.dispatch(event)));
    return matches.length;
  }
}
