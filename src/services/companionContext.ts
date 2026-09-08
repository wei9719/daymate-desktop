import type { CompanionScene, CompanionMood } from "../types";

export const companionScenes: { id: CompanionScene; label: string }[] = [
  { id: "auto", label: "按当前时段" },
  { id: "start", label: "准备开始" },
  { id: "focus", label: "专心做事" },
  { id: "relax", label: "放松一下" },
  { id: "rest", label: "休息片刻" },
  { id: "sleep", label: "准备入睡" },
];
export const companionMoods: { id: CompanionMood; label: string }[] = [
  { id: "neutral", label: "平常心" },
  { id: "low", label: "有点低落" },
  { id: "tense", label: "有点紧绷" },
  { id: "tired", label: "有些疲惫" },
  { id: "good", label: "心情不错" },
];
export const companionTones = {
  gentle: "温柔陪伴",
  fun: "轻松幽默",
  direct: "简洁直接",
  energetic: "热血鼓励",
};
export interface CompanionContext {
  scene: CompanionScene;
  mood: CompanionMood;
  hour: number;
}
export function currentCompanionContext(
  scene: CompanionScene = "auto",
  mood: CompanionMood = "neutral",
): CompanionContext {
  return { scene, mood, hour: new Date().getHours() };
}
