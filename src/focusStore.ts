import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Task } from "./types";
import { asRecord, safeStateStorage } from "./services/persistedState";
import {
  remainingFocusSeconds,
  restoreFocusSession,
  startFocusSession,
  type FocusSession,
} from "./services/focusSession";

interface FocusState {
  session?: FocusSession;
  start: (task: Task) => void;
  pause: () => void;
  resume: () => void;
  complete: () => void;
  dismiss: () => void;
  claimNotification: () => boolean;
}

export const useFocusStore = create<FocusState>()(
  persist(
    (set, get) => ({
      session: undefined,
      start: (task) => {
        const session = get().session;
        if (session?.taskId === task.id && session.status !== "completed")
          return;
        set({ session: startFocusSession(task) });
      },
      pause: () => {
        const session = get().session;
        if (!session || session.status !== "running") return;
        const remainingSeconds = remainingFocusSeconds(session);
        set({
          session: {
            ...session,
            remainingSeconds,
            deadlineMs: undefined,
            status: remainingSeconds ? "paused" : "completed",
          },
        });
      },
      resume: () => {
        const session = get().session;
        if (!session || session.status !== "paused") return;
        set({
          session: {
            ...session,
            deadlineMs: Date.now() + session.remainingSeconds * 1000,
            status: "running",
          },
        });
      },
      complete: () => {
        const session = get().session;
        if (!session || session.status === "completed") return;
        set({
          session: {
            ...session,
            remainingSeconds: 0,
            deadlineMs: undefined,
            status: "completed",
          },
        });
      },
      dismiss: () => set({ session: undefined }),
      claimNotification: () => {
        const session = get().session;
        if (
          !session ||
          session.status !== "completed" ||
          session.notificationClaimed
        )
          return false;
        set({ session: { ...session, notificationClaimed: true } });
        return true;
      },
    }),
    {
      name: "daymate-focus-v1",
      storage: safeStateStorage(() => window.localStorage),
      partialize: ({ session }) => ({ session }),
      merge: (persisted, current) => ({
        ...current,
        session: restoreFocusSession(asRecord(persisted)?.session),
      }),
    },
  ),
);
