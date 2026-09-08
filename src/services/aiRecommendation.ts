import type { AiMusicRequest, AiMusicResponse } from "../native";
import type { Preferences } from "../types";
import { findAiProvider } from "./aiProviders";
import { normalizeAiDailyLimit } from "./aiPreferences";
import { musicCategories, type MusicCategory } from "./music";

export function matchesAiMusicPreferences(
  request: AiMusicRequest,
  preferences: Preferences,
) {
  return (
    preferences.aiEnabled &&
    request.provider === preferences.aiProvider &&
    request.baseUrl === preferences.aiBaseUrl &&
    request.model === preferences.aiModel &&
    request.preferredCategory === preferences.musicCategory &&
    request.maxDailyCalls ===
      normalizeAiDailyLimit(preferences.aiMaxDailyCalls) &&
    (request.activeMinutes !== null) === preferences.aiShareActivitySummary
  );
}

export async function prepareAiMusicRequest(
  preferences: Preferences,
  getActiveSeconds: () => Promise<number>,
  getUnfinishedCount: () => number,
): Promise<AiMusicRequest> {
  const shareSummary = preferences.aiShareActivitySummary;
  return {
    provider: preferences.aiProvider,
    baseUrl: preferences.aiBaseUrl,
    model: preferences.aiModel,
    needsKey: findAiProvider(preferences.aiProvider).needsKey,
    maxDailyCalls: normalizeAiDailyLimit(preferences.aiMaxDailyCalls),
    preferredCategory: preferences.musicCategory,
    activeMinutes: shareSummary
      ? Math.floor((await getActiveSeconds()) / 60)
      : null,
    unfinishedTasks: shareSummary ? getUnfinishedCount() : null,
  };
}

export async function resolveAiMusicRecommendation(
  request: AiMusicRequest,
  recommend: (request: AiMusicRequest) => Promise<AiMusicResponse>,
  hour = new Date().getHours(),
): Promise<{
  category: MusicCategory;
  reason: string;
  source: "ai" | "cache" | "local";
}> {
  try {
    const response = await recommend(request);
    const category = musicCategories.find(
      (item) => item.id === response.category,
    );
    if (!category) throw new Error("Unknown music category");
    return { ...response, category: category.id };
  } catch {
    const preferred = musicCategories.find(
      (item) => item.id === request.preferredCategory,
    );
    const category =
      preferred && preferred.id !== "smart"
        ? preferred.id
        : hour >= 9 && hour < 18
          ? "focus"
          : "ambient";
    return {
      category,
      reason: "AI 暂时不可用或已达到今日限额，已按你的音乐偏好和当前时段推荐。",
      source: "local",
    };
  }
}
