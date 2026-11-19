import { useEffect, useRef, useState } from "react";
import type { StreamEvent } from "../../domain/types.js";
import { hasUnsavedWorkspaceChanges } from "./navigation";

let bootstrapToken: string | undefined;
export function setBootstrapToken(value: string | undefined) { bootstrapToken = value; }
export const serviceUnavailableMessage = "暂时无法连接 Orchard，正在重试";
export const serviceUnavailableEvent = "orchard:service-unavailable";
export const serviceRecoveredEvent = "orchard:service-recovered";

function serviceUnavailable(status?: number, code?: string) {
  window.dispatchEvent(new window.Event(serviceUnavailableEvent));
  return Object.assign(new Error(serviceUnavailableMessage), { httpStatus: status, code });
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (typeof options.body === "string" && options.body.length > 0 && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if ((path.startsWith("/migrations/") || path.startsWith("/bootstrap/")) && bootstrapToken) headers.set("X-Orchard-Bootstrap-Token", bootstrapToken);
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...options, headers }); }
  catch (error) {
    if (options.signal?.aborted || !(error instanceof TypeError)) throw error;
    throw serviceUnavailable();
  }
  let body;
  try { body = await response.json(); }
  catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    if ([502, 503, 504].includes(response.status)) throw serviceUnavailable(response.status);
    throw Object.assign(new Error("Orchard 返回了无法读取的响应"), { httpStatus: response.status });
  }
  if (!response.ok) {
    if ([502, 504].includes(response.status) || (response.status === 503 && (!body?.code || ["MIGRATION_REQUIRED", "MIGRATION_IN_PROGRESS"].includes(body.code)))) {
      throw serviceUnavailable(response.status, body?.code);
    }
    throw Object.assign(new Error(body?.message ?? "请求失败"), body, { httpStatus: response.status });
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
export function useResource<T>(path: string | undefined) {
  const [data, setData] = useState<T>(), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const lastLoadedPath = useRef<string | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController(); setError("");
    if (!path) return;
    let interrupted = false;
    const refreshAfterRecovery = () => {
      if (!interrupted) return;
      // A newer resource revision could replace the editor's unsaved input.
      if (lastLoadedPath.current === path && hasUnsavedWorkspaceChanges()) setError("");
      else setRevision(r => r + 1);
    };
    window.addEventListener(serviceRecoveredEvent, refreshAfterRecovery);
    void api<T>(path, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      lastLoadedPath.current = path;
      setData(value);
    }).catch(error => {
      if (controller.signal.aborted) return;
      interrupted = error.message === serviceUnavailableMessage;
      setError(error.message);
    });
    return () => { controller.abort(); window.removeEventListener(serviceRecoveredEvent, refreshAfterRecovery); };
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
