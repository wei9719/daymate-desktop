import { useEffect, useState } from "react";
import { useFocusStore } from "./focusStore";
import { remainingFocusSeconds } from "./services/focusSession";
import { sendFocusCompletedNotification } from "./services/system";
import { useAppStore } from "./store";

// Timers only refresh the display; the persisted deadline is the clock's source of truth.
export function useFocusClock(enabled = true) {
  const session = useFocusStore((state) => state.session);
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState("");
  const sessionId = session?.id;
  const sessionStatus = session?.status;
  useEffect(() => {
    if (!enabled || !sessionId) return;
    const refresh = () => {
      const timestamp = Date.now();
      setNow(timestamp);
      try {
        const current = useFocusStore.getState().session;
        if (
          current?.status === "running" &&
          remainingFocusSeconds(current, timestamp) === 0
        )
          useFocusStore.getState().complete();
        if (
          useFocusStore.getState().claimNotification() &&
          useAppStore.getState().preferences.notifications
        )
          sendFocusCompletedNotification().catch(() =>
            setError(
              "专注已经完成，系统通知未能发送。可以稍后在设置中测试通知。",
            ),
          );
      } catch {
        setError(
          "专注状态未能保存，请检查本地可用空间。关闭应用前请先暂停并重试。",
        );
      }
    };
    const interval =
      sessionStatus === "running"
        ? window.setInterval(refresh, 1000)
        : undefined;
    const first = window.setTimeout(refresh, 0);
    const unsubscribe = useFocusStore.subscribe((state, previous) => {
      if (
        state.session?.status === "completed" &&
        (previous.session?.status !== "completed" ||
          previous.session.id !== state.session.id)
      )
        refresh();
    });
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      if (interval !== undefined) window.clearInterval(interval);
      window.clearTimeout(first);
      unsubscribe();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled, sessionId, sessionStatus]);
  return {
    session,
    seconds: session ? remainingFocusSeconds(session, now) : 0,
    error,
  };
}
