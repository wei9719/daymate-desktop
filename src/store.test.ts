import { describe, expect, it } from "vitest";
import { selectNextTask, useAppStore } from "./store";
import type { Task } from "./types";

function task(overrides: Partial<Task>): Task {
  return {
    id: crypto.randomUUID(),
    title: "任务",
    estimatedMinutes: 25,
    priority: "medium",
    completed: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("selectNextTask", () => {
  it("优先选择截止日期更近的未完成任务", () => {
    const result = selectNextTask([
      task({ title: "以后", dueDate: "2026-08-01", priority: "high" }),
      task({ title: "今天", dueDate: "2026-07-13", priority: "low" }),
    ]);
    expect(result?.title).toBe("今天");
  });

  it("忽略已完成任务并在同优先级选择更短任务", () => {
    const result = selectNextTask([
      task({ title: "完成", completed: true, priority: "high" }),
      task({ title: "较长", estimatedMinutes: 45 }),
      task({ title: "较短", estimatedMinutes: 5 }),
    ]);
    expect(result?.title).toBe("较短");
  });
});

describe("floating ball preference", () => {
  it("默认开启并允许用户关闭", () => {
    expect(useAppStore.getState().preferences.floatingBall).toBe(true);
    useAppStore.getState().updatePreferences({ floatingBall: false });
    expect(useAppStore.getState().preferences.floatingBall).toBe(false);
    useAppStore.getState().updatePreferences({ floatingBall: true });
  });
});

describe("music playback preferences", () => {
  it("默认开启随机推荐和自动连播", () => {
    const preferences = useAppStore.getState().preferences;
    expect(preferences.musicAutoplay).toBe(true);
    expect(preferences.musicPlayMode).toBe("shuffle");
  });
});

describe("AI 请求偏好", () => {
  it("默认不分享摘要，预算20次且限制在1至100之间", () => {
    expect(useAppStore.getState().preferences.aiShareActivitySummary).toBe(
      false,
    );
    expect(useAppStore.getState().preferences.aiMaxDailyCalls).toBe(20);
    useAppStore.getState().updatePreferences({ aiMaxDailyCalls: 500 });
    expect(useAppStore.getState().preferences.aiMaxDailyCalls).toBe(100);
    useAppStore.getState().updatePreferences({ aiMaxDailyCalls: 0 });
    expect(useAppStore.getState().preferences.aiMaxDailyCalls).toBe(1);
    useAppStore.getState().updatePreferences({ aiMaxDailyCalls: Number.NaN });
    expect(useAppStore.getState().preferences.aiMaxDailyCalls).toBe(20);
  });
});
