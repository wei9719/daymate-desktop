// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MusicPlaybackController } from "./playback";
import { recommendMusicBatch, type SmartTrack } from "../../services/music";
import type { MusicFeedback } from "../../services/musicRanking";
import type { MusicPlayMode } from "../../types";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
}));
function track(id: string): SmartTrack {
  return {
    id: `local-${id}`,
    title: id,
    artist: "测试音乐人",
    scene: "安静",
    reason: "测试推荐",
    audioUrl: `/music/${id}.ogg`,
    sourceUrl: "https://opengameart.org/",
    license: "CC0",
    source: "OpenGameArt",
  };
}
const trace = {
  algorithmVersion: "test-v1",
  source: "offline" as const,
  candidateCount: 3,
  excludedCount: 0,
  repeatRelaxed: false,
  moodFilterRelaxed: false,
};
function harness(tracks = [track("one"), track("two"), track("three")]) {
  const audio = document.createElement("audio");
  let paused = true;
  Object.defineProperty(audio, "paused", { get: () => paused });
  const play = vi.spyOn(audio, "play").mockImplementation(async () => {
    paused = false;
    audio.dispatchEvent(new Event("play"));
  });
  const pause = vi.spyOn(audio, "pause").mockImplementation(() => {
    paused = true;
    audio.dispatchEvent(new Event("pause"));
  });
  const createAudio = vi.fn(() => audio);
  const recommend = vi
    .fn<typeof recommendMusicBatch>()
    .mockResolvedValue({ tracks, trace });
  const preferences = {
    category: "smart" as const,
    autoplay: true,
    mode: "sequence" as MusicPlayMode,
    hasTasks: false,
  };
  const feedback: MusicFeedback[] = [];
  const recent: string[] = [];
  const remember = vi.fn((id: string) => {
    recent.push(id);
  });
  const publish = vi.fn();
  const controller = new MusicPlaybackController({
    createAudio,
    recommend,
    preferences: () => preferences,
    feedback: () => feedback,
    recentIds: () => recent,
    rememberTrack: remember,
    publish,
  });
  return {
    controller,
    audio,
    play,
    pause,
    createAudio,
    recommend,
    feedback,
    preferences,
    remember,
    publish,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("跨页面唯一音乐控制器", () => {
  it("卸载最后一个UI订阅不暂停，ended仍续播，重订阅没有第二音源", async () => {
    const h = harness();
    const unsubscribe = h.controller.subscribe(vi.fn());
    h.controller.ensureLoaded();
    await vi.waitFor(() =>
      expect(h.controller.getSnapshot().track?.id).toBe("local-one"),
    );
    await h.controller.play();
    const pauses = h.pause.mock.calls.length;
    unsubscribe();
    expect(h.pause).toHaveBeenCalledTimes(pauses);
    h.audio.dispatchEvent(new Event("ended"));
    await vi.waitFor(() =>
      expect(h.controller.getSnapshot().track?.id).toBe("local-two"),
    );
    expect(h.controller.getSnapshot().playing).toBe(true);
    h.controller.subscribe(vi.fn());
    h.controller.ensureLoaded();
    expect(h.createAudio).toHaveBeenCalledTimes(1);
    expect(h.remember).toHaveBeenCalledWith("local-one");
    expect(h.remember).toHaveBeenCalledWith("local-two");
    h.controller.dispose();
  });
  it("仅真正play事件写近期记录，预览与暂停时换歌不算已听", async () => {
    const h = harness();
    await h.controller.recommend({ category: "smart" });
    expect(h.remember).not.toHaveBeenCalled();
    await h.controller.next(false);
    expect(h.controller.getSnapshot().track?.id).toBe("local-two");
    expect(h.remember).not.toHaveBeenCalled();
    await h.controller.play();
    expect(h.remember).toHaveBeenCalledExactlyOnceWith("local-two");
    h.controller.dispose();
  });
  it("单曲循环继续同一首，关闭自动连播会停止且不请求曲库", async () => {
    const h = harness();
    await h.controller.recommend({ category: "smart" });
    await h.controller.play();
    h.preferences.mode = "single";
    h.audio.currentTime = 10;
    h.audio.dispatchEvent(new Event("ended"));
    await vi.waitFor(() => expect(h.play).toHaveBeenCalledTimes(2));
    expect(h.controller.getSnapshot().track?.id).toBe("local-one");
    expect(h.audio.currentTime).toBe(0);
    h.preferences.mode = "sequence";
    h.preferences.autoplay = false;
    h.audio.dispatchEvent(new Event("ended"));
    expect(h.controller.getSnapshot().playing).toBe(false);
    expect(h.recommend).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });
  it("心情推荐只刷新五首候选，不打断已有歌曲", async () => {
    const h = harness();
    await h.controller.recommend({ category: "smart" });
    await h.controller.play();
    const pauses = h.pause.mock.calls.length;
    await h.controller.recommend({
      category: "ambient",
      context: { scene: "rest", mood: "tired", hour: 22, intent: "match" },
    });
    expect(h.pause).toHaveBeenCalledTimes(pauses);
    expect(h.controller.getSnapshot().playing).toBe(true);
    expect(h.controller.getSnapshot().track?.id).toBe("local-one");
    expect(h.recommend).toHaveBeenLastCalledWith(
      expect.any(Number),
      false,
      22,
      "ambient",
      "",
      expect.objectContaining({
        context: { scene: "rest", mood: "tired", hour: 22, intent: "match" },
        recentIds: expect.arrayContaining(["local-one"]),
      }),
    );
    h.controller.dispose();
  });
  it("延迟批次不能覆盖后来选定的歌曲或制造双音源", async () => {
    const h = harness();
    await h.controller.recommend({ category: "smart" });
    let finish!: (
      batch: Awaited<ReturnType<typeof recommendMusicBatch>>,
    ) => void;
    h.recommend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.controller.recommend({ category: "ambient" });
    await h.controller.selectTrack(track("manual"));
    finish({ tracks: [track("late")], trace });
    await pending;
    expect(h.controller.getSnapshot().track?.id).toBe("local-manual");
    expect(h.createAudio).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().loading).toBe(false);
    h.controller.dispose();
  });
  it("异步等待期间新增不喜欢会再次过滤，空批次不会回塞被排除歌曲", async () => {
    const h = harness([track("one")]);
    h.feedback.push({
      id: "local-one",
      title: "one",
      artist: "测试",
      category: "smart",
      rating: "dislike",
      updatedAt: new Date().toISOString(),
    });
    await h.controller.recommend({ category: "smart" });
    expect(h.controller.getSnapshot().empty).toBe(true);
    expect(h.controller.getSnapshot().candidates).toEqual([]);
    expect(h.controller.getSnapshot().track).toBeUndefined();
    expect(h.play).not.toHaveBeenCalled();
    h.controller.dispose();
  });
  it("当前歌曲不喜欢后不再循环；下一次检索临时排除未播放的当前ID", async () => {
    const h = harness([track("one")]);
    await h.controller.recommend({ category: "smart" });
    h.recommend.mockResolvedValueOnce({ tracks: [track("two")], trace });
    await h.controller.next(false);
    expect(h.recommend).toHaveBeenLastCalledWith(
      expect.any(Number),
      false,
      expect.any(Number),
      "smart",
      "",
      expect.objectContaining({ recentIds: ["local-one"] }),
    );
    h.feedback.push({
      id: "local-two",
      title: "two",
      artist: "测试",
      category: "smart",
      rating: "dislike",
      updatedAt: new Date().toISOString(),
    });
    await h.controller.play();
    expect(h.play).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().error).toContain("不喜欢");
    h.controller.dispose();
  });
  it("播放失败和解码失败保留可重试控制，不连环请求", async () => {
    const h = harness();
    await h.controller.recommend({ category: "smart" });
    h.play.mockRejectedValueOnce(new Error("blocked"));
    await h.controller.play();
    expect(h.controller.getSnapshot().error).toContain("播放未能开始");
    h.audio.dispatchEvent(new Event("error"));
    expect(h.controller.getSnapshot().error).toContain("无法解码");
    expect(h.recommend).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });
  it("本地Blob由控制器持有，取消订阅不释放，换曲和显式清空才回收", async () => {
    const create = vi
      .fn()
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = create;
        static revokeObjectURL = revoke;
      },
    );
    const h = harness();
    const unsubscribe = h.controller.subscribe(vi.fn());
    h.controller.loadLocal("第一首.wav", new Blob([], { type: "audio/wav" }));
    await h.controller.play();
    unsubscribe();
    expect(revoke).not.toHaveBeenCalled();
    h.controller.loadLocal("第二首.wav", new Blob([], { type: "audio/wav" }));
    expect(revoke).toHaveBeenCalledWith("blob:first");
    h.controller.clearCurrent();
    expect(revoke).toHaveBeenCalledWith("blob:second");
    expect(h.createAudio).toHaveBeenCalledTimes(1);
    expect(() =>
      h.controller.loadLocal("x.html", new Blob([], { type: "text/html" })),
    ).toThrow();
    h.controller.dispose();
  });
  it.each([false, true])(
    "检索期间结束歌曲会等待新候选，空批次=%s时不连环请求",
    async (empty) => {
      const h = harness();
      await h.controller.recommend({ category: "smart" });
      await h.controller.play();
      let finish!: (
        batch: Awaited<ReturnType<typeof recommendMusicBatch>>,
      ) => void;
      h.recommend.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = h.controller.recommend({ category: "ambient" });
      h.audio.dispatchEvent(new Event("ended"));
      expect(h.controller.getSnapshot().playing).toBe(false);
      finish({ tracks: empty ? [] : [track("new")], trace });
      await pending;
      expect(h.controller.getSnapshot().playing).toBe(!empty);
      expect(h.controller.getSnapshot().track?.id).toBe(
        empty ? "local-one" : "local-new",
      );
      expect(h.recommend).toHaveBeenCalledTimes(2);
      h.controller.dispose();
    },
  );
  it.each([
    "pause",
    "pause-then-play",
    "manual-with-autoplay-off",
    "automatic-disabled",
  ])("慢速补候选遵守最新播放意图：%s，仍保留返回候选", async (action) => {
    const h = harness([track("one")]);
    await h.controller.recommend({ category: "smart" });
    await h.controller.play();
    let finish!: (
      batch: Awaited<ReturnType<typeof recommendMusicBatch>>,
    ) => void;
    h.recommend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    if (action === "manual-with-autoplay-off") h.preferences.autoplay = false;
    let pending: Promise<void> | undefined;
    if (action === "automatic-disabled") {
      h.audio.dispatchEvent(new Event("ended"));
      h.preferences.autoplay = false;
    } else {
      pending = h.controller.next();
      if (action !== "manual-with-autoplay-off") h.controller.toggle();
      if (action === "pause-then-play") await h.controller.play();
    }
    expect(h.controller.getSnapshot().loading).toBe(true);
    finish({ tracks: [track("late")], trace });
    await pending;
    await vi.waitFor(() =>
      expect(h.controller.getSnapshot().loading).toBe(false),
    );
    expect(
      h.controller.getSnapshot().candidates.map((item) => item.id),
    ).toEqual(["local-late"]);
    const manual = action === "manual-with-autoplay-off";
    expect(h.controller.getSnapshot().track?.id).toBe(
      manual ? "local-late" : "local-one",
    );
    expect(h.controller.getSnapshot().playing).toBe(
      manual || action === "pause-then-play",
    );
    expect(h.play).toHaveBeenCalledTimes(
      manual || action === "pause-then-play" ? 2 : 1,
    );
    h.controller.dispose();
  });
});
