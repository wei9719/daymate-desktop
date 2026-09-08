export interface AiProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  needsKey: boolean;
}

export const aiProviders: AiProvider[] = [
  {
    id: "sensenova",
    name: "商汤日日新 SenseNova",
    baseUrl: "https://token.sensenova.cn/v1",
    model: "sensenova-6.8-flash-lite",
    needsKey: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    needsKey: true,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    needsKey: true,
  },
  {
    id: "qwen",
    name: "阿里云百炼 / 通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    needsKey: true,
  },
  {
    id: "siliconflow",
    name: "硅基流动 SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen3-8B",
    needsKey: true,
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    needsKey: true,
  },
  {
    id: "moonshot",
    name: "Moonshot / Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    needsKey: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4.1-mini",
    needsKey: true,
  },
  {
    id: "ollama",
    name: "Ollama（本机）",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3:8b",
    needsKey: false,
  },
  {
    id: "custom",
    name: "自定义 OpenAI 兼容接口",
    baseUrl: "",
    model: "",
    needsKey: true,
  },
];

export function findAiProvider(id: string) {
  return (
    aiProviders.find((provider) => provider.id === id) ??
    aiProviders[aiProviders.length - 1]
  );
}
