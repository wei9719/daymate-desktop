import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  getSystemIntegrationStatus,
  sendFocusCompletedNotification,
  sendTestNotification,
  setSystemAutostart,
} from "./system";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

afterEach(() => vi.clearAllMocks());

describe("system integration boundary", () => {
  it("returns the OS state instead of assuming the requested switch succeeded", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(false);
    expect(await setSystemAutostart(true)).toBe(false);
    expect(invoke).toHaveBeenCalledWith("set_system_autostart", {
      enabled: true,
    });
  });

  it("propagates failures so the settings page can retain the last saved value", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("system denied"));
    await expect(setSystemAutostart(true)).rejects.toThrow("system denied");
  });

  it("does not report a browser preview as having system capabilities", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(getSystemIntegrationStatus()).rejects.toThrow("桌面版");
    await expect(sendTestNotification()).rejects.toThrow("桌面版");
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(isTauri).mockReturnValue(true);
  });

  it("notifications use fixed native content instead of passing task details", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await sendFocusCompletedNotification();
    expect(invoke).toHaveBeenCalledWith("send_focus_completed_notification");
  });
});
