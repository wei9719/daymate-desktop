import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { checkLocalAiStatus } from "./native";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("本地模型状态原生桥接", () => {
  it("浏览器预览明确拒绝，不伪造就绪或发出IPC", async () => {
    vi.stubGlobal("window", {});
    await expect(
      checkLocalAiStatus("http://127.0.0.1:8765/v1"),
    ).rejects.toThrow("浏览器预览不能检查本机模型服务");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("桌面只传服务地址，透传安全状态，不带Key或预算字段", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const status = {
      state: "busy",
      model: "Qwen2.5-1.5B-Instruct",
      device: "cpu",
      message: "稍后再试",
    };
    vi.mocked(invoke).mockResolvedValue(status);
    await expect(
      checkLocalAiStatus("http://127.0.0.1:8765/v1"),
    ).resolves.toEqual(status);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("check_local_ai_status", {
      baseUrl: "http://127.0.0.1:8765/v1",
    });
  });
});
