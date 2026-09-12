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
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard, FocusModal, ReviewPage } from "./App";
import { getTodayStats, type TodayStats } from "./native";
import { useAppStore } from "./store";
import { useFocusStore } from "./focusStore";
import { localDateKey, yesterdayDateKey } from "./services/activityDates";
import { sendFocusCompletedNotification } from "./services/system";

vi.mock("./native", async (original) => ({
  ...(await original<typeof import("./native")>()),
  getTodayStats: vi.fn(),
}));
vi.mock("./services/system", async (original) => ({
  ...(await original<typeof import("./services/system")>()),
  sendFocusCompletedNotification: vi.fn(async () => undefined),
}));
vi.mock("./services/music", async (original) => ({
  ...(await original<typeof import("./services/music")>()),
  recommendMusic: vi.fn(async () => {
    throw new Error("offline test");
  }),
}));
vi.mock("./features/music/SmartMusicPlayer", () => ({
  SmartMusicPlayer: () => <div>音乐模块</div>,
  MusicFeedbackPanel: () => null,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => undefined),
}));
vi.mock("recharts", () =>
  Object.fromEntries(
    [
      "Bar",
      "BarChart",
      "CartesianGrid",
      "Cell",
      "Pie",
      "PieChart",
      "ResponsiveContainer",
      "Tooltip",
      "XAxis",
      "YAxis",
    ].map((name) => [
      name,
      ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    ]),
  ),
);
const stats = (seconds = 0): TodayStats => ({
  activeSeconds: seconds,
  idleSeconds: 60,
  appSwitches: 1,
  mouseClicks: 2,
  keyPresses: 3,
  lastInputSecondsAgo: 1,
  topApps: seconds ? [{ appName: "test.exe", seconds }] : [],
});
beforeEach(() => {
  vi.clearAllMocks();
  useFocusStore.getState().dismiss();
  useAppStore.setState({ tasks: [] });
  useAppStore.getState().updatePreferences({ notifications: false });
  vi.mocked(getTodayStats).mockResolvedValue(stats(120));
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
    () => undefined,
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("真实本地日期回顾", () => {
  it("首页查询昨天，不再永久显示空态", async () => {
    render(
      <Dashboard
        onAdd={() => undefined}
        onFocus={() => undefined}
        setPage={() => undefined}
      />,
    );
    expect(getTodayStats).toHaveBeenCalledWith(yesterdayDateKey());
    expect(await screen.findByText("昨日活跃 2 分钟")).toBeInTheDocument();
    expect(screen.queryByText("昨天还没有记录")).not.toBeInTheDocument();
  });
  it("切换日期会重新查询，迟到的今天结果不能覆盖昨天", async () => {
    let finishToday!: (data: TodayStats) => void;
    vi.mocked(getTodayStats).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishToday = resolve;
        }),
    );
    render(<ReviewPage />);
    expect(screen.getByLabelText("回顾日期")).toHaveValue(localDateKey());
    fireEvent.change(screen.getByLabelText("回顾日期"), {
      target: { value: yesterdayDateKey() },
    });
    await screen.findAllByText("2 分钟");
    await act(async () => {
      finishToday(stats(9999));
    });
    expect(screen.queryByText("166 分钟")).not.toBeInTheDocument();
    expect(getTodayStats).toHaveBeenCalledWith(yesterdayDateKey());
  });
  it("查询失败显示错误，不将旧日期记录伪装成新日期", async () => {
    render(<ReviewPage />);
    await screen.findAllByText("2 分钟");
    vi.mocked(getTodayStats).mockRejectedValue(new Error("test"));
    fireEvent.change(screen.getByLabelText("回顾日期"), {
      target: { value: yesterdayDateKey() },
    });
    await screen.findByRole("status");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("暂时无法读取"),
    );
    expect(screen.queryByText("2 分钟")).not.toBeInTheDocument();
  });
});

describe("专注收起与延迟恢复", () => {
  it("提前完成并立刻离开时也只发送一次通知", () => {
    useAppStore.getState().updatePreferences({ notifications: true });
    useAppStore.getState().addTask("提前完成", 5, "medium");
    const view = render(
      <FocusModal
        task={useAppStore.getState().tasks[0]}
        onClose={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "完成任务" }));
    view.unmount();
    expect(sendFocusCompletedNotification).toHaveBeenCalledTimes(1);
    expect(useFocusStore.getState().claimNotification()).toBe(false);
  });
  it("收起再打开不会重置，时间回调晚到时按截止时间完成", async () => {
    vi.useFakeTimers();
    useAppStore.getState().addTask("专注测试", 5, "medium");
    const task = useAppStore.getState().tasks[0];
    const first = render(<FocusModal task={task} onClose={() => undefined} />);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("04:00")).toBeInTheDocument();
    first.unmount();
    vi.setSystemTime(Date.now() + 60_000);
    render(<FocusModal task={task} onClose={() => undefined} />);
    expect(screen.getByText("03:00")).toBeInTheDocument();
    vi.setSystemTime(Date.now() + 180_000);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("这一段专注完成了")).toBeInTheDocument();
    expect(useAppStore.getState().tasks[0].completed).toBe(false);
  });
});
