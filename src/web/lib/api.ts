import { useEffect, useRef, useState } from "react";
import type { StreamEvent } from "../../domain/types.js";

let bootstrapToken: string | undefined;
export function setBootstrapToken(value: string | undefined) { bootstrapToken = value; }
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (typeof options.body === "string" && options.body.length > 0 && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if ((path.startsWith("/migrations/") || path.startsWith("/bootstrap/")) && bootstrapToken) headers.set("X-Orchard-Bootstrap-Token", bootstrapToken);
  const response = await fetch(`/api${path}`, { ...options, headers });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 503 && ["MIGRATION_REQUIRED", "MIGRATION_IN_PROGRESS"].includes(body.code)) window.dispatchEvent(new Event("orchard:not-ready"));
    throw Object.assign(new Error(body.message ?? "请求失败"), body, { httpStatus: response.status });
  }
  return body as T;
}
export const send = <T>(path: string, value?: unknown, method = "POST") => api<T>(path, { method, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
export const requestId = () => crypto.randomUUID();
export function useCommandKey() {
  const current = useRef<{ payload: string; id: string } | null>(null);
  return (input: unknown) => {
    const payload = JSON.stringify(input);
    if (current.current?.payload !== payload) current.current = { payload, id: requestId() };
    return current.current.id;
  };
}
export const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? "—";
export function useResource<T>(path: string) {
  const [data, setData] = useState<T>(), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError("");
    void api<T>(path, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setData(value); }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [path, revision]);
  return { data, error, reload: () => setRevision(r => r + 1) };
}
export function useStream(resource: "runs" | "turns", id: string | undefined, callback: (event: StreamEvent) => void) {
  const handler = useRef(callback); handler.current = callback;
  useEffect(() => {
    if (!id) return;
    const source = new EventSource(`/api/${resource}/${encodeURIComponent(id)}/stream`);
    let last = 0;
    source.onmessage = message => {
      const event = JSON.parse(message.data) as StreamEvent;
      if (event.sequence <= last) return;
      last = event.sequence; handler.current(event);
    };
    return () => source.close();
  }, [resource, id]);
}
export function mergeEvents(current: StreamEvent[], event: StreamEvent) {
  if (current.some(item => item.sequence === event.sequence)) return current;
  return [...current, event].sort((a, b) => a.sequence - b.sequence).slice(-500);
}
