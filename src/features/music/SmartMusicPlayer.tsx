import { useEffect, useState } from "react";
import {
  Heart,
  LoaderCircle,
  Music2,
  Pause,
  Play,
  Repeat1,
  RotateCcw,
  Shuffle,
  ThumbsDown,
  Trash2,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../../store";
import { useMusicPreferenceStore } from "../../musicStore";
import {
  musicCategories,
  type MusicCategory,
  type SmartTrack,
} from "../../services/music";
import { getMusicPlayback, useMusicPlayback } from "./playback";

function FeedbackButtons({
  track,
  category,
}: {
  track: SmartTrack;
  category: MusicCategory;
}) {
  const rating = useMusicPreferenceStore(
    (state) => state.feedback.find((item) => item.id === track.id)?.rating,
  );
  const rateTrack = useMusicPreferenceStore((state) => state.rateTrack);
  const [error, setError] = useState("");
  const rate = (next: "like" | "dislike") => {
    try {
      rateTrack(track, category, next);
      setError("");
    } catch {
      setError("本机反馈保存失败，请检查存储空间后重试。");
    }
  };
  return (
    <div className="music-feedback-buttons">
      <button
        className={`icon-button ${rating === "like" ? "active" : ""}`}
        aria-label={`${rating === "like" ? "撤销喜欢" : "喜欢"} ${track.title}`}
        aria-pressed={rating === "like"}
        onClick={() => rate("like")}
        title={rating === "like" ? "再次点击撤销喜欢" : "喜欢这首"}
      >
        <Heart size={16} />
      </button>
      <button
        className={`icon-button ${rating === "dislike" ? "active" : ""}`}
        aria-label={`${rating === "dislike" ? "撤销不喜欢" : "不喜欢"} ${track.title}`}
        aria-pressed={rating === "dislike"}
        onClick={() => rate("dislike")}
        title={rating === "dislike" ? "再次点击撤销不喜欢" : "不再推荐这首"}
      >
        <ThumbsDown size={16} />
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

export function MusicFeedbackPanel() {
  const { feedback, removeFeedback, clearFeedback } = useMusicPreferenceStore();
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState("");
  const remove = (id?: string) => {
    try {
      if (id) removeFeedback(id);
      else clearFeedback();
      setConfirmClear(false);
      setError("");
    } catch {
      setError("反馈暂时无法删除，请检查本机存储权限后重试。");
    }
  };
  return (
    <details className="music-feedback-history">
      <summary>本机音乐反馈（{feedback.length} / 200）</summary>
      <p>
        只在本机保存最多 200 条喜欢或不喜欢，不发送给
        AI。再次点同一反馈可撤销；不喜欢的歌曲不会进入候选。
      </p>
      {feedback.length ? (
        <>
          <ul>
            {feedback.map((item) => (
              <li key={item.id}>
                <span>
                  {item.title} · {item.artist}（
                  {item.rating === "like" ? "喜欢" : "不喜欢"}）
                </span>
                <button
                  className="text-button"
                  onClick={() => remove(item.id)}
                  aria-label={`撤销反馈 ${item.title}`}
                >
                  撤销
                </button>
              </li>
            ))}
          </ul>
          {!confirmClear ? (
            <button
              className="button ghost"
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 size={15} />
              清除本机音乐反馈
            </button>
          ) : (
            <div
              className="music-clear-confirm"
              role="group"
              aria-label="确认清除音乐反馈"
            >
              <span>
                确认清除全部 {feedback.length} 条反馈？这不会删除歌曲。
              </span>
              <button className="button danger" onClick={() => remove()}>
                确认清除反馈
              </button>
              <button
                className="button ghost"
                onClick={() => setConfirmClear(false)}
              >
                取消清除
              </button>
            </div>
          )}
        </>
      ) : (
        <p>还没有反馈。听到喜欢的歌曲时点一下爱心就好。</p>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}

export function SmartMusicPlayer({
  compact = false,
  onInteraction,
}: {
  compact?: boolean;
  onInteraction?: () => void;
}) {
  const controller = getMusicPlayback();
  const state = useMusicPlayback();
  const { preferences, updatePreferences } = useAppStore();
  const feedback = useMusicPreferenceStore((value) => value.feedback);
  const [sourceError, setSourceError] = useState("");
  const candidates = state.candidates.filter(
    (track) =>
      !feedback.some(
        (item) => item.id === track.id && item.rating === "dislike",
      ),
  );
  const track = state.track;
  const title = state.local?.name ?? track?.title;
  useEffect(() => {
    controller.ensureLoaded();
  }, [controller]);
  const next = () => {
    onInteraction?.();
    void controller.next();
  };
  return (
    <div className={`music-feature ${compact ? "compact" : ""}`}>
      <div className={`smart-music ${compact ? "compact" : ""}`}>
        {title ? (
          <>
            <button
              className="music-play"
              onClick={() => controller.toggle()}
              aria-label={state.playing ? "暂停音乐" : "播放音乐"}
            >
              {state.playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <div className="music-copy">
              <strong>{title}</strong>
              <span>
                {state.local
                  ? "本地歌曲 · 共用持续播放器"
                  : `${track?.scene} · ${track?.artist}`}
              </span>
              {!compact && track && <p>{track.reason}</p>}
              <input
                aria-label="音乐进度"
                type="range"
                min={0}
                max={state.duration > 0 ? state.duration : 1}
                value={Math.min(state.currentTime, state.duration || 0)}
                onChange={(event) =>
                  controller.seek(Number(event.target.value))
                }
              />
            </div>
          </>
        ) : (
          <>
            <Music2 />
            <div className="music-copy">
              <strong>
                {state.loading ? "正在挑选候选歌曲…" : "暂时没有可播放的歌曲"}
              </strong>
              <span>可以按心情推荐、调整类别或导入本地歌曲</span>
            </div>
          </>
        )}
        <div className="music-tools">
          <div className="music-mode-buttons">
            <button
              className={`icon-button ${preferences.musicAutoplay ? "active" : ""}`}
              onClick={() =>
                updatePreferences({ musicAutoplay: !preferences.musicAutoplay })
              }
              aria-label={
                preferences.musicAutoplay ? "关闭自动连播" : "开启自动连播"
              }
              aria-pressed={preferences.musicAutoplay}
              title="自动连播"
            >
              <Play size={15} />
            </button>
            <button
              className={`icon-button ${preferences.musicPlayMode === "shuffle" ? "active" : ""}`}
              onClick={() =>
                updatePreferences({
                  musicPlayMode:
                    preferences.musicPlayMode === "shuffle"
                      ? "sequence"
                      : "shuffle",
                })
              }
              aria-label="随机推荐"
              aria-pressed={preferences.musicPlayMode === "shuffle"}
              title="随机推荐"
            >
              <Shuffle size={15} />
            </button>
            <button
              className={`icon-button ${preferences.musicPlayMode === "single" ? "active" : ""}`}
              onClick={() =>
                updatePreferences({
                  musicPlayMode:
                    preferences.musicPlayMode === "single"
                      ? "sequence"
                      : "single",
                })
              }
              aria-label="单曲循环"
              aria-pressed={preferences.musicPlayMode === "single"}
              title="单曲循环"
            >
              <Repeat1 size={15} />
            </button>
          </div>
          <button
            className="icon-button"
            onClick={next}
            disabled={state.loading}
            aria-label="换一首"
            title="换一首"
          >
            <RotateCcw size={16} />
          </button>
          {!compact && track && (
            <button
              className="source-button"
              onClick={() =>
                openUrl(track.sourceUrl).catch(() =>
                  setSourceError("无法打开歌曲来源页面，请稍后再试。"),
                )
              }
            >
              {track.source} · {track.license}
            </button>
          )}
        </div>
      </div>
      {state.loading && (
        <p className="music-batch-note" role="status">
          <LoaderCircle className="spin" size={14} />
          正在整理候选，当前播放不受影响。
        </p>
      )}
      {(state.error || sourceError) && (
        <p className="music-batch-note" role="alert">
          {state.error || sourceError}
        </p>
      )}
      {!compact &&
        track &&
        !candidates.some((candidate) => candidate.id === track.id) && (
          <div className="music-current-feedback">
            <span>当前歌曲</span>
            <FeedbackButtons
              track={track}
              category={
                track.recommendation?.category ?? state.selection.category
              }
            />
          </div>
        )}
      {!compact && (
        <section className="music-candidates" aria-label="本次音乐候选">
          <div className="music-candidates-heading">
            <strong>本次候选（{candidates.length} / 5）</strong>
            <span>点选播放，不会自动打断当前歌曲</span>
          </div>
          {state.trace && (
            <p className="music-batch-note">
              {state.trace.source === "offline" ? "离线曲库" : "在线曲库"} ·
              检索 {state.trace.candidateCount} 首候选，
              {state.selection.search?.trim()
                ? "按目录搜索相关顺序，过滤不喜欢与受限曲目。"
                : "按本机反馈和近期播放筛选。"}
              {state.trace.repeatRelaxed &&
                " 可选歌曲较少，本次允许近期听过的歌曲。"}
              {state.trace.moodFilterRelaxed &&
                " 心情筛选无结果，已扩大到同类曲目。"}
            </p>
          )}
          {candidates.length ? (
            <ol>
              {candidates.map((candidate) => (
                <li
                  key={candidate.id}
                  className={track?.id === candidate.id ? "selected" : ""}
                >
                  <button
                    className="candidate-play"
                    aria-label={`播放候选 ${candidate.title}`}
                    onClick={() => {
                      onInteraction?.();
                      void controller.selectTrack(candidate);
                    }}
                  >
                    <Play size={15} />
                  </button>
                  <div className="candidate-copy">
                    <strong>{candidate.title}</strong>
                    <span>
                      {candidate.artist} ·{" "}
                      {musicCategories.find(
                        (category) =>
                          category.id === candidate.recommendation?.category,
                      )?.label ?? candidate.scene}
                    </span>
                    <details>
                      <summary>为什么推荐</summary>
                      <ul>
                        {(candidate.recommendation?.reasons.length
                          ? candidate.recommendation.reasons
                          : [candidate.reason]
                        ).map((reason, index) => (
                          <li key={index}>{reason}</li>
                        ))}
                      </ul>
                    </details>
                  </div>
                  <FeedbackButtons
                    track={candidate}
                    category={
                      candidate.recommendation?.category ??
                      state.selection.category
                    }
                  />
                </li>
              ))}
            </ol>
          ) : (
            !state.loading && (
              <p className="music-empty">
                没有符合条件的候选。可以换个类别、重新推荐，或在下方撤销不喜欢的反馈。
              </p>
            )
          )}
        </section>
      )}
    </div>
  );
}
