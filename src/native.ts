import { invoke } from "@tauri-apps/api/core";

export interface TodayStats {
  activeSeconds: number;
  idleSeconds: number;
  appSwitches: number;
  mouseClicks: number;
  keyPresses: number;
  lastInputSecondsAgo: number;
  currentApp?: string;
  topApps: { appName: string; seconds: number; iconDataUrl?: string }[];
}

const emptyStats: TodayStats = {
  activeSeconds: 0,
  idleSeconds: 0,
  appSwitches: 0,
  mouseClicks: 0,
  keyPresses: 0,
  lastInputSecondsAgo: 0,
  topApps: [],
};

function isDesktop() {
  return "__TAURI_INTERNALS__" in window;
}

export async function getTodayStats() {
  if (!isDesktop()) return emptyStats;
  return invoke<TodayStats>("get_today_stats");
}

export async function setNativeTracking(
  enabled: boolean,
  includeTitles: boolean,
  detectIdle: boolean,
) {
  if (isDesktop())
    await invoke("set_tracking", { enabled, includeTitles, detectIdle });
}

export async function deleteNativeActivity() {
  if (isDesktop()) await invoke("delete_activity_data");
}

export async function getDataLocation() {
  if (!isDesktop()) return "浏览器预览模式不会创建活动数据库";
  return invoke<string>("data_location");
}

export async function showCompanionMenu() {
  if (isDesktop()) await invoke("show_companion_menu");
}

export async function saveAiKey(
  provider: string,
  baseUrl: string,
  apiKey: string,
) {
  if (!isDesktop()) throw new Error("请在 DayMate 桌面版中保存密钥");
  await invoke("save_ai_key", { provider, baseUrl, apiKey });
}

export interface AiKeyStatus {
  saved: boolean;
  usable: boolean;
  message: string;
}

export async function getAiKeyStatus(provider: string, baseUrl: string) {
  if (!isDesktop()) return { saved: false, usable: false, message: "" };
  return invoke<AiKeyStatus>("get_ai_key_status", { provider, baseUrl });
}

export async function deleteAiKey(provider: string) {
  if (isDesktop()) await invoke("delete_ai_key", { provider });
}

export async function testAiConnection(
  provider: string,
  baseUrl: string,
  model: string,
  needsKey: boolean,
  maxDailyCalls: number,
) {
  if (!isDesktop()) throw new Error("请在 DayMate 桌面版中测试连接");
  return invoke<string>("test_ai_connection", {
    provider,
    baseUrl,
    model,
    needsKey,
    maxDailyCalls,
  });
}

export interface AiMusicRequest {
  provider: string;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  maxDailyCalls: number;
  preferredCategory: string;
  activeMinutes: number | null;
  unfinishedTasks: number | null;
}

export interface AiMusicResponse {
  category: string;
  reason: string;
  source: "ai" | "cache";
}

export interface AiUsage {
  date: string;
  calls: number;
}

export async function getAiUsage() {
  if (!isDesktop()) return { date: "", calls: 0 };
  return invoke<AiUsage>("get_ai_usage");
}

export async function recommendMusicWithAi(input: AiMusicRequest) {
  if (!isDesktop()) throw new Error("请在 DayMate 桌面版中使用 AI 推荐");
  return invoke<AiMusicResponse>("recommend_music_with_ai", { ...input });
}
