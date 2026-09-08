import type { AiModelList } from "../native";

export function normalizeAiModels(value: unknown): AiModelList {
  if (
    !value ||
    typeof value !== "object" ||
    !("models" in value) ||
    !Array.isArray(value.models) ||
    !("source" in value) ||
    (value.source !== "live" && value.source !== "cache")
  ) {
    throw new Error("服务未返回可识别的模型目录，请手动填写聊天模型名称。");
  }
  const models = [
    ...new Set(
      value.models
        .slice(0, 500)
        .filter(
          (model): model is string =>
            typeof model === "string" &&
            model.length > 0 &&
            model.length <= 200 &&
            /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(model) &&
            !/^sk-/i.test(model),
        ),
    ),
  ];
  return { models, source: value.source };
}

export function isImageGenerationModel(model: string) {
  return /(?:^|[/:_-])(?:flux|sdxl|stable-diffusion|dall-e|gpt-image|kolors)(?:[/:_.-]|$)|^sensenova-u\d/i.test(
    model,
  );
}

export function filterAiModels(models: string[], query: string) {
  const search = query.trim().toLowerCase().slice(0, 200);
  return models.filter((model) => model.toLowerCase().includes(search));
}
