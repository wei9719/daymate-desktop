import type {
  AiMusicRequest,
  AiMusicResponse,
  AiEncouragementRequest,
  AiEncouragementResponse,
} from "../native";
import type { Preferences } from "../types";
import { findAiProvider } from "./aiProviders";
import { normalizeAiDailyLimit } from "./aiPreferences";
import { musicCategories, type MusicCategory } from "./music";
import {
  currentCompanionContext,
  type CompanionContext,
} from "./companionContext";

function matchesAiConnection(
  request: Pick<
    AiMusicRequest,
    "provider" | "baseUrl" | "model" | "maxDailyCalls"
  >,
  preferences: Preferences,
) {
  return (
    preferences.aiEnabled &&
    request.provider === preferences.aiProvider &&
    request.baseUrl === preferences.aiBaseUrl &&
    request.model === preferences.aiModel &&
    request.maxDailyCalls === normalizeAiDailyLimit(preferences.aiMaxDailyCalls)
  );
}

function matchesContext(request: CompanionContext, context?: CompanionContext) {
  return (
    !context ||
    (request.scene === context.scene &&
      request.mood === context.mood &&
      request.hour === context.hour)
  );
}

export function matchesAiMusicPreferences(
  request: AiMusicRequest,
  preferences: Preferences,
  context?: CompanionContext,
) {
  return (
    matchesAiConnection(request, preferences) &&
    matchesContext(request, context) &&
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
  context = currentCompanionContext(),
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
    scene: context.scene,
    mood: context.mood,
    hour: context.hour,
  };
}

export async function resolveAiMusicRecommendation(
  request: AiMusicRequest,
  recommend: (request: AiMusicRequest) => Promise<AiMusicResponse>,
  hour = request.hour,
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
    if (
      (response.source !== "ai" && response.source !== "cache") ||
      typeof response.reason !== "string"
    )
      throw new Error("Invalid AI response");
    return {
      ...response,
      category: category.id,
      reason: response.reason.slice(0, 500),
    };
  } catch {
    const preferred = musicCategories.find(
      (item) => item.id === request.preferredCategory,
    );
    const category =
      preferred && preferred.id !== "smart"
        ? preferred.id
        : request.scene === "sleep" ||
            request.scene === "rest" ||
            request.scene === "relax" ||
            request.mood === "tense" ||
            request.mood === "tired"
          ? "ambient"
          : request.scene === "focus" ||
              request.scene === "start" ||
              (hour >= 9 && hour < 18)
            ? "focus"
            : "ambient";
    return {
      category,
      reason:
        "AI 暂时不可用或已达到今日限额，已按你的音乐偏好、场景和当前时段推荐。",
      source: "local",
    };
  }
}

export function prepareEncouragementRequest(
  preferences: Preferences,
  context = currentCompanionContext(),
): AiEncouragementRequest {
  return {
    provider: preferences.aiProvider,
    baseUrl: preferences.aiBaseUrl,
    model: preferences.aiModel,
    needsKey: findAiProvider(preferences.aiProvider).needsKey,
    maxDailyCalls: normalizeAiDailyLimit(preferences.aiMaxDailyCalls),
    scene: context.scene,
    mood: context.mood,
    hour: context.hour,
    tone: preferences.tone,
  };
}

export function matchesEncouragementPreferences(
  request: AiEncouragementRequest,
  preferences: Preferences,
  context?: CompanionContext,
) {
  return (
    matchesAiConnection(request, preferences) &&
    matchesContext(request, context) &&
    request.tone === preferences.tone
  );
}

export async function resolveEncouragement(
  request: AiEncouragementRequest,
  generate: (
    request: AiEncouragementRequest,
  ) => Promise<AiEncouragementResponse>,
) {
  try {
    const response = await generate(request);
    if (
      !response ||
      typeof response.text !== "string" ||
      !response.text.trim() ||
      !["ai", "cache"].includes(response.source)
    )
      throw new Error("Invalid encouragement");
    return {
      text: response.text.trim().slice(0, 300),
      source: response.source,
    };
  } catch {
    const text =
      request.scene === "sleep"
        ? "今天先到这里吧。没做完的事情可以明天再看，休息也是照顾自己。"
        : request.mood === "tired" || request.scene === "rest"
          ? "有些累了就停一小会儿。喝口水、伸个懒腰，不需要每一分钟都有产出。"
          : request.mood === "low" || request.mood === "tense"
            ? "现在不用把所有事情都想明白。先做一件很小的事，或者安静休息一会儿，都可以。"
            : request.tone === "fun"
              ? "状态还在加载也没关系。先做五分钟，给今天一个轻轻的开场。"
              : request.tone === "direct"
                ? "选一件小事，先做五分钟。做完再决定下一步。"
                : request.tone === "energetic"
                  ? "从一个小行动开始就很好。你已经走到了这里，今天也可以按自己的节奏前进。"
                  : "不用准备好才开始。先迈出小小一步，也记得给自己留一点轻松的时间。";
    return { text, source: "local" as const };
  }
}
