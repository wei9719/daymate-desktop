import { useEffect, useRef, useState } from "react";
import {
  checkLocalAiStatus,
  type LocalAiStatus as LocalStatus,
} from "../native";

const statusLabels: Record<LocalStatus["state"], string> = {
  loading: "模型正在加载",
  ready: "本地模型已就绪",
  busy: "本地模型忙碌中",
  error: "本地服务未就绪",
};
const nextSteps: Record<LocalStatus["state"], string> = {
  loading: "请等待独立服务加载完成，再手动检查；DayMate 不会自动轮询。",
  ready: "可以继续获取模型目录或测试连接；这不会自动更改已选模型。",
  busy: "请等当前推理结束后再试，避免重复提交请求。",
  error: "请先手动启动独立本机服务，检查服务地址和服务终端中的提示后重试。",
};

/** Mount identity is scoped to the selected provider, address and model. */
export function LocalAiStatus({ baseUrl }: { baseUrl: string }) {
  const [status, setStatus] = useState<LocalStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const version = useRef(0);
  useEffect(
    () => () => {
      version.current += 1;
    },
    [],
  );

  const check = async () => {
    if (running.current) return;
    const current = ++version.current;
    running.current = true;
    setBusy(true);
    setStatus(undefined);
    setError("");
    try {
      const result = await checkLocalAiStatus(baseUrl);
      if (current === version.current) setStatus(result);
    } catch (reason) {
      if (current === version.current) setError(String(reason));
    } finally {
      if (current === version.current) {
        running.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <section className="ai-key-field" aria-label="本地模型服务">
      <p className="ai-test-note">
        使用已有模型文件的独立本机服务，不是 Ollama，也不直接调用其他项目的
        RAG。 仅与本机回环地址通信，无需云端 API
        Key；不会下载模型，不会自动启动服务或加载模型占用 GPU。
        需要时先手动启动服务，再回到这里检查。
      </p>
      <p className="ai-test-note">
        Base URL 填服务地址，例如 http://127.0.0.1:8765/v1，不是模型文件夹路径。
        检查只读取同一地址的 /health，不发送聊天内容、不计 AI
        请求次数，也不会触发加载。
      </p>
      <div className="ai-actions">
        <button
          className="button secondary"
          disabled={busy || !baseUrl.trim()}
          onClick={check}
        >
          {busy ? "正在检查本地模型…" : "检查本地模型状态"}
        </button>
      </div>
      <p className="ai-status" role="status" aria-live="polite">
        {busy ? (
          "正在读取本机服务状态…"
        ) : status ? (
          <>
            <strong>{statusLabels[status.state]}</strong>。{status.message}{" "}
            {nextSteps[status.state]}
            {status.model && <span> 检测到模型：{status.model}。</span>}
            {status.device && <span> 运行设备：{status.device}。</span>}
          </>
        ) : (
          error || "尚未检查。选择此服务不会自动连接或启动本地模型。"
        )}
      </p>
    </section>
  );
}
