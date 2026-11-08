import { useEffect, useState } from "react";

export function useChatPolling<Value>(key: string, load: (signal: AbortSignal) => Promise<Value>, active: (value: Value) => boolean, interval = 1500) {
  const [state, setState] = useState<{ key: string; data: Value }>();
  const [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await load(controller.signal);
        if (controller.signal.aborted) return;
        setState({ key, data }); setError("");
        if (active(data)) timer = setTimeout(() => void poll(), interval);
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      }
    };
    setError("");
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, refresh, interval]);
  return { data: state?.key === key ? state.data : undefined, error, reload: () => setRefresh(value => value + 1) };
}
