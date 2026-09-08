import { describe, expect, it } from "vitest";
import {
  filterAiModels,
  isImageGenerationModel,
  normalizeAiModels,
} from "./aiModels";

describe("不可信模型目录", () => {
  it("接受模型名、去重和过滤非法值，不替用户选择模型", () => {
    expect(
      normalizeAiModels({
        models: [
          "Qwen/Qwen3-8B",
          "Qwen/Qwen3-8B",
          "chat:local",
          null,
          "<svg>",
          "sk-test-only",
        ],
        source: "live",
      }),
    ).toEqual({ models: ["Qwen/Qwen3-8B", "chat:local"], source: "live" });
  });
  it.each([
    null,
    {},
    { models: "text", source: "live" },
    { models: [], source: "other" },
  ])("错误目录给出可操作的手输提示：%j", (input) => {
    expect(() => normalizeAiModels(input)).toThrow("手动填写");
  });
  it("限制目录条数并支持不区分大小写筛选", () => {
    const models = Array.from({ length: 1000 }, (_, index) => `model-${index}`);
    expect(normalizeAiModels({ models, source: "cache" }).models).toHaveLength(
      500,
    );
    expect(filterAiModels(["Qwen/Qwen3-8B", "glm-4"], " QWEN ")).toEqual([
      "Qwen/Qwen3-8B",
    ]);
  });
  it.each([
    "sensenova-u1-fast",
    "sensenova-u1.5-lite",
    "black-forest-labs/FLUX.1-schnell",
    "gpt-image-1",
  ])("标记图像生成模型：%s", (model) => {
    expect(isImageGenerationModel(model)).toBe(true);
  });
  it("不把普通文本或视觉理解模型误称生成图片", () => {
    expect(isImageGenerationModel("sensenova-6.8-flash-lite")).toBe(false);
    expect(isImageGenerationModel("Qwen/Qwen3-VL")).toBe(false);
  });
});
