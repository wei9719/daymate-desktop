import { useEffect, useRef, useState } from "react";
import {
  createSafeLocalAudioBlob,
  localAudioAccept,
  LocalAudioImportError,
} from "../../services/localAudio";
import { getMusicPlayback, useMusicPlayback } from "./playback";

export function LocalMusicImport({
  onInteraction,
}: {
  onInteraction?: () => void;
}) {
  const controller = getMusicPlayback();
  const { local } = useMusicPlayback();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0);
  useEffect(() => {
    let selection = controller.getMediaSelectionRevision();
    const unsubscribe = controller.subscribe(() => {
      const current = controller.getMediaSelectionRevision();
      if (current === selection) return;
      selection = current;
      version.current += 1;
      setBusy(false);
      setError("");
    });
    return () => {
      unsubscribe();
      version.current += 1;
    };
  }, [controller]);
  const importAudio = async (file: File) => {
    const request = ++version.current;
    const selection = controller.getMediaSelectionRevision();
    setBusy(true);
    setError("");
    onInteraction?.();
    try {
      const blob = await createSafeLocalAudioBlob(file);
      if (
        version.current !== request ||
        selection !== controller.getMediaSelectionRevision()
      )
        return;
      controller.loadLocal(file.name, blob);
    } catch (reason) {
      if (version.current === request)
        setError(
          reason instanceof LocalAudioImportError
            ? reason.message
            : "暂时无法导入这首歌曲，请重新选择本地音频文件。",
        );
    } finally {
      if (version.current === request) setBusy(false);
    }
  };
  return (
    <>
      <div className="local-music">
        <label className="button ghost">
          {busy ? "正在检查歌曲…" : "导入本地歌曲"}
          <input
            type="file"
            aria-label="导入本地歌曲"
            accept={localAudioAccept}
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (file) void importAudio(file);
            }}
          />
        </label>
        <span>
          导入你合法拥有的 MP3、WAV、OGG、Opus 或 FLAC，单首不超过 100 MiB
        </span>
      </div>
      {error && <p role="alert">{error}</p>}
      {local && (
        <div className="local-player">
          <span>
            已导入：{local.name}。使用上方播放按钮；切换页面不会停止。
          </span>
          <button
            className="text-button"
            onClick={() => {
              onInteraction?.();
              controller.clearCurrent();
            }}
          >
            清空本地歌曲
          </button>
        </div>
      )}
    </>
  );
}
