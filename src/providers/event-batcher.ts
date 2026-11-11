import type { ProviderEvent } from "./registry.js";

/** Persist text in bounded batches; flush before every non-text event and terminal state. */
export class ProviderEventBatcher {
  private pending?: { text: string; offset: number; itemId?: string };
  private timer?: ReturnType<typeof setTimeout>;
  private failure?: unknown;
  constructor(private readonly write: (event: ProviderEvent) => void, private readonly onError: (error: unknown) => void) {}
  emit = (event: ProviderEvent) => {
    if (this.failure) throw this.failure;
    if (event.type !== "provider.text") { this.flush(); this.write(event); return; }
    const payload = event.payload as { text: string; offset: number; itemId?: string };
    const bytes = Buffer.from(payload.text);
    if (bytes.length > 4096) {
      // A backend may deliver a whole message in one delta. Keep SSE payloads inline
      // and split only between UTF-8 code points, preserving the original offsets.
      for (let start = 0; start < bytes.length;) {
        let end = Math.min(start + 4096, bytes.length);
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        this.emit({ type: event.type, payload: { ...payload, text: bytes.subarray(start, end).toString("utf8"), offset: payload.offset + start } });
        start = end;
      }
      return;
    }
    if (this.pending && (this.pending.itemId !== payload.itemId || this.pending.offset + Buffer.byteLength(this.pending.text) !== payload.offset)) this.flush();
    if (this.pending) this.pending.text += payload.text;
    else this.pending = { ...payload };
    if (Buffer.byteLength(this.pending.text) >= 4096) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        try { this.flush(); } catch (error) { this.failure = error; this.onError(error); }
      }, 50);
      this.timer.unref();
    }
  };
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.failure) throw this.failure;
    if (!this.pending) return;
    const payload = this.pending; this.pending = undefined;
    this.write({ type: "provider.text", payload });
  }
  close() { clearTimeout(this.timer); this.timer = undefined; this.pending = undefined; }
}
