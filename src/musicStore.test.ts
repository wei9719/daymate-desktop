// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useMusicPreferenceStore } from "./musicStore";
import type { SmartTrack } from "./services/music";
const key = "daymate-music-feedback-v1";
const track: SmartTrack = {
  id: "audius-safe",
  title: "Sample",
  artist: "Artist",
  scene: "专注",
  reason: "测试",
  audioUrl: "https://api.audius.co/v1/tracks/safe/stream",
  sourceUrl: "https://audius.co",
  source: "Audius",
  license: "官方可流式播放",
};
beforeEach(() => {
  localStorage.clear();
  useMusicPreferenceStore.setState({ feedback: [], recentIds: [] });
});
describe("本机音乐反馈", () => {
  it("同一标记再按撤销，切换标记替换且可单独删除", () => {
    const actions = useMusicPreferenceStore.getState();
    actions.rateTrack(track, "focus", "like");
    expect(useMusicPreferenceStore.getState().feedback[0].rating).toBe("like");
    actions.rateTrack(track, "focus", "like");
    expect(useMusicPreferenceStore.getState().feedback).toEqual([]);
    actions.rateTrack(track, "focus", "like");
    actions.rateTrack(track, "focus", "dislike");
    expect(useMusicPreferenceStore.getState().feedback).toHaveLength(1);
    actions.removeFeedback(track.id);
    expect(useMusicPreferenceStore.getState().feedback).toEqual([]);
  });
  it("只持久化反馈，不保存音频URL、会话心情或近期播放记录", () => {
    const actions = useMusicPreferenceStore.getState();
    actions.rateTrack(track, "focus", "like");
    actions.rememberTrack(track.id);
    const data = JSON.parse(localStorage.getItem(key) ?? "{}");
    expect(Object.keys(data.state)).toEqual(["feedback"]);
    expect(data.state.feedback[0]).not.toHaveProperty("audioUrl");
    expect(data.state).not.toHaveProperty("recentIds");
    expect(data.state).not.toHaveProperty("mood");
  });
  it("重启恢复过滤坏字段和方法，清空不影响主应用任务配置", async () => {
    localStorage.setItem("daymate-state-v1", "unrelated-state");
    const actions = useMusicPreferenceStore.getState();
    actions.rateTrack(track, "ambient", "dislike");
    const data = JSON.parse(localStorage.getItem(key) ?? "{}");
    data.state.clearFeedback = "overwritten";
    data.state.feedback[0].apiKey = "not-kept";
    localStorage.setItem(key, JSON.stringify(data));
    await useMusicPreferenceStore.persist.rehydrate();
    expect(useMusicPreferenceStore.getState().clearFeedback).toBe(
      actions.clearFeedback,
    );
    expect(useMusicPreferenceStore.getState().feedback[0]).not.toHaveProperty(
      "apiKey",
    );
    actions.clearFeedback();
    expect(useMusicPreferenceStore.getState().feedback).toEqual([]);
    expect(localStorage.getItem("daymate-state-v1")).toBe("unrelated-state");
  });
  it("最近播放去重并限制30个，危险ID不进入记录", () => {
    for (let i = 0; i < 40; i++)
      useMusicPreferenceStore.getState().rememberTrack(`audius-${i}`);
    const actions = useMusicPreferenceStore.getState();
    actions.rememberTrack("../../private");
    expect(useMusicPreferenceStore.getState().recentIds).toHaveLength(30);
    actions.rememberTrack("audius-20");
    expect(new Set(useMusicPreferenceStore.getState().recentIds).size).toBe(30);
  });
});
