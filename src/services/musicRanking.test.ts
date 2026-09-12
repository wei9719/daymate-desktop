import { describe, expect, it } from "vitest";
import type { SmartTrack } from "./music";
import {
  planMusic,
  rankMusicCandidates,
  restoreMusicFeedback,
  type MusicFeedback,
} from "./musicRanking";

const track = (id: string, extra: Partial<SmartTrack> = {}): SmartTrack => ({
  id: `audius-${id}`,
  title: id,
  artist: id,
  audioUrl: `https://api.audius.co/v1/tracks/${id}/stream`,
  sourceUrl: "https://audius.co",
  license: "官方可流式播放",
  source: "Audius",
  scene: "测试",
  reason: "目录",
  ...extra,
});
const context = {
  scene: "auto" as const,
  mood: "low" as const,
  hour: 15,
  intent: "match" as const,
};
const feedback = (
  item: SmartTrack,
  rating: MusicFeedback["rating"],
): MusicFeedback => ({
  id: item.id,
  artist: item.artist,
  title: item.title,
  category: "focus",
  rating,
  updatedAt: "2026-09-12T00:00:00Z",
});

describe("版本化可解释音乐策略", () => {
  it("低落时陪伴与提神有不同检索目标，休息场景不被提神覆盖", () => {
    expect(planMusic("smart", false, 15, context).category).toBe("classical");
    expect(
      planMusic("smart", false, 15, { ...context, intent: "lift" }).category,
    ).toBe("electronic");
    expect(
      planMusic("smart", true, 23, {
        ...context,
        scene: "sleep",
        intent: "lift",
      }).category,
    ).toBe("ambient");
    expect(
      planMusic("smart", false, 15, { ...context, scene: "focus" }).category,
    ).toBe("focus");
    expect(planMusic("chinese", false, 15, context).category).toBe("chinese");
  });
  it("优先真实元数据而不是标题中虚构的mood信息，理由对应实际字段", () => {
    const rows = [
      track("b", { title: "Peaceful piano" }),
      track("a", { genre: "Classical", mood: "Peaceful" }),
    ];
    const result = rankMusicCandidates(
      rows,
      planMusic("smart", false, 15, context),
    );
    expect(result.tracks[0].id).toBe("audius-a");
    expect(result.tracks[0].recommendation?.score).toBe(20);
    expect(result.tracks[1].recommendation?.reasons.join("")).toContain(
      "元数据不足",
    );
    expect(result.tracks[1].recommendation?.reasons.join("")).not.toContain(
      "心情标签为",
    );
  });
  it("喜欢提高排序，不喜欢硬过滤；所有候选不喜欢时返回空不绕过", () => {
    const a = track("a");
    const b = track("b");
    const plan = planMusic("focus", false, 12);
    expect(
      rankMusicCandidates([a, b], plan, { feedback: [feedback(b, "like")] })
        .tracks[0].id,
    ).toBe(b.id);
    expect(
      rankMusicCandidates([a, b], plan, {
        feedback: [feedback(a, "dislike")],
      }).tracks.map((row) => row.id),
    ).toEqual([b.id]);
    expect(
      rankMusicCandidates([a, b], plan, {
        feedback: [feedback(a, "dislike"), feedback(b, "dislike")],
      }).tracks,
    ).toEqual([]);
  });
  it("有新歌时排除近期歌，候选耗尽才显式放宽近期限制", () => {
    const a = track("a"),
      b = track("b");
    const plan = planMusic("focus", false, 12);
    expect(
      rankMusicCandidates([a, b], plan, { recentIds: [a.id] }).tracks.map(
        (row) => row.id,
      ),
    ).toEqual([b.id]);
    const repeat = rankMusicCandidates([a, b], plan, {
      recentIds: [a.id, b.id],
    });
    expect(repeat.repeatRelaxed).toBe(true);
    expect(repeat.tracks[0].recommendation?.reasons.join("")).toContain(
      "允许重复",
    );
  });
  it("同歌手适当后移、输入不变且固定seed可以复现", () => {
    const rows = [
      track("a", { artist: "one", mood: "Peaceful" }),
      track("b", { artist: "one", mood: "Peaceful" }),
      track("c", { artist: "two", mood: "Peaceful" }),
    ];
    const before = JSON.stringify(rows);
    const plan = planMusic("ambient", false, 12, { ...context, mood: "tense" });
    const result = rankMusicCandidates(rows, plan, {}, "fixed");
    expect(result).toEqual(rankMusicCandidates(rows, plan, {}, "fixed"));
    expect(
      new Set(result.tracks.slice(0, 2).map((row) => row.artist)).size,
    ).toBe(2);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it("未知作者不获得同作者喜欢加分，也不参与同作者集中惩罚", () => {
    const a = track("unknown-a", { artist: "Audius 独立音乐人" });
    const b = track("unknown-b", { artist: "Audius 独立音乐人" });
    const empty = track("empty-artist", { artist: "" });
    const result = rankMusicCandidates(
      [b, empty],
      planMusic("ambient", false, 12),
      { feedback: [feedback(a, "like")] },
    );
    expect(result.tracks.map((row) => row.recommendation?.score)).toEqual([
      0, 0,
    ]);
    expect(
      result.tracks
        .flatMap((row) => row.recommendation?.reasons ?? [])
        .join(" "),
    ).not.toMatch(/这位音乐人|同一音乐人/);

    const sameUnknown = rankMusicCandidates(
      [a, b],
      planMusic("ambient", false, 12),
    );
    expect(sameUnknown.tracks.map((row) => row.recommendation?.score)).toEqual([
      0, 0,
    ]);
    expect(
      sameUnknown.tracks
        .flatMap((row) => row.recommendation?.reasons ?? [])
        .join(" "),
    ).not.toContain("同一音乐人");
    expect(
      rankMusicCandidates([a], planMusic("ambient", false, 12), {
        feedback: [feedback(a, "like")],
      }).tracks[0].recommendation?.score,
    ).toBe(6);
  });
  it("反馈逐字段恢复、去重取较新、限制200，不恢复注入内容或方法", () => {
    const item = feedback(track("good"), "like");
    const restored = restoreMusicFeedback([
      null,
      { ...item, apiKey: "must-not-retain" },
      { ...item, rating: "dislike", updatedAt: "2026-09-13T00:00:00Z" },
      { ...item, id: "../../unsafe" },
      { ...item, updatedAt: "invalid" },
    ]);
    expect(restored).toHaveLength(1);
    expect(restored[0].rating).toBe("dislike");
    expect(restored[0]).not.toHaveProperty("apiKey");
    expect(
      restoreMusicFeedback(
        Array.from({ length: 400 }, (_, i) =>
          feedback(track(String(i)), "like"),
        ),
      ),
    ).toHaveLength(200);
  });
  it("输出最多五首且不会出现重复ID", () => {
    const rows = Array.from({ length: 100 }, (_, i) => track(String(i)));
    const result = rankMusicCandidates(
      [...rows, rows[0]],
      planMusic("smart", false, 12),
    );
    expect(result.tracks).toHaveLength(5);
    expect(new Set(result.tracks.map((row) => row.id)).size).toBe(5);
  });
});
