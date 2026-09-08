import { afterEach, describe, expect, it, vi } from "vitest";
import {
  musicEndAction,
  musicScene,
  nextMusicOffset,
  parseAudiusTracks,
  recommendMusic,
  bundledRecommendation,
} from "./music";

describe("music recommendation", () => {
  it("支持随机、自动连播与单曲循环", () => {
    expect(nextMusicOffset("shuffle", () => 0.5)).toBe(20);
    expect(nextMusicOffset("sequence")).toBe(1);
    expect(musicEndAction("single", false)).toBe("repeat");
    expect(musicEndAction("shuffle", true)).toBe("next");
    expect(musicEndAction("sequence", false)).toBe("stop");
  });

  it("工作时有任务会选择轻柔器乐场景", () => {
    expect(musicScene(11, true).scene).toBe("轻柔专注");
  });

  it("解析 Audius 官方可播放曲目", () => {
    const tracks = parseAudiusTracks(
      {
        data: [
          {
            id: "abc",
            title: "Quiet Day",
            permalink: "/artist/quiet-day",
            is_streamable: true,
            stream: { url: "https://audio.example/quiet.mp3" },
            user: { name: "Demo Artist" },
          },
        ],
      },
      musicScene(11, true),
    );
    expect(tracks[0]).toMatchObject({
      id: "audius-abc",
      title: "Quiet Day",
      artist: "Demo Artist",
      source: "Audius",
    });
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("不可信音乐响应", () => {
  it.each([
    null,
    [],
    false,
    { data: null },
    { data: {} },
    { data: [null, false, 12, {}, { id: "bad", title: {} }] },
  ])("错误结构不会使播放器崩溃：%j", (payload) => {
    expect(parseAudiusTracks(payload, musicScene(11, true))).toEqual([]);
  });

  it.each([
    "http://127.0.0.1/audio",
    "https://localhost/audio",
    "https://192.168.1.2/music",
    "https://10.1.2.3/audio",
    "https://[::1]/audio",
    "https://user:password@audio.example/track",
    "javascript:alert(1)",
    "file:///C:/private.wav",
    "https://arbitrary.example/track",
  ])("不会把响应中的地址 %s 用作播放URL", (streamUrl) => {
    const tracks = parseAudiusTracks(
      {
        data: [
          {
            id: "safe-id",
            title: "安全路径",
            stream: { url: streamUrl },
            permalink: streamUrl,
          },
        ],
      },
      musicScene(11, true),
    );
    expect(tracks).toHaveLength(1);
    expect(tracks[0].audioUrl).toBe(
      "https://api.audius.co/v1/tracks/safe-id/stream",
    );
    expect(tracks[0].sourceUrl).toBe("https://audius.co");
  });

  it("拒绝路径注入、错误可播放标识和重复曲目", () => {
    const tracks = parseAudiusTracks(
      {
        data: [
          { id: "../../private", title: "路径注入" },
          { id: "x?url=https://localhost", title: "查询注入" },
          { id: "blocked", title: "不可播放", access: { stream: false } },
          { id: "malformed", title: "错误权限", is_streamable: "true" },
          { id: "good", title: "正常音乐", access: { stream: true } },
          { id: "good", title: "重复音乐" },
        ],
      },
      musicScene(11, true),
    );
    expect(tracks.map((track) => track.id)).toEqual(["audius-good"]);
  });

  it("限制条数与文本长度，并保留官方站内来源链接", () => {
    const tracks = parseAudiusTracks(
      {
        data: Array.from({ length: 100 }, (_, index) => ({
          id: `track-${index}`,
          title: "x".repeat(10_000),
          user: { name: "y".repeat(10_000) },
          permalink: "/artist/song",
        })),
      },
      musicScene(11, true),
    );
    expect(tracks).toHaveLength(40);
    expect(tracks[0].title).toHaveLength(300);
    expect(tracks[0].artist).toHaveLength(160);
    expect(tracks[0].sourceUrl).toBe("https://audius.co/artist/song");
    expect(
      bundledRecommendation("focus", -Number.MAX_SAFE_INTEGER),
    ).toBeDefined();
    expect(bundledRecommendation("focus", Number.NaN)).toBeDefined();
  });
});

describe("音乐响应体边界和旧WebView兼容", () => {
  function mockFetch(response: Response) {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const fetchMock = vi.fn<typeof fetch>(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("普通流式响应可播放，并限制搜索长度且不带凭据", async () => {
    const fetchMock = mockFetch(
      new Response(JSON.stringify({ data: [{ id: "track", title: "曲目" }] })),
    );
    const track = await recommendMusic(0, false, 10, "smart", "a".repeat(5000));
    expect(track.audioUrl).toBe("https://api.audius.co/v1/tracks/track/stream");
    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestUrl.searchParams.get("query")).toHaveLength(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
      }),
    );
  });

  it("没有可信Content-Length的超大流会提前终止并转为本地推荐", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(300_000));
      },
      cancel: cancelled,
    });
    mockFetch(new Response(body));
    const track = await recommendMusic();
    expect(track.source).toBe("OpenGameArt");
    expect(cancelled).toHaveBeenCalled();
  });

  it("超大声明长度不会读取响应正文", async () => {
    const response = new Response("{}", {
      headers: { "Content-Length": "900000" },
    });
    const textReader = vi.spyOn(response, "text");
    mockFetch(response);
    await expect(recommendMusic(0, false, 10, "smart", "歌曲")).rejects.toThrow(
      /数据过大/,
    );
    expect(textReader).not.toHaveBeenCalled();
  });

  it("旧WebView没有ReadableStream时不信任声明长度，安全回退离线曲目", async () => {
    const body = JSON.stringify({
      data: [{ id: "oldwebview", title: "兼容曲目" }],
    });
    const response = new Response(body, {
      headers: { "Content-Length": String(body.length) },
    });
    Object.defineProperty(response, "body", { value: undefined });
    const read = vi.spyOn(response, "text").mockResolvedValue(body);
    mockFetch(response);
    expect((await recommendMusic()).source).toBe("OpenGameArt");
    expect(read).not.toHaveBeenCalled();
  });

  it("坏JSON或无流读取能力的未知长度响应使用离线推荐", async () => {
    mockFetch(new Response("not JSON"));
    expect((await recommendMusic()).source).toBe("OpenGameArt");
    const response = new Response("{}");
    Object.defineProperty(response, "body", { value: undefined });
    const read = vi.spyOn(response, "text");
    mockFetch(response);
    expect((await recommendMusic()).source).toBe("OpenGameArt");
    expect(read).not.toHaveBeenCalled();
  });
});
