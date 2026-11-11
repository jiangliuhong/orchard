import { useEffect, useState } from "react";

export function useChatPolling<Value>(key: string, load: (signal: AbortSignal) => Promise<Value>, active: (value: Value) => boolean, interval = 1500) {
  const [state, setState] = useState<{ key: string; data: Value }>();
  const [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        const data = await load(controller.signal);
        if (controller.signal.aborted) return;
        failures = 0;
        setState({ key, data }); setError("");
        if (active(data)) timer = setTimeout(() => void poll(), interval);
      } catch (error) {
        if (!controller.signal.aborted) {
          setError((error as Error).message);
          // A transient failure must not strand a running turn. Cap retry backoff at 30s.
          const delay = Math.min(interval * 2 ** Math.min(failures++, 5), 30000);
          timer = setTimeout(() => void poll(), delay);
        }
      }
    };
    setError("");
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, refresh, interval]);
  return { data: state?.key === key ? state.data : undefined, error, reload: () => setRefresh(value => value + 1) };
}
