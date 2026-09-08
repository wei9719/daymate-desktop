import { describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import {
  matchesAiMusicPreferences,
  prepareAiMusicRequest,
  resolveAiMusicRecommendation,
  prepareEncouragementRequest,
  matchesEncouragementPreferences,
  resolveEncouragement,
} from "./aiRecommendation";

describe("AI 推荐数据边界与回退", () => {
  it("默认不读取或发送活动和任务统计", async () => {
    const preferences = {
      ...useAppStore.getState().preferences,
      aiEnabled: true,
      aiShareActivitySummary: false,
    };
    const stats = vi.fn(async () => 7200);
    const tasks = vi.fn(() => 8);
    const request = await prepareAiMusicRequest(preferences, stats, tasks);
    expect(stats).not.toHaveBeenCalled();
    expect(tasks).not.toHaveBeenCalled();
    expect(request.activeMinutes).toBeNull();
    expect(request.unfinishedTasks).toBeNull();
  });

  it("主动分享时只使用分钟与任务数量，设置改变使已预览的请求失效", async () => {
    const preferences = {
      ...useAppStore.getState().preferences,
      aiEnabled: true,
      aiShareActivitySummary: true,
    };
    const request = await prepareAiMusicRequest(
      preferences,
      async () => 123,
      () => 2,
    );
    expect(request.activeMinutes).toBe(2);
    expect(request.unfinishedTasks).toBe(2);
    expect(matchesAiMusicPreferences(request, preferences)).toBe(true);
    expect(
      matchesAiMusicPreferences(request, {
        ...preferences,
        aiShareActivitySummary: false,
      }),
    ).toBe(false);
    expect(
      matchesAiMusicPreferences(request, {
        ...preferences,
        aiProvider: "ollama",
      }),
    ).toBe(false);
  });

  it("网络错误或限额耗尽时保留用户音乐偏好并标明本地来源", async () => {
    const preferences = {
      ...useAppStore.getState().preferences,
      musicCategory: "chinese" as const,
    };
    const request = await prepareAiMusicRequest(
      preferences,
      async () => 0,
      () => 0,
    );
    const result = await resolveAiMusicRecommendation(request, async () => {
      throw new Error("今日额度用尽");
    });
    expect(result.category).toBe("chinese");
    expect(result.source).toBe("local");
  });

  it("拒绝不在现有曲库范围的模型类别", async () => {
    const request = await prepareAiMusicRequest(
      useAppStore.getState().preferences,
      async () => 0,
      () => 0,
    );
    const result = await resolveAiMusicRecommendation(request, async () => ({
      category: "execute-command",
      reason: "不要采用",
      source: "ai",
    }));
    expect(result.source).toBe("local");
    expect(result.reason).not.toContain("不要采用");
  });
});

describe("场景与独立鼓励", () => {
  const context = { scene: "sleep" as const, mood: "tired" as const, hour: 23 };
  it("音乐预览发送用户自选场景、心情和小时，不猜测心情", async () => {
    const preferences = {
      ...useAppStore.getState().preferences,
      aiEnabled: true,
    };
    const request = await prepareAiMusicRequest(
      preferences,
      async () => 0,
      () => 0,
      context,
    );
    expect(request).toMatchObject(context);
    expect(matchesAiMusicPreferences(request, preferences, context)).toBe(true);
    expect(
      matchesAiMusicPreferences(request, preferences, {
        ...context,
        mood: "good",
      }),
    ).toBe(false);
  });
  it("即使允许音乐摘要，鼓励也不带摘要字段或音乐偏好", () => {
    const request = prepareEncouragementRequest(
      { ...useAppStore.getState().preferences, aiShareActivitySummary: true },
      context,
    );
    expect(Object.keys(request).sort()).toEqual(
      [
        "provider",
        "baseUrl",
        "model",
        "needsKey",
        "maxDailyCalls",
        "scene",
        "mood",
        "hour",
        "tone",
      ].sort(),
    );
  });
  it("鼓励对服务设置、语气和场景变化失效", () => {
    const preferences = {
      ...useAppStore.getState().preferences,
      aiEnabled: true,
    };
    const request = prepareEncouragementRequest(preferences, context);
    expect(matchesEncouragementPreferences(request, preferences, context)).toBe(
      true,
    );
    expect(
      matchesEncouragementPreferences(
        request,
        { ...preferences, aiModel: "other" },
        context,
      ),
    ).toBe(false);
    expect(
      matchesEncouragementPreferences(
        request,
        { ...preferences, tone: "fun" },
        context,
      ),
    ).toBe(false);
    expect(
      matchesEncouragementPreferences(request, preferences, {
        ...context,
        scene: "focus",
      }),
    ).toBe(false);
  });
  it("鼓励失败温和回退，不暴露原始错误或密钥", async () => {
    const request = prepareEncouragementRequest(
      useAppStore.getState().preferences,
      context,
    );
    const result = await resolveEncouragement(request, async () => {
      throw new Error("sensitive-error");
    });
    expect(result.source).toBe("local");
    expect(result.text).toContain("休息");
    expect(result.text).not.toContain("sensitive-error");
  });
  it("保留缓存来源；无效文本回退且长文本有上限", async () => {
    const request = prepareEncouragementRequest(
      useAppStore.getState().preferences,
      context,
    );
    expect(
      await resolveEncouragement(request, async () => ({
        text: "安静休息",
        source: "cache",
      })),
    ).toEqual({ text: "安静休息", source: "cache" });
    expect(
      (
        await resolveEncouragement(request, async () => ({
          text: " ",
          source: "ai",
        }))
      ).source,
    ).toBe("local");
    expect(
      (
        await resolveEncouragement(request, async () => ({
          text: "字".repeat(999),
          source: "ai",
        }))
      ).text,
    ).toHaveLength(300);
  });
});
