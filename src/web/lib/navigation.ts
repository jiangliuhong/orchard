import { useLayoutEffect, useRef } from "react";

type LeaveGuard = (proceed: () => void) => void;
let leaveGuard: LeaveGuard | undefined;

export function useLeaveGuard(dirty: boolean, guard: LeaveGuard) {
  const latest = useRef(guard);
  latest.current = guard;
  useLayoutEffect(() => {
    if (!dirty) return;
    const block: LeaveGuard = proceed => latest.current(proceed);
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    leaveGuard = block;
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      if (leaveGuard === block) leaveGuard = undefined;
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty]);
}

const historyIndex = "orchardRouteIndex";
const routeChange = "orchard:route-change";

export function replaceRoute(path: string) {
  window.history.replaceState(window.history.state, "", path);
  window.dispatchEvent(new Event(routeChange));
}

export function navigate(path: string, { skipGuard = false } = {}) {
  const url = new URL(path, window.location.href);
  if (url.href === window.location.href) return;
  if (url.origin !== window.location.origin || !/^https?:$/.test(url.protocol)) {
    window.location.assign(url.href);
    return;
  }
  const proceed = () => {
    const index = window.history.state?.[historyIndex] ?? 0;
    window.history.pushState({ [historyIndex]: index + 1 }, "", url);
    window.dispatchEvent(new Event(routeChange));
  };
  if (leaveGuard && !skipGuard) leaveGuard(proceed); else proceed();
}

export function useNavigation(onChange: () => void) {
  useLayoutEffect(() => {
    const history = window.history;
    let index = history.state?.[historyIndex] ?? 0;
    history.replaceState({ ...history.state, [historyIndex]: index }, "");
    let restore: { index: number; delta: number } | undefined;
    let approvedIndex: number | undefined;
    const commit = () => {
      index = history.state?.[historyIndex] ?? 0;
      onChange();
    };
    const onPopState = () => {
      const next = history.state?.[historyIndex] ?? index;
      if (restore && next === restore.index) {
        const { delta } = restore;
        restore = undefined;
        const proceed = () => {
          approvedIndex = index + delta;
          history.go(delta);
        };
        if (leaveGuard) leaveGuard(proceed); else proceed();
        return;
      }
      if (leaveGuard && next !== index && next !== approvedIndex) {
        restore = { index, delta: next - index };
        history.go(index - next);
        return;
      }
      approvedIndex = undefined;
      commit();
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLElement) || anchor.hasAttribute("download") || (anchor.getAttribute("target") || "_self") !== "_self") return;
      const href = anchor.getAttribute("href")!;
      if (href.startsWith("#")) return;
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin || !/^https?:$/.test(url.protocol) || url.pathname === "/api" || url.pathname.startsWith("/api/")) return;
      event.preventDefault();
      navigate(url.href);
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener(routeChange, commit);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener(routeChange, commit);
      document.removeEventListener("click", onClick);
    };
  }, [onChange]);
}
