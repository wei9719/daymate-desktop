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
import { hideMainToCompanion } from "./windows";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

vi.mock("./native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native")>()),
  getTodayStats: vi.fn(async () => ({ activeSeconds: 780 })),
  setNativeTracking: vi.fn(async () => undefined),
  hasAiKey: vi.fn(async () => true),
  saveAiKey: vi.fn(async () => undefined),
  deleteAiKey: vi.fn(async () => undefined),
  getAiUsage: vi.fn(async () => ({ date: "2026-09-08", calls: 0 })),
  testAiConnection: vi.fn(async () => "连接成功"),
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
  recommendMusic: vi.fn(async () => ({
    id: "test-track",
    title: "测试曲目",
    artist: "测试音乐人",
    scene: "安静",
    reason: "本地测试",
    audioUrl: "/music/calm-theme.ogg",
    sourceUrl: "https://example.com",
    license: "CC0",
    source: "OpenGameArt",
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
  vi.clearAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(native.hasAiKey).mockResolvedValue(true);
  vi.mocked(native.saveAiKey).mockResolvedValue(undefined);
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
    expect(useAppStore.getState().preferences.musicCategory).not.toBe("smart");
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
    let resolveFirst: ((saved: boolean) => void) | undefined;
    vi.mocked(native.hasAiKey).mockImplementation((provider) =>
      provider === initialPreferences.aiProvider
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve(false),
    );
    render(<SettingsPage />);
    fireEvent.change(screen.getByRole("combobox", { name: "服务商" }), {
      target: { value: "siliconflow" },
    });
    await screen.findByText("尚未配置密钥");
    await act(async () => {
      resolveFirst?.(true);
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
    vi.mocked(native.hasAiKey).mockImplementation(
      async (provider) => provider === initialPreferences.aiProvider,
    );
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
      screen.queryByText("API Key 已安全保存到 Windows 凭据管理器。"),
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
