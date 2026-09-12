import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
let batch: typeof import("./music").recommendMusicBatch;
const context = {
  scene: "rest" as const,
  mood: "tense" as const,
  hour: 15,
  intent: "match" as const,
};
const body = (data: unknown[]) => new Response(JSON.stringify({ data }));
beforeEach(async () => {
  vi.resetModules();
  ({ recommendMusicBatch: batch } = await import("./music"));
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("心情检索与权限边界", () => {
  it("使用REST mood重复参数，缓存按查询和过滤区分且反馈不出网", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      body([{ id: "p", title: "Peace", mood: "Peaceful", genre: "Ambient" }]),
    );
    vi.stubGlobal("fetch", fetcher);
    const one = await batch(0, false, 15, "smart", "", { context });
    expect(one.tracks[0].mood).toBe("Peaceful");
    expect(
      new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.getAll("mood"),
    ).toEqual(["Peaceful", "Easygoing"]);
    await batch(1, false, 15, "smart", "", { context });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await batch(0, false, 15, "smart", "", {
      context: { ...context, scene: "auto", mood: "good", intent: "lift" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("feedback");
  });
  it("只有空的心情目录才扩大检索一次，并明确标注降级", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(body([]))
      .mockResolvedValueOnce(body([{ id: "plain", title: "No mood" }]));
    vi.stubGlobal("fetch", fetcher);
    const result = await batch(0, false, 15, "ambient", "", { context });
    expect(result.trace.moodFilterRelaxed).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      new URL(String(fetcher.mock.calls[1][0])).searchParams.has("mood"),
    ).toBe(false);
    expect(result.tracks[0].reason).toContain("不保证");
  });
  it("服务故障不重试，回退离线曲目也遵守不喜欢过滤", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("private"));
    vi.stubGlobal("fetch", fetcher);
    const result = await batch(0, false, 15, "ambient", "", {
      context,
      feedback: [
        {
          id: "local-calm-theme",
          title: "Calm",
          artist: "pebonius",
          category: "ambient",
          rating: "dislike",
          updatedAt: "2026-09-12T00:00:00Z",
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.trace.source).toBe("offline");
    expect(result.tracks.every((row) => row.id !== "local-calm-theme")).toBe(
      true,
    );
  });
  it("明确搜索不加入心情过滤，不把无结果伪装成搜到离线歌曲", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(body([]));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      batch(0, false, 15, "chinese", "天下", { context }),
    ).rejects.toThrow("没有找到");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      new URL(String(fetcher.mock.calls[0][0])).searchParams.has("mood"),
    ).toBe(false);
  });
  it("受限曲目不能进入候选，真实tags有界且不能用响应URL播放", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        body([
          { id: "gated", title: "Restricted", is_stream_gated: true },
          {
            id: "safe",
            title: "Safe",
            mood: "Peaceful",
            genre: "Ambient",
            tags: "rain,forest",
            stream: { url: "http://127.0.0.1/private" },
          },
        ]),
      ),
    );
    const result = await batch(0, false, 15, "ambient", "query", { context });
    expect(result.tracks.map((row) => row.id)).toEqual(["audius-safe"]);
    expect(result.tracks[0].audioUrl).toBe(
      "https://api.audius.co/v1/tracks/safe/stream",
    );
    result.tracks[0].tags?.push("poison");
    expect(
      (await batch(0, false, 15, "ambient", "query", { context })).tracks[0]
        .tags,
    ).not.toContain("poison");
  });
  it("明确找歌保留目录相关顺序，不被场景高分或近期记录挤出前五", async () => {
    const exact = {
      id: "exact",
      title: "天下",
      genre: "Pop",
      user: { name: "Exact artist" },
    };
    const others = Array.from({ length: 5 }, (_, i) => ({
      id: `other-${i}`,
      title: `Other ${i}`,
      genre: "Ambient",
      mood: "Peaceful",
      user: { name: `Artist ${i}` },
    }));
    const fetcher = vi.fn<typeof fetch>(async () => body([exact, ...others]));
    vi.stubGlobal("fetch", fetcher);
    const result = await batch(0, false, 15, "ambient", "天下", { context });
    expect(result.tracks.map((row) => row.id)).toEqual([
      "audius-exact",
      "audius-other-0",
      "audius-other-1",
      "audius-other-2",
      "audius-other-3",
    ]);
    const again = await batch(9, false, 15, "ambient", "天下", {
      context,
      recentIds: ["audius-exact"],
      feedback: [
        {
          id: "audius-other-4",
          title: "Other 4",
          artist: "Artist 4",
          category: "ambient",
          rating: "like",
          updatedAt: "2026-09-12T00:00:00Z",
        },
      ],
    });
    expect(again.tracks.map((row) => row.id)).toEqual(
      result.tracks.map((row) => row.id),
    );
    expect(again.trace.repeatRelaxed).toBe(false);
    expect(again.tracks.every((row) => row.recommendation?.score === 0)).toBe(
      true,
    );
    expect(again.tracks[0].recommendation?.reasons.join(" ")).toContain("搜索");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("搜索保序仍过滤受限、不喜欢和重复ID，不以精确命中绕过权限", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      body([
        { id: "gated", title: "天下", is_stream_gated: true },
        { id: "disliked", title: "天下" },
        { id: "safe", title: "天下 现场" },
        { id: "safe", title: "天下 重复" },
        { id: "last", title: "Other" },
      ]),
    );
    vi.stubGlobal("fetch", fetcher);
    const result = await batch(0, false, 15, "ambient", "天下", {
      context,
      feedback: [
        {
          id: "audius-disliked",
          title: "天下",
          artist: "Audius 独立音乐人",
          category: "ambient",
          rating: "dislike",
          updatedAt: "2026-09-12T00:00:00Z",
        },
      ],
    });
    expect(result.tracks.map((row) => row.id)).toEqual([
      "audius-safe",
      "audius-last",
    ]);
    expect(result.trace.excludedCount).toBe(1);
  });
  it("目录缺少作者时，喜欢另一首未知作者歌曲不会生成同作者归因", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        body([{ id: "unknown-b", title: "Unknown author" }]),
      ),
    );
    const result = await batch(0, false, 15, "ambient", "", {
      context,
      feedback: [
        {
          id: "audius-unknown-a",
          title: "Other unknown author",
          artist: "Audius 独立音乐人",
          category: "ambient",
          rating: "like",
          updatedAt: "2026-09-12T00:00:00Z",
        },
      ],
    });
    expect(result.tracks[0].recommendation?.score).toBe(0);
    expect(result.tracks[0].recommendation?.reasons.join(" ")).not.toContain(
      "这位音乐人",
    );
  });
});
