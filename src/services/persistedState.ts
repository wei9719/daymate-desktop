import type { PersistStorage } from "zustand/middleware";
import type { Preferences, Task } from "../types";
import { aiProviders } from "./aiProviders";
import { normalizeAiDailyLimit } from "./aiPreferences";

const maxStoredCharacters = 5_000_000;
const maxTasks = 10_000;
let fallbackIdCounter = 0;

export function createTaskId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  fallbackIdCounter += 1;
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const random = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `task-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}-${random}`;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(
  value: unknown,
  fallback: string,
  maximum: number,
  allowEmpty = false,
) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || allowEmpty ? trimmed.slice(0, maximum) : fallback;
}

function choice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && allowed.some((item) => item === value)
    ? (value as T)
    : fallback;
}

function flag(
  record: Record<string, unknown>,
  key: keyof Preferences,
  fallback: boolean,
  invalid = fallback,
): boolean {
  const value = record[key];
  return value === undefined
    ? fallback
    : typeof value === "boolean"
      ? value
      : invalid;
}

export function restorePreferences(
  value: unknown,
  defaults: Preferences,
): Preferences {
  const saved = asRecord(value) ?? {};
  return {
    nickname: text(saved.nickname, defaults.nickname, 100, true),
    role: text(saved.role, defaults.role, 100),
    tone: choice(
      saved.tone,
      ["gentle", "fun", "direct", "energetic"],
      defaults.tone,
    ),
    theme: choice(saved.theme, ["system", "light", "dark"], defaults.theme),
    trackActivity: flag(saved, "trackActivity", defaults.trackActivity, false),
    trackWindowTitles: flag(
      saved,
      "trackWindowTitles",
      defaults.trackWindowTitles,
      false,
    ),
    idleDetection: flag(saved, "idleDetection", defaults.idleDetection, true),
    notifications: flag(saved, "notifications", defaults.notifications, false),
    autostart: flag(saved, "autostart", defaults.autostart, false),
    floatingBall: flag(saved, "floatingBall", defaults.floatingBall),
    musicCategory: choice(
      saved.musicCategory,
      ["smart", "focus", "chinese", "classical", "ambient", "electronic"],
      defaults.musicCategory,
    ),
    musicAutoplay: flag(saved, "musicAutoplay", defaults.musicAutoplay),
    musicPlayMode: choice(
      saved.musicPlayMode,
      ["sequence", "shuffle", "single"],
      defaults.musicPlayMode,
    ),
    backgroundOffset:
      typeof saved.backgroundOffset === "number" &&
      Number.isSafeInteger(saved.backgroundOffset) &&
      saved.backgroundOffset >= 0
        ? saved.backgroundOffset
        : defaults.backgroundOffset,
    aiEnabled: flag(saved, "aiEnabled", defaults.aiEnabled, false),
    aiProvider: choice(
      saved.aiProvider,
      aiProviders.map((provider) => provider.id),
      defaults.aiProvider,
    ),
    aiBaseUrl: text(saved.aiBaseUrl, defaults.aiBaseUrl, 2048, true),
    aiModel: text(saved.aiModel, defaults.aiModel, 200, true),
    aiMaxDailyCalls:
      saved.aiMaxDailyCalls === undefined
        ? defaults.aiMaxDailyCalls
        : normalizeAiDailyLimit(saved.aiMaxDailyCalls),
    aiShareActivitySummary: flag(
      saved,
      "aiShareActivitySummary",
      defaults.aiShareActivitySummary,
      false,
    ),
  };
}

function validTimestamp(value: unknown) {
  return typeof value === "string" &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

export function validDueDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

export function validTaskMinutes(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(1440, Math.max(1 / 60, value))
    : 25;
}

export function restoreTasks(value: unknown): Task[] {
  if (!Array.isArray(value)) return [];
  const restored: Task[] = [];
  const ids = new Set<string>();
  for (const candidate of value.slice(0, maxTasks)) {
    const task = asRecord(candidate);
    if (!task) continue;
    const title = text(task.title, "", 1000);
    if (!title) continue;
    let id = text(task.id, "", 128);
    if (!id || ids.has(id)) id = createTaskId();
    ids.add(id);
    const completed = task.completed === true;
    restored.push({
      id,
      title,
      estimatedMinutes: validTaskMinutes(task.estimatedMinutes),
      priority: choice(task.priority, ["high", "medium", "low"], "medium"),
      completed,
      createdAt: validTimestamp(task.createdAt) ?? "1970-01-01T00:00:00.000Z",
      dueDate: validDueDate(task.dueDate),
      completedAt: completed ? validTimestamp(task.completedAt) : undefined,
    });
  }
  return restored;
}

export function safeStateStorage(
  getStorage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">,
): PersistStorage<unknown> | undefined {
  let storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  try {
    storage = getStorage();
  } catch {
    return undefined;
  }
  const unreadableRecords = new Map<string, string>();
  const failedReads = new Set<string>();
  return {
    getItem(name) {
      let raw: string | null = null;
      try {
        raw = storage.getItem(name);
        failedReads.delete(name);
        if (raw === null) {
          unreadableRecords.delete(name);
          return null;
        }
        if (raw.length > maxStoredCharacters) {
          unreadableRecords.set(name, raw);
          return null;
        }
        const parsed = asRecord(JSON.parse(raw) as unknown);
        const state =
          parsed &&
          (Object.prototype.hasOwnProperty.call(parsed, "state")
            ? parsed.state
            : parsed);
        if (!asRecord(state)) {
          unreadableRecords.set(name, raw);
          return null;
        }
        unreadableRecords.delete(name);
        // Support both Zustand envelopes and early, unwrapped local data.
        return {
          state,
          version: 0,
        };
      } catch {
        if (raw !== null) unreadableRecords.set(name, raw);
        else failedReads.add(name);
        return null;
      }
    },
    setItem(name, value) {
      let serialized: string;
      let current: string | null;
      try {
        serialized = JSON.stringify(value);
        current = storage.getItem(name);
      } catch {
        throw new Error(
          "无法访问本地存储或保存当前数据，已有记录未被覆盖。请检查存储权限和可用空间。",
        );
      }
      const unreadable = unreadableRecords.get(name);
      if (failedReads.has(name) && current !== null) {
        throw new Error(
          "本地记录尚未成功读取，已有数据未被覆盖。请重新打开应用后再保存。",
        );
      }
      if (unreadable !== undefined && current !== null) {
        if (current !== unreadable) {
          throw new Error(
            "本地数据已发生变化，未执行覆盖。请重新打开应用读取最新记录。",
          );
        }
        const recoveryName = `${name}.recovery`;
        let recovery: string | null;
        try {
          recovery = storage.getItem(recoveryName);
        } catch {
          throw new Error(
            "无法读取本地恢复副本，原始记录已保留。请检查存储权限。",
          );
        }
        if (recovery !== null && recovery !== unreadable) {
          throw new Error(
            "已有另一份本地恢复副本，原始记录和副本均已保留。请先导出并清理旧恢复副本，再继续保存。",
          );
        }
        try {
          if (recovery === null) storage.setItem(recoveryName, unreadable);
          if (storage.getItem(recoveryName) !== unreadable)
            throw new Error("Backup verification failed");
        } catch {
          throw new Error(
            "无法保存本地恢复副本，原始记录未被覆盖。请先释放存储空间或导出原始记录。",
          );
        }
      }
      try {
        storage.setItem(name, serialized);
      } catch {
        throw new Error(
          "本地数据保存失败，已有记录和恢复副本已保留。请检查存储权限和可用空间。",
        );
      }
      unreadableRecords.delete(name);
      failedReads.delete(name);
    },
    removeItem(name) {
      try {
        storage.removeItem(name);
        unreadableRecords.delete(name);
        failedReads.delete(name);
      } catch {
        throw new Error("无法删除本地记录，请检查存储权限后重试。");
      }
    },
  };
}
