import { describe, expect, it } from "vitest";
import { z } from "zod";
import fixture from "../data/music-eval-v1.json";
import type { SmartTrack } from "./music";
import {
  musicAlgorithmVersion,
  planMusic,
  rankMusicCandidates,
} from "./musicRanking";

const schema = z.object({
  id: z.string(),
  scene: z.enum(["auto", "start", "focus", "relax", "rest", "sleep"]),
  mood: z.enum(["neutral", "low", "tense", "tired", "good"]),
  intent: z.enum(["match", "lift"]),
  category: z.enum([
    "smart",
    "focus",
    "chinese",
    "classical",
    "ambient",
    "electronic",
  ]),
  hour: z.number().int().min(0).max(23),
});
const cases = fixture.cases.map((row) => schema.parse(row));
const tracks: SmartTrack[] = fixture.tracks.map((row) => ({
  ...row,
  id: `audius-${row.id}`,
  title: row.id,
  scene: "合成数据",
  reason: "固定测试样本",
  source: "Audius",
  license: "合成测试非播放授权",
  sourceUrl: "https://audius.co",
  audioUrl: `https://api.audius.co/v1/tracks/${row.id}/stream`,
}));

describe("离线推荐评测 synthetic-mood-v1", () => {
  it("固定目录12场景对照日期轮换基线，输出可重现元数据指标", () => {
    let oldMatches = 0,
      newMatches = 0,
      total = 0;
    const coverage = new Set<string>();
    for (const scenario of cases) {
      const plan = planMusic(scenario.category, false, scenario.hour, scenario);
      // Baseline reproduces v0.7 date/offset indexing on this same fixed pool.
      const baseline = Array.from(
        { length: 5 },
        (_, i) => tracks[(20699 + i) % tracks.length],
      );
      const result = rankMusicCandidates(
        tracks,
        plan,
        { context: scenario },
        "eval-v1",
      );
      expect(result).toEqual(
        rankMusicCandidates(tracks, plan, { context: scenario }, "eval-v1"),
      );
      const hits = (rows: readonly SmartTrack[]) =>
        rows.filter((row) => row.mood && plan.moods.includes(row.mood)).length;
      oldMatches += hits(baseline);
      newMatches += hits(result.tracks);
      total += result.tracks.length;
      result.tracks.forEach((row) => coverage.add(row.id));
      expect(
        result.tracks.every((row) =>
          tracks.some((candidate) => candidate.id === row.id),
        ),
      ).toBe(true);
    }
    expect(newMatches).toBeGreaterThan(oldMatches);
    expect(coverage.size).toBeGreaterThan(5);
    console.info(
      JSON.stringify({
        fixture: fixture.version,
        algorithm: musicAlgorithmVersion,
        scenarios: cases.length,
        topK: 5,
        baselineMoodTagHitRate: oldMatches / total,
        rerankedMoodTagHitRate: newMatches / total,
        catalogueCoverage: coverage.size / tracks.length,
        scope:
          "synthetic metadata only; not user satisfaction or clinical benefit",
      }),
    );
  });
  it("反馈与近期规约在所有场景成立，不以标签匹配率绕过用户选择", () => {
    for (const scenario of cases) {
      const result = rankMusicCandidates(
        tracks,
        planMusic(scenario.category, false, scenario.hour, scenario),
        {
          context: scenario,
          recentIds: ["audius-c"],
          feedback: [
            {
              id: "audius-j",
              title: "j",
              artist: "nine",
              category: "chinese",
              rating: "dislike",
              updatedAt: "2026-09-12T00:00:00Z",
            },
          ],
        },
        "eval-v1",
      );
      expect(
        result.tracks.some((row) => ["audius-c", "audius-j"].includes(row.id)),
      ).toBe(false);
      expect(new Set(result.tracks.map((row) => row.id)).size).toBe(
        result.tracks.length,
      );
    }
  });
});
