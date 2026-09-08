import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  musicEndAction,
  musicScene,
  nextMusicOffset,
  parseAudiusTracks,
  bundledRecommendation,
} from "./music";

let recommendMusic: typeof import("./music").recommendMusic;

beforeEach(async () => {
  vi.resetModules();
  ({ recommendMusic } = await import("./music"));
});

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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it.each([
    { is_stream_gated: true },
    { is_stream_gated: "false" },
    { is_delete: true },
    { is_unlisted: true },
    { is_unlisted: null },
    { is_available: false },
    { is_available: "true" },
    { access_authorities: ["signer-address"] },
    { access_authorities: "malformed" },
    { stream_conditions: { follow_user_id: 123 } },
    { stream_conditions: { usdc_purchase: { price: 100 } } },
    { stream_conditions: [] },
  ])("匿名播放器不选择受限或权限字段无效的曲目：%j", (restriction) => {
    expect(
      parseAudiusTracks(
        {
          data: [
            {
              id: "restricted",
              title: "受限曲目",
              access: { stream: true },
              ...restriction,
            },
          ],
        },
        musicScene(11, true),
      ),
    ).toEqual([]);
  });

  it("公开且仅下载受限的曲目仍可播放，不将下载许可误作播放许可", () => {
    const tracks = parseAudiusTracks(
      {
        data: [
          {
            id: "public",
            title: "公开曲目",
            is_stream_gated: false,
            is_delete: false,
            is_unlisted: false,
            is_available: true,
            is_download_gated: true,
            access: { stream: true, download: false },
            access_authorities: [],
            stream_conditions: null,
          },
        ],
      },
      musicScene(11, true),
    );
    expect(tracks).toHaveLength(1);
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

describe("有界音乐候选池缓存", () => {
  function response(prefix = "track") {
    return new Response(
      JSON.stringify({
        data: Array.from({ length: 40 }, (_, index) => ({
          id: `${prefix}-${index}`,
          title: `曲目 ${index}`,
        })),
      }),
    );
  }

  function mockFetch(implementation: typeof fetch = async () => response()) {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const fetchMock = vi.fn<typeof fetch>(implementation);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("连续切歌只获取一次候选池，返回对象的修改不污染缓存", async () => {
    const fetchMock = mockFetch();
    const first = await recommendMusic(0, false, 10, "focus");
    const next = await recommendMusic(1, false, 10, "focus");
    const id = first.id;
    first.id = "changed-by-consumer";
    first.reason = "changed-by-consumer";
    const again = await recommendMusic(0, false, 10, "focus");
    expect(next.id).not.toBe(id);
    expect(again.id).toBe(id);
    expect(again.reason).not.toBe(first.reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("缓存固定十分钟到期，临近到期的命中不会延长寿命", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-09-08T10:00:00Z");
    vi.setSystemTime(start);
    const fetchMock = mockFetch();
    await recommendMusic(0, false, 10, "focus");
    vi.setSystemTime(start.getTime() + 599_999);
    await recommendMusic(1, false, 10, "focus");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start.getTime() + 600_000);
    await recommendMusic(2, false, 10, "focus");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("同一查询的并发请求合并，但每次调用仍选择自己的歌曲和场景", async () => {
    const resolvers: ((value: Response) => void)[] = [];
    const fetchMock = mockFetch(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const requests = [
      recommendMusic(0, false, 10, "focus", " quiet "),
      recommendMusic(1, false, 10, "chinese", "quiet"),
      recommendMusic(2, false, 10, "ambient", "quiet"),
    ];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolvers[0](response());
    const tracks = await Promise.all(requests);
    expect(new Set(tracks.map((track) => track.id)).size).toBe(3);
    expect(tracks.map((track) => track.scene)).toEqual([
      "轻柔专注",
      "国风民乐",
      "自然环境",
    ]);
  });

  it("不同搜索和分类查询不会混用候选，相同查询的场景文案也不会串用", async () => {
    const fetchMock = mockFetch(async (input) => {
      const query = new URL(String(input)).searchParams.get("query") ?? "";
      return response(
        query === "first"
          ? "first"
          : query === "second"
            ? "second"
            : "category",
      );
    });
    expect((await recommendMusic(0, false, 11, "smart", "first")).id).toContain(
      "first",
    );
    expect(
      (await recommendMusic(0, false, 11, "smart", "second")).id,
    ).toContain("second");
    const chinese = await recommendMusic(0, false, 11, "chinese");
    const focus = await recommendMusic(0, false, 11, "focus");
    const smart = await recommendMusic(0, false, 11, "smart");
    expect(chinese.scene).toBe("国风民乐");
    expect(focus.scene).toBe("轻柔专注");
    expect(smart.scene).toBe("稳定节奏");
    expect(smart.reason).not.toBe(focus.reason);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(new Set(fetchMock.mock.calls.map(([url]) => String(url))).size).toBe(
      4,
    );
  });

  it("并发的不同搜索各自请求，后完成的响应不覆盖另一查询", async () => {
    const resolvers: ((value: Response) => void)[] = [];
    const fetchMock = mockFetch(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const first = recommendMusic(0, false, 10, "smart", "first");
    const second = recommendMusic(0, false, 10, "smart", "second");
    resolvers[1](response("second"));
    expect((await second).id).toContain("second");
    resolvers[0](response("first"));
    expect((await first).id).toContain("first");
    expect(
      (await recommendMusic(0, false, 10, "smart", "second")).id,
    ).toContain("second");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { data: [] },
    { data: [{ id: "restricted", title: "不可播放", is_stream_gated: true }] },
    { unexpected: [] },
  ])(
    "空或没有有效曲目的响应不进入缓存，并提供可操作的搜索提示：%j",
    async (payload) => {
      const fetchMock = mockFetch();
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload)));
      await expect(
        recommendMusic(0, false, 10, "smart", "song"),
      ).rejects.toThrow(/试试曲名、歌手.*本地导入/);
      expect((await recommendMusic(0, false, 10, "smart", "song")).source).toBe(
        "Audius",
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("并发失败不缓存，不泄露原始错误，之后可以重新搜索", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockRejectedValueOnce(
      new Error("raw upstream private diagnostics"),
    );
    const failures = await Promise.allSettled([
      recommendMusic(0, false, 10, "smart", "song"),
      recommendMusic(1, false, 10, "smart", "song"),
    ]);
    for (const failure of failures) {
      expect(failure.status).toBe("rejected");
      if (failure.status === "rejected") {
        expect(failure.reason).toBeInstanceOf(Error);
        expect(String(failure.reason)).toMatch(/稍后重试或导入本地音乐/);
        expect(String(failure.reason)).not.toContain("private diagnostics");
      }
    }
    expect((await recommendMusic(0, false, 10, "smart", "song")).source).toBe(
      "Audius",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("服务错误取消响应流且不缓存，不读取上游错误正文", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const failedResponse = new Response(body, { status: 503 });
    const textReader = vi.spyOn(failedResponse, "text");
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(failedResponse);
    await expect(recommendMusic(0, false, 10, "smart", "song")).rejects.toThrow(
      /稍后重试/,
    );
    expect(cancelled).toHaveBeenCalled();
    expect(textReader).not.toHaveBeenCalled();
    expect((await recommendMusic(0, false, 10, "smart", "song")).source).toBe(
      "Audius",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("最多保留十六个查询池，淘汰最久未用的池而保留最近命中的池", async () => {
    const fetchMock = mockFetch();
    for (let index = 0; index < 16; index++)
      await recommendMusic(0, false, 10, "smart", `query-${index}`);
    await recommendMusic(0, false, 10, "smart", "query-0");
    await recommendMusic(0, false, 10, "smart", "query-16");
    await recommendMusic(0, false, 10, "smart", "query-0");
    expect(fetchMock).toHaveBeenCalledTimes(17);
    await recommendMusic(0, false, 10, "smart", "query-1");
    expect(fetchMock).toHaveBeenCalledTimes(18);
  });

  it("待处理的不同查询也有限额，同查询在限额内仍可合并", async () => {
    const resolvers: ((value: Response) => void)[] = [];
    const fetchMock = mockFetch(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const requests = Array.from({ length: 16 }, (_, index) =>
      recommendMusic(0, false, 10, "smart", `query-${index}`),
    );
    requests.push(recommendMusic(1, false, 10, "smart", "query-0"));
    await expect(
      recommendMusic(0, false, 10, "smart", "query-extra"),
    ).rejects.toThrow(/正在处理中/);
    expect(fetchMock).toHaveBeenCalledTimes(16);
    resolvers.forEach((resolve) => resolve(response()));
    expect(await Promise.all(requests)).toHaveLength(17);
    fetchMock.mockResolvedValueOnce(response());
    await recommendMusic(0, false, 10, "smart", "query-extra");
  });

  it("在线失败明确说明离线回退，且不会将回退结果当在线缓存", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockRejectedValueOnce(new Error("private diagnostics"));
    const fallback = await recommendMusic(0, false, 10, "focus");
    expect(fallback.source).toBe("OpenGameArt");
    expect(fallback.reason).toContain("已回退到离线曲目");
    expect(fallback.reason).not.toContain("private diagnostics");
    expect((await recommendMusic(0, false, 10, "focus")).source).toBe("Audius");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("保留十二秒超时，超时请求释放并发槽位且不会缓存", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("raw timeout")),
            { once: true },
          );
        }),
    );
    const result = recommendMusic(0, false, 10, "smart", "song").catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(11_999);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(String(await result)).toContain("稍后重试");
    fetchMock.mockResolvedValueOnce(response());
    expect((await recommendMusic(0, false, 10, "smart", "song")).source).toBe(
      "Audius",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
