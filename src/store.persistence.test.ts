// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./store";
import {
  createTaskId,
  restorePreferences,
  restoreTasks,
  safeStateStorage,
} from "./services/persistedState";

const preferences = { ...useAppStore.getState().preferences };
const storageName = "daymate-state-v1";
const originalActions = {
  addTask: useAppStore.getState().addTask,
  updatePreferences: useAppStore.getState().updatePreferences,
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({
    onboarded: false,
    tasks: [],
    preferences: { ...preferences },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("持久化数据安全恢复", () => {
  it("不把未知字段或伪造方法合并到应用状态", async () => {
    localStorage.setItem(
      storageName,
      JSON.stringify({
        state: {
          onboarded: "true",
          addTask: "broken",
          updatePreferences: null,
          attackerField: "ignored",
          preferences: {
            theme: "invalid",
            musicCategory: "evil",
            musicPlayMode: 2,
            trackActivity: "false",
            trackWindowTitles: "true",
            aiShareActivitySummary: "yes",
            aiMaxDailyCalls: "99",
          },
          tasks: [
            {
              id: "old-task",
              title: "旧任务",
              estimatedMinutes: -2,
              priority: "superhigh",
              completed: "false",
              createdAt: "invalid",
              dueDate: "2026-02-31",
              unexpected: "ignored",
            },
            null,
            { title: {} },
          ],
        },
        version: 0,
      }),
    );
    await useAppStore.persist.rehydrate();
    const state = useAppStore.getState();
    expect(state.addTask).toBe(originalActions.addTask);
    expect(state.updatePreferences).toBe(originalActions.updatePreferences);
    expect(state).not.toHaveProperty("attackerField");
    expect(state.onboarded).toBe(false);
    expect(state.preferences).toMatchObject({
      theme: "system",
      musicCategory: "smart",
      musicPlayMode: "shuffle",
      trackActivity: false,
      trackWindowTitles: false,
      aiShareActivitySummary: false,
      aiMaxDailyCalls: 20,
    });
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]).toMatchObject({
      id: "old-task",
      title: "旧任务",
      estimatedMinutes: 25,
      priority: "medium",
      completed: false,
      createdAt: "1970-01-01T00:00:00.000Z",
    });
    expect(state.tasks[0].dueDate).toBeUndefined();
    expect(state.tasks[0]).not.toHaveProperty("unexpected");
    state.addTask("新任务", 5, "high");
    expect(useAppStore.getState().tasks).toHaveLength(2);
  });

  it("兼容未包裹的旧版记录，保留合法内容并补齐新设置", async () => {
    localStorage.setItem(
      storageName,
      JSON.stringify({
        onboarded: true,
        tasks: [
          {
            id: "legacy",
            title: "整理旧计划",
            estimatedMinutes: 45,
            priority: "low",
            createdAt: "2026-07-01T12:00:00.000Z",
            completed: true,
            completedAt: "2026-07-02T12:00:00.000Z",
            dueDate: "2026-07-02",
          },
        ],
        preferences: {
          nickname: "小日",
          theme: "dark",
          musicCategory: "chinese",
          aiProvider: "custom",
          aiBaseUrl: "http://127.0.0.1:11434/v1",
          aiModel: "qwen:local",
        },
      }),
    );
    await useAppStore.persist.rehydrate();
    const state = useAppStore.getState();
    expect(state.onboarded).toBe(true);
    expect(state.tasks[0]).toMatchObject({
      id: "legacy",
      title: "整理旧计划",
      estimatedMinutes: 45,
      completed: true,
      dueDate: "2026-07-02",
    });
    expect(state.preferences).toMatchObject({
      nickname: "小日",
      theme: "dark",
      musicCategory: "chinese",
      aiProvider: "custom",
      aiBaseUrl: "http://127.0.0.1:11434/v1",
      aiModel: "qwen:local",
      aiShareActivitySummary: false,
      aiMaxDailyCalls: 20,
    });
  });

  it("损坏JSON不阻止启动、不覆盖当前数据，也不直接删除原始记录", async () => {
    useAppStore.getState().addTask("保留当前任务", 15, "medium");
    const malformed = '{"state": {"tasks": [';
    localStorage.setItem(storageName, malformed);
    await useAppStore.persist.rehydrate();
    expect(useAppStore.persist.hasHydrated()).toBe(true);
    expect(useAppStore.getState().tasks[0].title).toBe("保留当前任务");
    expect(localStorage.getItem(storageName)).toBe(malformed);
  });

  it("损坏JSON恢复后修改设置和新增任务，会先保留原始恢复副本", async () => {
    const malformed = '{"state":{"tasks":[{"title":"可人工找回的任务"}]';
    localStorage.setItem(storageName, malformed);
    await useAppStore.persist.rehydrate();
    useAppStore.getState().updatePreferences({ nickname: "新设置" });
    expect(localStorage.getItem(`${storageName}.recovery`)).toBe(malformed);
    useAppStore.getState().addTask("恢复后新任务", 15, "medium");
    expect(localStorage.getItem(`${storageName}.recovery`)).toBe(malformed);
    const saved = JSON.parse(localStorage.getItem(storageName) ?? "{}");
    expect(saved.state.preferences.nickname).toBe("新设置");
    expect(saved.state.tasks[0].title).toBe("恢复后新任务");
  });

  it("恢复副本因配额不足无法写入时拒绝覆盖损坏原文", async () => {
    const malformed = '{"state":';
    localStorage.setItem(storageName, malformed);
    await useAppStore.persist.rehydrate();
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key === `${storageName}.recovery`)
        throw new DOMException("quota", "QuotaExceededError");
      setItem.call(this, key, value);
    });
    expect(() =>
      useAppStore.getState().updatePreferences({ nickname: "待保存" }),
    ).toThrow(/无法保存本地恢复副本/);
    expect(localStorage.getItem(storageName)).toBe(malformed);
    expect(localStorage.getItem(`${storageName}.recovery`)).toBeNull();
  });

  it("不会覆盖已有的不同恢复副本或主记录", async () => {
    const malformed = '{"state":';
    localStorage.setItem(`${storageName}.recovery`, "更早的一份原始记录");
    localStorage.setItem(storageName, malformed);
    await useAppStore.persist.rehydrate();
    expect(() =>
      useAppStore.getState().addTask("待保存任务", 5, "high"),
    ).toThrow(/已有另一份本地恢复副本/);
    expect(localStorage.getItem(storageName)).toBe(malformed);
    expect(localStorage.getItem(`${storageName}.recovery`)).toBe(
      "更早的一份原始记录",
    );
  });

  it("相同恢复副本可复用；主记录写入失败仍保留两份原文", async () => {
    const malformed = '{"state":';
    localStorage.setItem(`${storageName}.recovery`, malformed);
    localStorage.setItem(storageName, malformed);
    await useAppStore.persist.rehydrate();
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key === storageName)
        throw new DOMException("quota", "QuotaExceededError");
      setItem.call(this, key, value);
    });
    expect(() =>
      useAppStore.getState().updatePreferences({ nickname: "待保存" }),
    ).toThrow(/本地数据保存失败/);
    expect(localStorage.getItem(storageName)).toBe(malformed);
    expect(localStorage.getItem(`${storageName}.recovery`)).toBe(malformed);
  });

  it("恢复前发现主记录已被外部修复时拒绝用旧状态覆盖", async () => {
    localStorage.setItem(storageName, '{"state":');
    await useAppStore.persist.rehydrate();
    const repaired = JSON.stringify({
      state: {
        onboarded: true,
        tasks: [],
        preferences: { nickname: "人工修复" },
      },
    });
    localStorage.setItem(storageName, repaired);
    expect(() =>
      useAppStore.getState().updatePreferences({ nickname: "旧状态" }),
    ).toThrow(/本地数据已发生变化/);
    expect(localStorage.getItem(storageName)).toBe(repaired);
  });

  it("存储读取权限中途失效时不尝试写入", () => {
    const writer = vi.spyOn(Storage.prototype, "setItem");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() =>
      useAppStore.getState().updatePreferences({ nickname: "待保存" }),
    ).toThrow(/无法访问本地存储/);
    expect(writer).not.toHaveBeenCalled();
  });

  it("首次读取失败后必须重新读取，避免用默认状态覆盖原有正常记录", async () => {
    const original = JSON.stringify({
      state: {
        onboarded: true,
        tasks: [],
        preferences: { nickname: "已有记录" },
      },
    });
    localStorage.setItem(storageName, original);
    vi.spyOn(Storage.prototype, "getItem").mockImplementationOnce(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    await useAppStore.persist.rehydrate();
    expect(() =>
      useAppStore.getState().updatePreferences({ nickname: "尚未读取的状态" }),
    ).toThrow(/本地记录尚未成功读取/);
    expect(localStorage.getItem(storageName)).toBe(original);
    await useAppStore.persist.rehydrate();
    expect(useAppStore.getState().preferences.nickname).toBe("已有记录");
    expect(() =>
      useAppStore.getState().updatePreferences({ nickname: "已恢复访问" }),
    ).not.toThrow();
  });

  it.each([null, [], false, 22, "invalid"])(
    "错误根结构 %j 会安全保留当前状态",
    async (value) => {
      localStorage.setItem(storageName, JSON.stringify(value));
      await useAppStore.persist.rehydrate();
      expect(useAppStore.getState().preferences).toEqual(preferences);
      expect(typeof useAppStore.getState().addTask).toBe("function");
    },
  );

  it("重复任务ID会修复，合法任务不因相邻坏记录丢失", () => {
    const tasks = restoreTasks([
      { id: "same", title: "第一项", estimatedMinutes: 0 },
      {
        id: "same",
        title: "第二项",
        estimatedMinutes: Number.POSITIVE_INFINITY,
      },
      { title: "缺少ID的任务" },
      false,
    ]);
    expect(tasks.map((task) => task.title)).toEqual([
      "第一项",
      "第二项",
      "缺少ID的任务",
    ]);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(3);
    expect(tasks.every((task) => task.estimatedMinutes === 25)).toBe(true);
  });

  it("限制不可信字段长度，忽略额外配置字段", () => {
    const restored = restorePreferences(
      {
        nickname: "x".repeat(10_000),
        backgroundOffset: -1,
        aiBaseUrl: 123,
        apiKey: "not-allowed",
        __proto__: { injected: true },
      },
      preferences,
    );
    expect(restored.nickname).toHaveLength(100);
    expect(restored.backgroundOffset).toBe(0);
    expect(restored.aiBaseUrl).toBe(preferences.aiBaseUrl);
    expect(restored).not.toHaveProperty("apiKey");
    expect(restored).not.toHaveProperty("injected");
    useAppStore
      .getState()
      .addTask("正常任务", Number.NaN, "medium", "not-a-date");
    const serialized = JSON.parse(localStorage.getItem(storageName) ?? "{}");
    expect(Object.keys(serialized.state).sort()).toEqual([
      "onboarded",
      "preferences",
      "tasks",
    ]);
    expect(serialized.state.tasks[0].estimatedMinutes).toBe(25);
  });

  it("旧WebView缺少randomUUID时仍可生成不同ID和新增任务", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(7),
    });
    const first = createTaskId();
    const second = createTaskId();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^task-/);
    useAppStore.getState().addTask("兼容模式任务", 5, "high");
    expect(useAppStore.getState().tasks[0].id).toMatch(/^task-/);
  });

  it("存储不可访问时允许内存模式；超大记录不会送入状态解析", () => {
    expect(
      safeStateStorage(() => {
        throw new Error("blocked");
      }),
    ).toBeUndefined();
    const storage = safeStateStorage(() => ({
      getItem: () => "x".repeat(5_000_001),
      setItem: () => undefined,
      removeItem: () => undefined,
    }));
    expect(storage?.getItem(storageName)).toBeNull();
  });
});
