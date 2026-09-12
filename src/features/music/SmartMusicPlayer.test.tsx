// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentPage } from "../../App";
import { useAppStore } from "../../store";
import { useMusicPreferenceStore } from "../../musicStore";
import { recommendMusicBatch, type SmartTrack } from "../../services/music";
import { MusicFeedbackPanel, SmartMusicPlayer } from "./SmartMusicPlayer";
import { disposeMusicPlayback, getMusicPlayback } from "./playback";

vi.mock("../../services/music", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/music")>()),
  recommendMusicBatch: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => undefined),
}));

const tracks: SmartTrack[] = Array.from({ length: 7 }, (_, index) => ({
  id: `local-demo-${index}`,
  title: `候选曲目 ${index + 1}`,
  artist: "测试音乐人",
  scene: "轻柔专注",
  reason: "适合安静开始",
  source: "OpenGameArt",
  sourceUrl: "https://opengameart.org/",
  license: "CC0",
  audioUrl: `/music/demo-${index}.ogg`,
  recommendation: {
    score: 50 - index,
    reasons: ["符合自选的休息场景", "你喜欢的轻音乐类别"],
    category: "focus",
    algorithmVersion: "test-v1",
  },
}));
const trace = {
  algorithmVersion: "test-v1",
  source: "offline" as const,
  candidateCount: 7,
  excludedCount: 0,
  repeatRelaxed: false,
  moodFilterRelaxed: false,
};
const initialPreferences = { ...useAppStore.getState().preferences };
let audio: HTMLAudioElement;

beforeEach(() => {
  disposeMusicPlayback();
  vi.clearAllMocks();
  useAppStore.setState({
    tasks: [],
    preferences: {
      ...initialPreferences,
      aiEnabled: false,
      musicAutoplay: false,
      musicPlayMode: "sequence",
      musicCategory: "smart",
    },
  });
  useMusicPreferenceStore.setState({ feedback: [], recentIds: [] });
  vi.mocked(recommendMusicBatch).mockResolvedValue({ tracks, trace });
  audio = document.createElement("audio");
  vi.spyOn(window, "Audio").mockImplementation(function () {
    return audio;
  });
  vi.spyOn(audio, "play").mockImplementation(async () => {
    audio.dispatchEvent(new Event("play"));
  });
  vi.spyOn(audio, "pause").mockImplementation(() => {
    audio.dispatchEvent(new Event("pause"));
  });
});
afterEach(() => {
  cleanup();
  disposeMusicPlayback();
  vi.restoreAllMocks();
});

describe("心情音乐候选与本机反馈", () => {
  it("最多展示五首候选与推荐原因，只有点选播放才记近期记录", async () => {
    render(<SmartMusicPlayer />);
    const candidates = screen.getByRole("region", { name: "本次音乐候选" });
    await within(candidates).findByText("本次候选（5 / 5）");
    expect(
      within(candidates).getAllByRole("button", { name: /播放候选/ }),
    ).toHaveLength(5);
    expect(screen.queryByText("候选曲目 6")).not.toBeInTheDocument();
    expect(useMusicPreferenceStore.getState().recentIds).toEqual([]);
    fireEvent.click(within(candidates).getAllByText("为什么推荐")[0]);
    expect(
      within(candidates).getAllByText("符合自选的休息场景")[0],
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "播放候选 候选曲目 2" }),
    );
    expect(getMusicPlayback().getSnapshot().track?.id).toBe(tracks[1].id);
    expect(useMusicPreferenceStore.getState().recentIds).toEqual([
      tracks[1].id,
    ]);
  });

  it("喜欢可再次撤销，不喜欢立即退出候选；历史撤销恢复，清除需二次确认", async () => {
    render(
      <>
        <SmartMusicPlayer />
        <MusicFeedbackPanel />
      </>,
    );
    await screen.findByRole("button", { name: "喜欢 候选曲目 2" });
    fireEvent.click(screen.getByRole("button", { name: "喜欢 候选曲目 2" }));
    expect(useMusicPreferenceStore.getState().feedback[0].rating).toBe("like");
    fireEvent.click(
      screen.getByRole("button", { name: "撤销喜欢 候选曲目 2" }),
    );
    expect(useMusicPreferenceStore.getState().feedback).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "不喜欢 候选曲目 2" }));
    expect(
      screen.queryByRole("button", { name: "播放候选 候选曲目 2" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("本机音乐反馈（1 / 200）"));
    fireEvent.click(
      screen.getByRole("button", { name: "撤销反馈 候选曲目 2" }),
    );
    expect(
      screen.getByRole("button", { name: "播放候选 候选曲目 2" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "喜欢 候选曲目 3" }));
    fireEvent.click(screen.getByRole("button", { name: "清除本机音乐反馈" }));
    expect(useMusicPreferenceStore.getState().feedback).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "取消清除" }));
    expect(useMusicPreferenceStore.getState().feedback).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "清除本机音乐反馈" }));
    fireEvent.click(screen.getByRole("button", { name: "确认清除反馈" }));
    expect(useMusicPreferenceStore.getState().feedback).toEqual([]);
  });

  it("未开启 AI 也按自选心情与陪伴方式推荐，不自动打断音乐或更换好句", async () => {
    const view = render(<ContentPage />);
    await screen.findByRole("button", { name: "播放音乐" });
    const quote = view.container.querySelector(
      ".content-card.quote h2",
    )!.textContent;
    fireEvent.click(screen.getByRole("button", { name: "播放音乐" }));
    const pauses = vi.mocked(audio.pause).mock.calls.length;
    fireEvent.change(screen.getByRole("combobox", { name: "当前场景" }), {
      target: { value: "rest" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "此刻心情" }), {
      target: { value: "tired" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "音乐陪伴方式" }), {
      target: { value: "lift" },
    });
    expect(recommendMusicBatch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "按心情推荐" }));
    await waitFor(() => expect(recommendMusicBatch).toHaveBeenCalledTimes(2));
    expect(recommendMusicBatch).toHaveBeenLastCalledWith(
      expect.any(Number),
      false,
      expect.any(Number),
      "smart",
      "",
      expect.objectContaining({
        context: {
          scene: "rest",
          mood: "tired",
          hour: expect.any(Number),
          intent: "lift",
        },
      }),
    );
    expect(audio.pause).toHaveBeenCalledTimes(pauses);
    expect(getMusicPlayback().getSnapshot().playing).toBe(true);
    expect(getMusicPlayback().getSnapshot().track?.id).toBe(tracks[0].id);
    expect(
      view.container.querySelector(".content-card.quote h2")!.textContent,
    ).toBe(quote);
  });

  it("搜索与下一轮推荐传入本机反馈，所有候选被排除时展示空态而不绕过", async () => {
    useMusicPreferenceStore.getState().rateTrack(tracks[0], "focus", "dislike");
    render(<ContentPage />);
    await screen.findByRole("button", { name: "播放候选 候选曲目 2" });
    vi.mocked(recommendMusicBatch).mockResolvedValueOnce({
      tracks: [],
      trace: { ...trace, excludedCount: 7 },
    });
    fireEvent.change(
      screen.getByPlaceholderText("搜索 Audius 曲名、音乐人或心情"),
      { target: { value: "歌手 曲名" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await screen.findByText(/没有符合当前条件的候选歌曲/);
    expect(
      screen.getByText(/按目录搜索相关顺序，过滤不喜欢与受限曲目/),
    ).toBeInTheDocument();
    expect(recommendMusicBatch).toHaveBeenLastCalledWith(
      expect.any(Number),
      false,
      expect.any(Number),
      "smart",
      "歌手 曲名",
      expect.objectContaining({
        feedback: [
          expect.objectContaining({ id: tracks[0].id, rating: "dislike" }),
        ],
      }),
    );
    expect(
      screen.queryByRole("button", { name: /播放候选/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("导入本地歌曲")).toBeEnabled();
  });

  it("离开播放器页面后仍可自动下一首，返回页面复用同一音源与设置", async () => {
    const view = render(<SmartMusicPlayer />);
    await screen.findByRole("button", { name: "播放音乐" });
    fireEvent.click(screen.getByRole("button", { name: "开启自动连播" }));
    fireEvent.click(screen.getByRole("button", { name: "播放音乐" }));
    view.unmount();
    await act(async () => {
      audio.dispatchEvent(new Event("ended"));
    });
    expect(getMusicPlayback().getSnapshot().track?.id).toBe(tracks[1].id);
    render(<SmartMusicPlayer compact />);
    expect(screen.getByText(tracks[1].title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂停音乐" })).toBeVisible();
    expect(window.Audio).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "关闭自动连播" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
