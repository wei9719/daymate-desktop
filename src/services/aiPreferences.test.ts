import { describe, expect, it } from "vitest";
import { restorePreferences } from "./persistedState";
import { aiProfileText, restoreAiProfiles } from "./aiPreferences";
import { useAppStore } from "../store";

const defaults = useAppStore.getState().preferences;
describe("各平台 AI 配置与旧版本恢复", () => {
  it("首次迁移当前平台的旧地址与模型，不强制替换旧模型", () => {
    const restored = restorePreferences(
      {
        aiProvider: "sensenova",
        aiModel: "sensenova-6.7-flash-lite",
        aiBaseUrl: "https://token.sensenova.cn/v1",
      },
      defaults,
    );
    expect(restored.aiModel).toBe("sensenova-6.7-flash-lite");
    expect(restored.aiProfiles.sensenova).toEqual({
      baseUrl: restored.aiBaseUrl,
      model: restored.aiModel,
    });
  });
  it("切换平台恢复分别保存的配置，普通设置修改不会重置模型", () => {
    const first = restorePreferences(
      {
        aiProvider: "custom",
        aiBaseUrl: "https://my.example/v1",
        aiModel: "my-chat",
      },
      defaults,
    );
    const second = restorePreferences({ aiProvider: "siliconflow" }, first);
    expect(second.aiModel).toBe("Qwen/Qwen3-8B");
    const changed = restorePreferences({ aiModel: "Qwen/my-model" }, second);
    expect(restorePreferences({ theme: "dark" }, changed).aiModel).toBe(
      "Qwen/my-model",
    );
    const returned = restorePreferences({ aiProvider: "custom" }, changed);
    expect(returned.aiModel).toBe("my-chat");
    expect(returned.aiBaseUrl).toBe("https://my.example/v1");
    expect(
      restorePreferences({ aiProvider: "siliconflow" }, returned).aiModel,
    ).toBe("Qwen/my-model");
  });
  it("只恢复已知平台的两个普通字段，过滤密钥、陌生字段和坏结构", () => {
    const profiles = restoreAiProfiles({
      custom: {
        baseUrl: "https://my.example/v1",
        model: "my-chat",
        apiKey: "test-secret",
        token: "secret",
        metadata: {},
      },
      zhipu: [],
      unknown: { baseUrl: "https://evil.example", model: "evil" },
      siliconflow: { baseUrl: 13, model: null },
      constructor: { baseUrl: "https://evil.example" },
    });
    expect(profiles.custom).toEqual({
      baseUrl: "https://my.example/v1",
      model: "my-chat",
    });
    expect(profiles).not.toHaveProperty("unknown");
    expect(Object.keys(profiles)).not.toContain("constructor");
    expect(profiles).not.toHaveProperty("zhipu");
    expect(profiles.siliconflow.model).toBe("Qwen/Qwen3-8B");
    expect(JSON.stringify(profiles)).not.toContain("secret");
  });
  it.each([null, [], "broken", 7])("错误profile根结构安全回退：%j", (value) => {
    expect(restoreAiProfiles(value)).toEqual({});
  });
  it.each([
    "https://user:password@example.com/v1",
    "https://example.com/v1?api_key=secret",
    "https://example.com/v1#secret",
    "sk-test-only",
    "x".repeat(2050),
  ])("不把敏感或超长地址写入普通配置：%s", (value) => {
    expect(aiProfileText(value, "safe", "baseUrl")).toBe("safe");
  });
  it("空配置可编辑，坏模型和控制字符不会覆盖合法旧值", () => {
    expect(aiProfileText("", "old", "baseUrl")).toBe("");
    expect(aiProfileText("chat\u0000model", "old", "model")).toBe("old");
    expect(aiProfileText("sk-test-only", "old", "model")).toBe("old");
    expect(aiProfileText("x".repeat(201), "old", "model")).toBe("old");
  });
});
