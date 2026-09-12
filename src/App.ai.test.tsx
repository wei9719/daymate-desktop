// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { ContentPage, FocusModal, SettingsPage } from "./App";
import * as native from "./native";
import * as system from "./services/system";
import { useAppStore } from "./store";
import { useMusicPreferenceStore } from "./musicStore";
import { useFocusStore } from "./focusStore";
import { disposeMusicPlayback } from "./features/music/playback";
import { hideMainToCompanion } from "./windows";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

vi.mock("./native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native")>()),
  getTodayStats: vi.fn(async () => ({ activeSeconds: 780 })),
  setNativeTracking: vi.fn(async () => undefined),
  getAiKeyStatus: vi.fn(async () => ({
    saved: true,
    usable: true,
    message: "",
  })),
  saveAiKey: vi.fn(async () => undefined),
  deleteAiKey: vi.fn(async () => undefined),
  getAiUsage: vi.fn(async () => ({ date: "2026-09-08", calls: 0 })),
  testAiConnection: vi.fn(async () => "连接成功"),
  listAiModels: vi.fn(async () => ({ models: ["test-chat"], source: "live" })),
  generateEncouragement: vi.fn(async () => ({
    text: "按自己的节奏开始就好。",
    source: "ai",
  })),
  recommendMusicWithAi: vi.fn(async () => ({
    category: "focus",
    reason: "适合安静开始",
    source: "ai",
  })),
}));
vi.mock("./services/system", () => ({
  getSystemIntegrationStatus: vi.fn(async () => ({
    autostartEnabled: false,
    notificationPermission: "unknown",
    notificationStatusNote: "Windows 决定通知是否显示",
    autostartLaunch: false,
  })),
  setSystemAutostart: vi.fn(async (enabled: boolean) => enabled),
  sendTestNotification: vi.fn(async () => undefined),
  sendFocusCompletedNotification: vi.fn(async () => undefined),
}));
vi.mock("./services/music", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./services/music")>()),
  recommendMusicBatch: vi.fn(async () => ({
    tracks: [
      {
        id: "local-test-track",
        title: "测试曲目",
        artist: "测试音乐人",
        scene: "安静",
        reason: "本地测试",
        audioUrl: "/music/calm-theme.ogg",
        sourceUrl: "https://opengameart.org/",
        license: "CC0",
        source: "OpenGameArt",
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
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    label: "main",
    onCloseRequested: async () => () => undefined,
    hide: async () => undefined,
  })),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  isTauri: vi.fn(() => true),
}));
vi.mock("./windows", () => ({
  hideMainToCompanion: vi.fn(async () => undefined),
  hideCompanion: vi.fn(async () => undefined),
  showMainWindow: vi.fn(async () => undefined),
  startCompanionDragging: vi.fn(async () => undefined),
}));

const initialPreferences = { ...useAppStore.getState().preferences };

beforeEach(() => {
  disposeMusicPlayback();
  useFocusStore.getState().dismiss();
  useMusicPreferenceStore.setState({ feedback: [], recentIds: [] });
  vi.clearAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(native.getAiKeyStatus).mockResolvedValue({
    saved: true,
    usable: true,
    message: "",
  });
  vi.mocked(native.saveAiKey).mockResolvedValue(undefined);
  vi.mocked(native.listAiModels).mockResolvedValue({
    models: ["test-chat"],
    source: "live",
  });
  vi.mocked(native.generateEncouragement).mockResolvedValue({
    text: "按自己的节奏开始就好。",
    source: "ai",
  });
  vi.mocked(native.recommendMusicWithAi).mockResolvedValue({
    category: "focus",
    reason: "适合安静开始",
    source: "ai",
  });
  vi.mocked(system.setSystemAutostart).mockImplementation(
    async (enabled) => enabled,
  );
  vi.mocked(system.getSystemIntegrationStatus).mockResolvedValue({
    autostartEnabled: false,
    notificationPermission: "unknown",
    notificationStatusNote: "Windows 决定通知是否显示",
    autostartLaunch: false,
  });
  useAppStore.setState({
    onboarded: false,
    tasks: [],
    preferences: { ...initialPreferences, aiEnabled: true },
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  disposeMusicPlayback();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("AI 推荐确认", () => {
  it("确认前不请求AI，默认不读取摘要；取消后不请求", async () => {
    render(<ContentPage />);
    fireEvent.click(screen.getByRole("button", { name: /AI 按今日节奏推荐/ }));
    await screen.findByText("确认本次发送内容");
    expect(native.getTodayStats).not.toHaveBeenCalled();
    expect(native.recommendMusicWithAi).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("确认本次发送内容")).not.toBeInTheDocument();
    expect(native.recommendMusicWithAi).not.toHaveBeenCalled();
  }, 15_000);

  it("确认后仅发送预览字段，失败可执行本地推荐", async () => {
    vi.mocked(native.recommendMusicWithAi).mockRejectedValue(
      new Error("网络不可用"),
    );
    render(<ContentPage />);
    fireEvent.click(screen.getByRole("button", { name: /AI 按今日节奏推荐/ }));
    fireEvent.click(await screen.findByRole("button", { name: "确认推荐" }));
    await screen.findByText(/本地推荐 · AI 暂时不可用/);
    expect(native.recommendMusicWithAi).toHaveBeenCalledTimes(1);
    expect(native.recommendMusicWithAi).toHaveBeenCalledWith(
      expect.objectContaining({
        activeMinutes: null,
        unfinishedTasks: null,
        maxDailyCalls: 20,
      }),
    );
    expect(useAppStore.getState().preferences.musicCategory).toBe("smart");
  });

  it("主动分享时预览与发送的汇总相同，连续点击不重复请求", async () => {
    useAppStore.getState().updatePreferences({ aiShareActivitySummary: true });
    useAppStore.getState().addTask("不应发送的任务内容", 5, "high");
    let finish: ((value: native.AiMusicResponse) => void) | undefined;
    vi.mocked(native.recommendMusicWithAi).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<ContentPage />);
    fireEvent.click(screen.getByRole("button", { name: /AI 按今日节奏推荐/ }));
    await screen.findByText("今日活跃时长：13 分钟");
    expect(screen.getByText("未完成任务数量：1 项")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "确认推荐" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(native.recommendMusicWithAi).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(native.recommendMusicWithAi).mock.calls[0][0];
    expect(payload.activeMinutes).toBe(13);
    expect(payload.unfinishedTasks).toBe(1);
    expect(JSON.stringify(payload)).not.toContain("不应发送的任务内容");
    await act(async () => {
      finish?.({ category: "focus", reason: "安静开始", source: "cache" });
    });
    expect(screen.getByText("近期缓存 · 安静开始")).toBeInTheDocument();
  });
});

describe("AI 设置与系统设置", () => {
  it("预算与分享开关可保存，测试使用所设上限", async () => {
    render(<SettingsPage />);
    await screen.findByText("密钥已配置");
    fireEvent.change(
      screen.getByRole("spinbutton", { name: /每日 AI 请求上限/ }),
      { target: { value: "7" } },
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: /向 AI 分享使用摘要/ }),
    );
    expect(useAppStore.getState().preferences.aiMaxDailyCalls).toBe(7);
    expect(useAppStore.getState().preferences.aiShareActivitySummary).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await screen.findByText("连接成功");
    expect(native.testAiConnection).toHaveBeenCalledWith(
      initialPreferences.aiProvider,
      initialPreferences.aiBaseUrl,
      initialPreferences.aiModel,
      true,
      7,
    );
  });

  it("切换服务商后不接受上一个服务的迟到密钥结果", async () => {
    let resolveFirst: ((status: native.AiKeyStatus) => void) | undefined;
    vi.mocked(native.getAiKeyStatus).mockImplementation((provider) =>
      provider === initialPreferences.aiProvider
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve({ saved: false, usable: false, message: "" }),
    );
    render(<SettingsPage />);
    fireEvent.change(screen.getByRole("combobox", { name: "服务商" }), {
      target: { value: "siliconflow" },
    });
    await screen.findByText("尚未配置密钥");
    await act(async () => {
      resolveFirst?.({ saved: true, usable: true, message: "" });
    });
    expect(screen.getByText("尚未配置密钥")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测试连接" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "删除密钥" }),
    ).not.toBeInTheDocument();
  });

  it("密钥保存中切换服务商不会串入旧服务的成功状态", async () => {
    let finishSave: (() => void) | undefined;
    vi.mocked(native.saveAiKey).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    vi.mocked(native.getAiKeyStatus).mockImplementation(async (provider) => ({
      saved: provider === initialPreferences.aiProvider,
      usable: provider === initialPreferences.aiProvider,
      message: "",
    }));
    render(<SettingsPage />);
    await screen.findByText("密钥已配置");
    fireEvent.change(
      screen.getByPlaceholderText("已安全保存；输入新值可覆盖"),
      { target: { value: "test-only-key" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "保存密钥" }));
    fireEvent.change(screen.getByRole("combobox", { name: "服务商" }), {
      target: { value: "siliconflow" },
    });
    await screen.findByText("尚未配置密钥");
    await act(async () => {
      finishSave?.();
    });
    expect(screen.getByText("尚未配置密钥")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "API Key 已安全保存到 Windows 凭据管理器，并绑定当前接口地址。",
      ),
    ).not.toBeInTheDocument();
  });

  it("删除已保存Key后恢复未配置状态", async () => {
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "删除密钥" }));
    await screen.findByText("已删除该服务商的本地密钥。");
    expect(native.deleteAiKey).toHaveBeenCalledWith(
      initialPreferences.aiProvider,
    );
    expect(screen.getByRole("button", { name: "测试连接" })).toBeDisabled();
  });

  it("改变接口后禁用旧密钥，保留删除入口并在重新保存时绑定当前地址", async () => {
    const changedUrl = "https://gateway.example.test/v1";
    vi.mocked(native.getAiKeyStatus).mockImplementation(
      async (_provider, baseUrl) => ({
        saved: true,
        usable: baseUrl === initialPreferences.aiBaseUrl,
        message:
          baseUrl === initialPreferences.aiBaseUrl
            ? ""
            : "接口地址与保存密钥时不一致，已阻止发送",
      }),
    );
    render(<SettingsPage />);
    await screen.findByText("密钥已配置");
    fireEvent.change(screen.getByRole("textbox", { name: "Base URL" }), {
      target: { value: changedUrl },
    });
    expect(screen.getByRole("button", { name: "测试连接" })).toBeDisabled();
    await screen.findByText("密钥已保存，但当前接口未获授权");
    expect(screen.getByRole("button", { name: "删除密钥" })).toBeEnabled();
    expect(screen.getByText(/保存密钥即确认仅用于当前接口/)).toHaveTextContent(
      changedUrl,
    );
    fireEvent.change(
      screen.getByPlaceholderText("已安全保存；输入新值可覆盖"),
      {
        target: { value: "test-only-key" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "保存密钥" }));
    await waitFor(() =>
      expect(native.saveAiKey).toHaveBeenCalledWith(
        initialPreferences.aiProvider,
        changedUrl,
        "test-only-key",
      ),
    );
    await screen.findByText(
      "API Key 已安全保存到 Windows 凭据管理器，并绑定当前接口地址。",
    );
    expect(screen.getByRole("button", { name: "测试连接" })).toBeEnabled();
  });

  it("同一服务商切换接口时不会接受旧地址的迟到密钥状态", async () => {
    let oldResult: ((status: native.AiKeyStatus) => void) | undefined;
    vi.mocked(native.getAiKeyStatus).mockImplementation(
      async (_provider, baseUrl) =>
        baseUrl === initialPreferences.aiBaseUrl
          ? new Promise((resolve) => {
              oldResult = resolve;
            })
          : { saved: true, usable: false, message: "请重新保存密钥" },
    );
    render(<SettingsPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "Base URL" }), {
      target: { value: "https://other.example.test/v1" },
    });
    await screen.findByText("密钥已保存，但当前接口未获授权");
    await act(async () => {
      oldResult?.({ saved: true, usable: true, message: "" });
    });
    expect(screen.getByRole("button", { name: "测试连接" })).toBeDisabled();
    expect(screen.getByText("请重新保存密钥")).toBeInTheDocument();
  });

  it("自启设置失败不会保存假状态，通知只有主动测试时发送", async () => {
    vi.mocked(system.setSystemAutostart).mockRejectedValue(
      new Error("系统设置失败"),
    );
    render(<SettingsPage />);
    const autostart = screen.getByRole("checkbox", { name: /开机自动启动/ });
    await waitFor(() => expect(autostart).toBeEnabled());
    fireEvent.click(autostart);
    await screen.findByText(/系统设置失败/);
    expect(useAppStore.getState().preferences.autostart).toBe(false);
    expect(autostart).not.toBeChecked();
    expect(system.sendTestNotification).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /桌面通知/ }));
    expect(system.sendTestNotification).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发送测试通知" }));
    await waitFor(() =>
      expect(system.sendTestNotification).toHaveBeenCalledTimes(1),
    );
  });
});

describe("专注完成通知", () => {
  it("主动开启通知后自然完成只通知一次，标记任务不会重复通知", async () => {
    vi.useFakeTimers();
    useAppStore.getState().updatePreferences({ notifications: true });
    useAppStore.getState().addTask("测试专注", 1 / 60, "medium");
    const task = useAppStore.getState().tasks[0];
    render(<FocusModal task={task} onClose={() => undefined} />);
    expect(system.sendFocusCompletedNotification).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("这一段专注完成了")).toBeInTheDocument();
    expect(system.sendFocusCompletedNotification).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "完成任务" }));
    expect(useAppStore.getState().tasks[0].completed).toBe(true);
    expect(system.sendFocusCompletedNotification).toHaveBeenCalledTimes(1);
  });

  it("未开启通知时完成任务只更新本地状态", () => {
    useAppStore.getState().addTask("测试专注", 5, "medium");
    render(
      <FocusModal
        task={useAppStore.getState().tasks[0]}
        onClose={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "完成任务" }));
    expect(useAppStore.getState().tasks[0].completed).toBe(true);
    expect(system.sendFocusCompletedNotification).not.toHaveBeenCalled();
  });
});

describe("平台配置与模型选择", () => {
  it("地址只增尾空格不取消正在读取的密钥状态，错误地址明确拒绝", async () => {
    let finish!: (status: native.AiKeyStatus) => void;
    vi.mocked(native.getAiKeyStatus).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<SettingsPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "Base URL" }), {
      target: { value: `${initialPreferences.aiBaseUrl} ` },
    });
    expect(native.getAiKeyStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ saved: true, usable: true, message: "" });
    });
    expect(screen.getByRole("button", { name: "获取模型" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "测试连接" })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Base URL" }), {
      target: { value: `${initialPreferences.aiBaseUrl}?key=secret` },
    });
    expect(screen.getByText(/接口地址不能包含密钥/)).toBeInTheDocument();
    expect(useAppStore.getState().preferences.aiBaseUrl).toBe(
      initialPreferences.aiBaseUrl,
    );
    expect(screen.getByRole("button", { name: "获取模型" })).toBeEnabled();
  });
  it("切换平台保留分别编辑的接口和模型，且不会自动获取目录", async () => {
    render(<SettingsPage />);
    await screen.findByText("密钥已配置");
    fireEvent.change(screen.getByRole("textbox", { name: "模型名称" }), {
      target: { value: "my-sense-model" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "服务商" }), {
      target: { value: "siliconflow" },
    });
    await screen.findByText("密钥已配置");
    fireEvent.change(screen.getByRole("textbox", { name: "Base URL" }), {
      target: { value: "https://custom-sf.example/v1" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "模型名称" }), {
      target: { value: "Qwen/my-model" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "服务商" }), {
      target: { value: initialPreferences.aiProvider },
    });
    expect(screen.getByRole("textbox", { name: "模型名称" })).toHaveValue(
      "my-sense-model",
    );
    fireEvent.change(screen.getByRole("combobox", { name: "服务商" }), {
      target: { value: "siliconflow" },
    });
    expect(screen.getByRole("textbox", { name: "Base URL" })).toHaveValue(
      "https://custom-sf.example/v1",
    );
    expect(screen.getByRole("textbox", { name: "模型名称" })).toHaveValue(
      "Qwen/my-model",
    );
    expect(native.listAiModels).not.toHaveBeenCalled();
    await act(async () => undefined);
  });

  it("只有匹配的已存密钥能获取目录，目录不会自动替换模型", async () => {
    vi.mocked(native.getAiKeyStatus).mockResolvedValue({
      saved: true,
      usable: false,
      message: "接口未授权",
    });
    const view = render(<SettingsPage />);
    await screen.findByText("接口未授权");
    expect(screen.getByRole("button", { name: "获取模型" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    expect(native.listAiModels).not.toHaveBeenCalled();
    view.unmount();
    vi.mocked(native.getAiKeyStatus).mockResolvedValue({
      saved: true,
      usable: true,
      message: "",
    });
    vi.mocked(native.listAiModels).mockResolvedValue({
      models: ["Qwen/Qwen3-8B", "sensenova-u1-fast"],
      source: "live",
    });
    render(<SettingsPage />);
    await screen.findByText("密钥已配置");
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    await screen.findByRole("combobox", { name: "选择目录模型" });
    expect(screen.getByRole("textbox", { name: "模型名称" })).toHaveValue(
      initialPreferences.aiModel,
    );
    expect(native.listAiModels).toHaveBeenCalledWith(
      initialPreferences.aiProvider,
      initialPreferences.aiBaseUrl,
      true,
      20,
    );
    expect(
      screen.getByRole("option", { name: /sensenova-u1-fast/ }),
    ).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "筛选模型" }), {
      target: { value: "qwen" },
    });
    expect(
      screen.queryByRole("option", { name: /sensenova-u1-fast/ }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "选择目录模型" }), {
      target: { value: "Qwen/Qwen3-8B" },
    });
    expect(screen.getByRole("textbox", { name: "模型名称" })).toHaveValue(
      "Qwen/Qwen3-8B",
    );
    expect(native.testAiConnection).not.toHaveBeenCalled();
  });

  it("模型目录失败/为空仍可手输，失败消息不会锁住界面", async () => {
    vi.mocked(native.listAiModels)
      .mockRejectedValueOnce("此接口不支持模型目录")
      .mockResolvedValueOnce({ models: [], source: "live" });
    render(<SettingsPage />);
    await screen.findByText("密钥已配置");
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    await screen.findByText(/此接口不支持模型目录/);
    expect(screen.getByRole("textbox", { name: "模型名称" })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: "模型名称" }), {
      target: { value: "manual-chat" },
    });
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    await screen.findByText(/未返回模型目录/);
    expect(screen.getByRole("textbox", { name: "模型名称" })).toHaveValue(
      "manual-chat",
    );
  });

  it("目录加载防连击，切换服务商后丢弃旧平台迟到结果", async () => {
    let finish!: (list: native.AiModelList) => void;
    vi.mocked(native.listAiModels).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<SettingsPage />);
    await screen.findByText("密钥已配置");
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    fireEvent.click(screen.getByRole("button", { name: "正在获取模型…" }));
    expect(native.listAiModels).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("combobox", { name: "服务商" }), {
      target: { value: "siliconflow" },
    });
    await act(async () => {
      finish({ models: ["late-old-model"], source: "live" });
    });
    expect(
      screen.queryByRole("option", { name: "late-old-model" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "模型名称" })).toHaveValue(
      "Qwen/Qwen3-8B",
    );
    expect(screen.getByRole("button", { name: "获取模型" })).toBeEnabled();
  });
});

describe("场景音乐与独立鼓励交互", () => {
  it("图像生成模型不会被用于文字陪伴请求", async () => {
    useAppStore.getState().updatePreferences({ aiModel: "sensenova-u1-fast" });
    render(<ContentPage />);
    expect(screen.getByRole("button", { name: "给我一句鼓励" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /AI 按今日节奏推荐/ }),
    ).toBeDisabled();
    expect(
      screen.getByText(/请先在设置中选择文本聊天模型/),
    ).toBeInTheDocument();
    expect(native.generateEncouragement).not.toHaveBeenCalled();
    expect(native.recommendMusicWithAi).not.toHaveBeenCalled();
    await act(async () => undefined);
  });
  it("音乐预览完整展示场景心情，AI类别只用于本次播放且不改好句", async () => {
    useMusicPreferenceStore.setState({
      feedback: [
        {
          id: "local-feedback-only",
          title: "本机喜好",
          artist: "测试",
          category: "focus",
          rating: "like",
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const view = render(<ContentPage />);
    const quote = view.container.querySelector(".quote h2")?.textContent;
    fireEvent.change(screen.getByRole("combobox", { name: "当前场景" }), {
      target: { value: "focus" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "此刻心情" }), {
      target: { value: "tense" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "音乐陪伴方式" }), {
      target: { value: "lift" },
    });
    fireEvent.click(screen.getByRole("button", { name: /AI 按今日节奏推荐/ }));
    await screen.findByText("确认本次发送内容");
    expect(screen.getByText("场景：专心做事")).toBeInTheDocument();
    expect(screen.getByText("心情：有点紧绷")).toBeInTheDocument();
    expect(screen.getByText("音乐陪伴方式：提一点精神")).toBeInTheDocument();
    expect(screen.getByText(/本地时段：\d+ 点/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认推荐" }));
    await screen.findByText(/AI 推荐 ·/);
    expect(native.recommendMusicWithAi).toHaveBeenCalledWith(
      expect.objectContaining({
        scene: "focus",
        mood: "tense",
        intent: "lift",
        hour: expect.any(Number),
      }),
    );
    expect(
      vi.mocked(native.recommendMusicWithAi).mock.calls[0][0],
    ).not.toHaveProperty("feedback");
    expect(
      vi.mocked(native.recommendMusicWithAi).mock.calls[0][0],
    ).not.toHaveProperty("recentIds");
    expect(useAppStore.getState().preferences.musicCategory).toBe("smart");
    expect(screen.getByRole("button", { name: "轻柔专注" })).toHaveClass(
      "active",
    );
    expect(view.container.querySelector(".quote h2")?.textContent).toBe(quote);
  });

  it("鼓励单独确认、无摘要字段、不改变好句或音乐；失败温和回退", async () => {
    useAppStore.getState().updatePreferences({ aiShareActivitySummary: true });
    vi.mocked(native.generateEncouragement).mockRejectedValueOnce("连接失败");
    const view = render(<ContentPage />);
    const quote = view.container.querySelector(".quote h2")?.textContent;
    fireEvent.change(screen.getByRole("combobox", { name: "当前场景" }), {
      target: { value: "rest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "给我一句鼓励" }));
    expect(
      screen.getByRole("region", { name: "鼓励发送预览" }),
    ).toHaveTextContent("不读取或发送任务");
    expect(native.generateEncouragement).not.toHaveBeenCalled();
    expect(native.getTodayStats).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认生成鼓励" }));
    await screen.findByText("本地鼓励");
    expect(
      Object.keys(
        vi.mocked(native.generateEncouragement).mock.calls[0][0],
      ).sort(),
    ).toEqual(
      [
        "provider",
        "baseUrl",
        "model",
        "needsKey",
        "maxDailyCalls",
        "scene",
        "mood",
        "hour",
        "tone",
      ].sort(),
    );
    expect(native.recommendMusicWithAi).not.toHaveBeenCalled();
    expect(view.container.querySelector(".quote h2")?.textContent).toBe(quote);
    expect(useAppStore.getState().preferences.musicCategory).toBe("smart");
  });

  it("场景变更撤销旧预览，未确认的鼓励不联网", async () => {
    render(<ContentPage />);
    fireEvent.click(screen.getByRole("button", { name: "给我一句鼓励" }));
    fireEvent.change(screen.getByRole("combobox", { name: "此刻心情" }), {
      target: { value: "good" },
    });
    expect(
      screen.queryByRole("region", { name: "鼓励发送预览" }),
    ).not.toBeInTheDocument();
    expect(native.generateEncouragement).not.toHaveBeenCalled();
    await act(async () => undefined);
  });

  it("更换音乐类别不清空已经生成的鼓励", async () => {
    render(<ContentPage />);
    fireEvent.click(screen.getByRole("button", { name: "给我一句鼓励" }));
    fireEvent.click(screen.getByRole("button", { name: "确认生成鼓励" }));
    await screen.findByText("按自己的节奏开始就好。");
    fireEvent.change(screen.getByRole("combobox", { name: "音乐陪伴方式" }), {
      target: { value: "lift" },
    });
    expect(screen.getByText("按自己的节奏开始就好。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "国风民乐" }));
    expect(screen.getByText("按自己的节奏开始就好。")).toBeInTheDocument();
    expect(native.generateEncouragement).toHaveBeenCalledTimes(1);
  });

  it.each(["search", "same-category", "intent"])(
    "手动%s后旧AI音乐结果不能覆盖新意图，结束后能再次推荐",
    async (action) => {
      let finish!: (response: native.AiMusicResponse) => void;
      vi.mocked(native.recommendMusicWithAi).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      render(<ContentPage />);
      fireEvent.click(
        screen.getByRole("button", { name: /AI 按今日节奏推荐/ }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "确认推荐" }));
      if (action === "search") {
        fireEvent.change(
          screen.getByPlaceholderText("搜索 Audius 曲名、音乐人或心情"),
          { target: { value: "我选择的歌曲" } },
        );
        fireEvent.click(screen.getByRole("button", { name: "搜索" }));
      } else if (action === "intent") {
        fireEvent.change(
          screen.getByRole("combobox", { name: "音乐陪伴方式" }),
          { target: { value: "lift" } },
        );
      } else {
        fireEvent.click(screen.getByRole("button", { name: "智能推荐" }));
      }
      await act(async () => {
        finish({ category: "classical", reason: "迟到的推荐", source: "ai" });
      });
      expect(screen.queryByText(/迟到的推荐/)).not.toBeInTheDocument();
      if (action === "search") {
        expect(
          screen.getByPlaceholderText("搜索 Audius 曲名、音乐人或心情"),
        ).toHaveValue("我选择的歌曲");
        expect(screen.getByText(/正在搜索“我选择的歌曲”/)).toBeInTheDocument();
      } else {
        expect(screen.getByRole("button", { name: "智能推荐" })).toHaveClass(
          "active",
        );
      }
      expect(
        screen.getByRole("button", { name: /AI 按今日节奏推荐/ }),
      ).toBeEnabled();
      expect(native.recommendMusicWithAi).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["scene", "model"])(
    "%s改变后丢弃在途鼓励结果，防止重复请求",
    async (change) => {
      let finish!: (response: native.AiEncouragementResponse) => void;
      vi.mocked(native.generateEncouragement).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      render(<ContentPage />);
      fireEvent.click(screen.getByRole("button", { name: "给我一句鼓励" }));
      fireEvent.click(screen.getByRole("button", { name: "确认生成鼓励" }));
      fireEvent.click(screen.getByRole("button", { name: "正在想一句话…" }));
      expect(native.generateEncouragement).toHaveBeenCalledTimes(1);
      if (change === "scene") {
        fireEvent.change(screen.getByRole("combobox", { name: "当前场景" }), {
          target: { value: "sleep" },
        });
      } else {
        act(() => {
          useAppStore
            .getState()
            .updatePreferences({ aiModel: "changed-model" });
        });
        act(() => {
          useAppStore
            .getState()
            .updatePreferences({ aiModel: initialPreferences.aiModel });
        });
      }
      await act(async () => {
        finish({ text: "旧场景结果", source: "ai" });
      });
      expect(screen.queryByText("旧场景结果")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "给我一句鼓励" }),
      ).toBeEnabled();
    },
  );
});

describe("首次启动隐私与开机启动", () => {
  it("普通浏览器可渲染首页，不调用桌面窗口接口", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    useAppStore.setState({ onboarded: true });
    render(<App />);
    expect(screen.getByText("DayMate")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /收起为浮球/ })).toBeDisabled();
    expect(getCurrentWindow).not.toHaveBeenCalled();
    expect(native.setNativeTracking).not.toHaveBeenCalled();
    await act(async () => undefined);
  });
  it("未完成首次引导时不会启动活动或窗口标题记录", async () => {
    render(<App />);
    await waitFor(() =>
      expect(native.setNativeTracking).toHaveBeenCalledWith(false, false, true),
    );
    expect(native.setNativeTracking).not.toHaveBeenCalledWith(
      true,
      expect.anything(),
      expect.anything(),
    );
  });

  it("系统自启时仅收起一次，调整浮球偏好不重复隐藏窗口", async () => {
    vi.mocked(system.getSystemIntegrationStatus).mockResolvedValue({
      autostartEnabled: true,
      notificationPermission: "unknown",
      notificationStatusNote: "由系统决定",
      autostartLaunch: true,
    });
    useAppStore.setState({ onboarded: true });
    render(<App />);
    await waitFor(() => expect(hideMainToCompanion).toHaveBeenCalledTimes(1));
    act(() =>
      useAppStore.getState().updatePreferences({ floatingBall: false }),
    );
    act(() => useAppStore.getState().updatePreferences({ floatingBall: true }));
    expect(hideMainToCompanion).toHaveBeenCalledTimes(1);
  });
});
