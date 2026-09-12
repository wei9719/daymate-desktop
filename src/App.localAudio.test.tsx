// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentPage } from "./App";
import * as localAudio from "./services/localAudio";
import { useAppStore } from "./store";
import { useMusicPreferenceStore } from "./musicStore";
import {
  disposeMusicPlayback,
  getMusicPlayback,
} from "./features/music/playback";

vi.mock("./services/music", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./services/music")>()),
  recommendMusicBatch: vi.fn(async () => ({
    tracks: [
      {
        id: "local-test-song",
        title: "测试曲目",
        artist: "测试",
        scene: "专注",
        reason: "测试",
        audioUrl: "/music/calm-theme.ogg",
        sourceUrl: "https://audius.co/",
        source: "OpenGameArt",
        license: "CC0",
      },
    ],
    trace: {
      algorithmVersion: "test-v1",
      source: "offline",
      candidateCount: 1,
      excludedCount: 0,
      repeatRelaxed: false,
      moodFilterRelaxed: false,
    },
  })),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => undefined),
}));

const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();
let audio: HTMLAudioElement;
beforeEach(() => {
  disposeMusicPlayback();
  useMusicPreferenceStore.setState({ feedback: [], recentIds: [] });
  createObjectURL.mockReset().mockReturnValue("blob:test-safe-audio");
  revokeObjectURL.mockReset();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    },
  );
  useAppStore.getState().updatePreferences({ aiEnabled: false });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
  audio = document.createElement("audio");
  vi.spyOn(window, "Audio").mockImplementation(function () {
    return audio;
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
    async function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event("play"));
    },
  );
});
afterEach(() => {
  cleanup();
  disposeMusicPlayback();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function song(name = "歌曲.wav") {
  const bytes = new Uint8Array(44);
  bytes.set([82, 73, 70, 70]);
  bytes.set([87, 65, 86, 69], 8);
  return new File([bytes], name, { type: "audio/wav" });
}
function upload(file: File) {
  fireEvent.change(screen.getByLabelText("导入本地歌曲"), {
    target: { files: [file] },
  });
}

describe("本地歌曲导入交互", () => {
  it("拒绝文件时错误可见，且不会创建播放地址", async () => {
    render(<ContentPage />);
    upload(
      new File(['<svg onload="alert(1)"></svg>'], "song.mp3", {
        type: "image/svg+xml",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "文件类型与音频格式不符",
    );
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByLabelText("导入本地歌曲")).not.toBeDisabled();
  });

  it("StrictMode 下只创建一个安全 Blob，文件名仅作为文字，离开页面仍播放，显式清空才回收", async () => {
    const view = render(
      <StrictMode>
        <ContentPage />
      </StrictMode>,
    );
    const file = song('<img src=x onerror="alert(1)">.wav');
    upload(file);
    await screen.findByText(file.name);
    expect(view.container.querySelector(".local-player img")).toBeNull();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob: Blob = createObjectURL.mock.calls[0][0];
    expect(blob).not.toBe(file);
    expect(blob.type).toBe("audio/wav");
    expect(audio).toHaveAttribute("src", "blob:test-safe-audio");
    fireEvent.click(screen.getByRole("button", { name: "播放音乐" }));
    expect(getMusicPlayback().getSnapshot().playing).toBe(true);
    view.unmount();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(getMusicPlayback().getSnapshot().playing).toBe(true);
    render(<ContentPage />);
    fireEvent.click(screen.getByRole("button", { name: "清空本地歌曲" }));
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
      "blob:test-safe-audio",
    );
  });

  it("错误导入保留原曲目；换曲回收旧地址，解码失败给出明确提示", async () => {
    createObjectURL
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    render(<ContentPage />);
    upload(song("第一首.wav"));
    await screen.findByText("第一首.wav");
    upload(new File(["not audio"], "song.wav", { type: "audio/wav" }));
    await screen.findByRole("alert");
    expect(screen.getByText("第一首.wav")).toBeInTheDocument();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    upload(song("第二首.wav"));
    await screen.findByText("第二首.wav");
    await waitFor(() =>
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:first"),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.error(audio);
    expect(screen.getByRole("alert")).toHaveTextContent("无法解码或加载");
  });

  it("离开页面后完成的验证不会生成遗留播放地址", async () => {
    let finish!: (blob: Blob) => void;
    vi.spyOn(localAudio, "createSafeLocalAudioBlob").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<ContentPage />);
    upload(song());
    view.unmount();
    await act(async () => {
      finish(new Blob([], { type: "audio/wav" }));
    });
    expect(createObjectURL).not.toHaveBeenCalled();
  });
  it.each(["clear", "select", "next"])(
    "导入验证期间%s立即取消旧导入，后到文件不能覆盖明确选择",
    async (action) => {
      render(<ContentPage />);
      await screen.findByRole("button", { name: "播放候选 测试曲目" });
      upload(song("原歌曲.wav"));
      await screen.findByText("原歌曲.wav");
      let finish!: (blob: Blob) => void;
      vi.spyOn(localAudio, "createSafeLocalAudioBlob").mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      upload(song("延迟歌曲.wav"));
      expect(screen.getByLabelText("导入本地歌曲")).toBeDisabled();
      if (action === "clear")
        fireEvent.click(screen.getByRole("button", { name: "清空本地歌曲" }));
      else if (action === "select")
        fireEvent.click(
          screen.getByRole("button", { name: "播放候选 测试曲目" }),
        );
      else fireEvent.click(screen.getByRole("button", { name: "换一首" }));
      expect(screen.getByLabelText("导入本地歌曲")).toBeEnabled();
      await act(async () => {
        finish(new Blob([], { type: "audio/wav" }));
      });
      expect(screen.queryByText("延迟歌曲.wav")).not.toBeInTheDocument();
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(getMusicPlayback().getSnapshot().local).toBeUndefined();
      expect(getMusicPlayback().getSnapshot().track?.id).toBe(
        action === "clear" ? undefined : "local-test-song",
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
});
