import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export interface CompletionNotification { id: string; key: string; title: string; body: string; url: string }
const labels: Record<string, string> = { succeeded: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
/** Bounded, process-local replay buffer. No historical notifications on first connection. */
export class NotificationFeed {
  readonly events = new EventEmitter();
  private sequence = 0;
  private items: CompletionNotification[] = [];
  private seen = new Set<string>();
  get cursor() { return String(this.sequence); }
  complete(key: string, status: string, name: string, url: string) {
    if (!labels[status] || this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
    const item = { id: String(++this.sequence), key: randomUUID(), title: `${name}${labels[status]}`, body: "点击查看详情", url };
    this.items.push(item);
    if (this.items.length > 500) this.items.shift();
    this.events.emit("notification", item);
  }
  after(cursor: string) { return this.items.filter(item => Number(item.id) > Number(cursor)); }
}
