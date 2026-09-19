import { describe, expect, it } from "vitest";
import { findAiProvider } from "./aiProviders";

describe("AI provider presets", () => {
  it("provides a ready-to-use SiliconFlow Qwen configuration", () => {
    expect(findAiProvider("siliconflow")).toMatchObject({
      name: "硅基流动 SiliconFlow",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "Qwen/Qwen3-8B",
      needsKey: true,
    });
  });
  it("provides an independent keyless local-model preset, not an Ollama alias", () => {
    expect(findAiProvider("local")).toEqual({
      id: "local",
      name: "本地模型（已有文件）",
      baseUrl: "http://127.0.0.1:8765/v1",
      model: "Qwen2.5-1.5B-Instruct",
      needsKey: false,
    });
    expect(findAiProvider("ollama").baseUrl).toBe("http://127.0.0.1:11434/v1");
  });
});
