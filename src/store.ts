import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Preferences, Priority, Task } from "./types";
import { normalizeAiDailyLimit } from "./services/aiPreferences";

const defaultPreferences: Preferences = {
  nickname: "朋友",
  role: "其他",
  tone: "gentle",
  theme: "system",
  trackActivity: true,
  trackWindowTitles: false,
  idleDetection: true,
  notifications: false,
  autostart: false,
  floatingBall: true,
  musicCategory: "smart",
  musicAutoplay: true,
  musicPlayMode: "shuffle",
  backgroundOffset: 0,
  aiEnabled: false,
  aiProvider: "sensenova",
  aiBaseUrl: "https://token.sensenova.cn/v1",
  aiModel: "sensenova-6.7-flash-lite",
  aiMaxDailyCalls: 20,
  aiShareActivitySummary: false,
};

interface AppState {
  onboarded: boolean;
  tasks: Task[];
  preferences: Preferences;
  finishOnboarding: (
    preferences: Partial<Preferences>,
    firstTask?: string,
  ) => void;
  addTask: (
    title: string,
    minutes: number,
    priority: Priority,
    dueDate?: string,
  ) => void;
  toggleTask: (id: string) => void;
  removeTask: (id: string) => void;
  updatePreferences: (next: Partial<Preferences>) => void;
  clearActivityData: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      onboarded: false,
      tasks: [],
      preferences: defaultPreferences,
      finishOnboarding: (preferences, firstTask) =>
        set((state) => ({
          onboarded: true,
          preferences: { ...state.preferences, ...preferences },
          tasks: firstTask?.trim()
            ? [
                ...state.tasks,
                {
                  id: crypto.randomUUID(),
                  title: firstTask.trim(),
                  estimatedMinutes: 25,
                  priority: "high",
                  completed: false,
                  createdAt: new Date().toISOString(),
                },
              ]
            : state.tasks,
        })),
      addTask: (title, estimatedMinutes, priority, dueDate) =>
        set((state) => ({
          tasks: [
            ...state.tasks,
            {
              id: crypto.randomUUID(),
              title: title.trim(),
              estimatedMinutes,
              priority,
              dueDate: dueDate || undefined,
              completed: false,
              createdAt: new Date().toISOString(),
            },
          ],
        })),
      toggleTask: (id) =>
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === id
              ? {
                  ...task,
                  completed: !task.completed,
                  completedAt: !task.completed
                    ? new Date().toISOString()
                    : undefined,
                }
              : task,
          ),
        })),
      removeTask: (id) =>
        set((state) => ({
          tasks: state.tasks.filter((task) => task.id !== id),
        })),
      updatePreferences: (next) =>
        set((state) => ({
          preferences: {
            ...state.preferences,
            ...next,
            aiMaxDailyCalls: normalizeAiDailyLimit(
              next.aiMaxDailyCalls ?? state.preferences.aiMaxDailyCalls,
            ),
          },
        })),
      clearActivityData: () => undefined,
    }),
    {
      name: "daymate-state-v1",
      merge: (persisted, current) => {
        const saved = persisted as Partial<AppState>;
        return {
          ...current,
          ...saved,
          preferences: {
            ...current.preferences,
            ...saved.preferences,
            aiMaxDailyCalls: normalizeAiDailyLimit(
              saved.preferences?.aiMaxDailyCalls,
            ),
            aiShareActivitySummary:
              saved.preferences?.aiShareActivitySummary === true,
          },
        };
      },
    },
  ),
);

export function selectNextTask(tasks: Task[]) {
  const priorityScore = { high: 3, medium: 2, low: 1 };
  return [...tasks]
    .filter((task) => !task.completed)
    .sort((a, b) => {
      const dueA = a.dueDate
        ? new Date(a.dueDate).getTime()
        : Number.MAX_SAFE_INTEGER;
      const dueB = b.dueDate
        ? new Date(b.dueDate).getTime()
        : Number.MAX_SAFE_INTEGER;
      if (dueA !== dueB) return dueA - dueB;
      if (priorityScore[a.priority] !== priorityScore[b.priority]) {
        return priorityScore[b.priority] - priorityScore[a.priority];
      }
      return a.estimatedMinutes - b.estimatedMinutes;
    })[0];
}
