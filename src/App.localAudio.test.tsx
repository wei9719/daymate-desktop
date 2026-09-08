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

vi.mock("./services/music", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./services/music")>()),
  recommendMusic: vi.fn(async () => ({
    id: "test-song",
    title: "测试曲目",
    artist: "测试",
    scene: "专注",
    reason: "测试",
    audioUrl: "/music/calm-theme.ogg",
    sourceUrl: "https://audius.co/",
    source: "OpenGameArt",
    license: "CC0",
  })),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => undefined),
}));

const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();
beforeEach(() => {
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
});
afterEach(() => {
  cleanup();
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

  it("StrictMode 下只创建一个安全 Blob，文件名仅作为文字，卸载会回收 URL", async () => {
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
    expect(view.container.querySelector(".local-player audio")).toHaveAttribute(
      "src",
      "blob:test-safe-audio",
    );
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
      "blob:test-safe-audio",
    );
  });

  it("错误导入保留原曲目；换曲回收旧地址，解码失败给出明确提示", async () => {
    createObjectURL
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const view = render(<ContentPage />);
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
    fireEvent.error(view.container.querySelector(".local-player audio")!);
    expect(screen.getByRole("alert")).toHaveTextContent("无法解码播放");
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
});
