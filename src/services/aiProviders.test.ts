import { describe, expect, it } from "vitest";
import { findAiProvider } from "./aiProviders";

describe("AI provider presets", () => {
  it("provides a ready-to-use SiliconFlow Qwen configuration", () => {
    expect(findAiProvider("siliconflow")).toMatchObject({
      name: "硅基流动 SiliconFlow",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "Qwen/Qwen2.5-7B-Instruct",
      needsKey: true,
    });
  });
});
