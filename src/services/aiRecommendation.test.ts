import { describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import {
  matchesAiMusicPreferences,
  prepareAiMusicRequest,
  resolveAiMusicRecommendation,
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
