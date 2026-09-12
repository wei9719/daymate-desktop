// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFocusStore } from "./focusStore";
import {
  remainingFocusSeconds,
  restoreFocusSession,
} from "./services/focusSession";
import type { Task } from "./types";

const task: Task = {
  id: "focus-task",
  title: "一小步",
  estimatedMinutes: 5,
  priority: "medium",
  completed: false,
  createdAt: "2026-09-12T00:00:00Z",
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-12T10:00:00Z"));
  useFocusStore.getState().dismiss();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("可恢复专注", () => {
  it("延迟回调不造成少计时，重新开始同任务保留原截止时刻", () => {
    useFocusStore.getState().start(task);
    const original = useFocusStore.getState().session!;
    vi.setSystemTime(Date.now() + 90_000);
    expect(remainingFocusSeconds(original)).toBe(210);
    useFocusStore.getState().start(task);
    expect(useFocusStore.getState().session).toEqual(original);
    vi.setSystemTime(Date.now() + 600_000);
    expect(remainingFocusSeconds(original)).toBe(0);
  });
  it("暂停保存剩余时间，重载恢复后不会计入暂停时间", async () => {
    useFocusStore.getState().start(task);
    vi.setSystemTime(Date.now() + 75_000);
    useFocusStore.getState().pause();
    expect(useFocusStore.getState().session?.remainingSeconds).toBe(225);
    vi.setSystemTime(Date.now() + 3600_000);
    await useFocusStore.persist.rehydrate();
    expect(remainingFocusSeconds(useFocusStore.getState().session!)).toBe(225);
    useFocusStore.getState().resume();
    expect(useFocusStore.getState().session?.deadlineMs).toBe(
      Date.now() + 225_000,
    );
  });
  it("运行会话可从独立记录恢复，重复完成和通知不会重置结果", async () => {
    useFocusStore.getState().start(task);
    const saved = JSON.parse(localStorage.getItem("daymate-focus-v1")!) as {
      state: { session: unknown };
    };
    vi.setSystemTime(Date.now() + 120_000);
    expect(
      remainingFocusSeconds(restoreFocusSession(saved.state.session)!),
    ).toBe(180);
    useFocusStore.getState().complete();
    expect(useFocusStore.getState().claimNotification()).toBe(true);
    useFocusStore.getState().complete();
    await useFocusStore.persist.rehydrate();
    expect(useFocusStore.getState().claimNotification()).toBe(false);
  });
  it("忽略损坏会话并丢弃无关字段", () => {
    expect(
      restoreFocusSession({ status: "running", durationSeconds: Infinity }),
    ).toBeUndefined();
    useFocusStore.getState().start(task);
    expect(
      restoreFocusSession({
        ...useFocusStore.getState().session,
        extra: "not persisted",
      }),
    ).not.toHaveProperty("extra");
    expect(
      restoreFocusSession({
        ...useFocusStore.getState().session,
        deadlineMs: -1,
      }),
    ).toBeUndefined();
  });
});
