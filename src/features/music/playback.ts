import { emit } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { useAppStore } from "../../store";
import { useMusicPreferenceStore } from "../../musicStore";
import {
  musicEndAction,
  nextMusicOffset,
  recommendMusicBatch,
  type MusicCategory,
  type SmartTrack,
} from "../../services/music";
import type {
  MusicFeedback,
  MusicRecommendationOptions,
} from "../../services/musicRanking";
import type { MusicPlayMode } from "../../types";

export const musicStateKey = "daymate-music-playing";
type MusicBatch = Awaited<ReturnType<typeof recommendMusicBatch>>;
export interface PlaybackSelection {
  category: MusicCategory;
  search?: string;
  context?: MusicRecommendationOptions["context"];
}
export interface PlaybackSnapshot {
  track?: SmartTrack;
  local?: { name: string; url: string };
  candidates: SmartTrack[];
  trace?: MusicBatch["trace"];
  selection: PlaybackSelection;
  playing: boolean;
  loading: boolean;
  currentTime: number;
  duration: number;
  error: string;
  empty: boolean;
}
interface PlaybackDependencies {
  createAudio: () => HTMLAudioElement;
  recommend: typeof recommendMusicBatch;
  preferences: () => {
    category: MusicCategory;
    autoplay: boolean;
    mode: MusicPlayMode;
    hasTasks: boolean;
  };
  feedback: () => readonly MusicFeedback[];
  recentIds: () => readonly string[];
  rememberTrack: (id: string) => void;
  publish: (playing: boolean) => void;
}

/** Owns the one audio element and its listeners, independently of any page. */
export class MusicPlaybackController {
  private audio?: HTMLAudioElement;
  private state: PlaybackSnapshot;
  private listeners = new Set<() => void>();
  private initialized = false;
  private requestVersion = 0;
  private playVersion = 0;
  private mediaSelectionRevision = 0;
  private offset = 0;
  private lastRememberedId?: string;
  private disposed = false;
  private endedDuringRequest = false;

  constructor(private dependencies: PlaybackDependencies) {
    this.state = {
      candidates: [],
      selection: { category: dependencies.preferences().category },
      playing: false,
      loading: false,
      currentTime: 0,
      duration: 0,
      error: "",
      empty: false,
    };
  }

  getSnapshot = () => this.state;
  getMediaSelectionRevision = () => this.mediaSelectionRevision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    // A page only owns its subscription. Do not pause or remove audio events.
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(next: Partial<PlaybackSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => listener());
  }
  private publish(playing: boolean) {
    this.update({ playing });
    this.dependencies.publish(playing);
  }
  private disliked(id: string) {
    return this.dependencies
      .feedback()
      .some((item) => item.id === id && item.rating === "dislike");
  }
  private onPlay = () => {
    this.publish(true);
    const id = this.state.track?.id;
    if (id && id !== this.lastRememberedId) {
      try {
        this.dependencies.rememberTrack(id);
      } catch {
        /* Playback must not fail when local storage is unavailable. */
      }
      this.lastRememberedId = id;
    }
  };
  private onPause = () => this.publish(false);
  private onTime = () =>
    this.update({ currentTime: Math.max(0, this.audio?.currentTime || 0) });
  private onMetadata = () =>
    this.update({
      duration: Number.isFinite(this.audio?.duration)
        ? this.audio!.duration
        : 0,
    });
  private onError = () => {
    this.publish(false);
    this.update({
      error: "这首歌曲无法解码或加载，请检查文件或换一首；其他功能不受影响。",
    });
  };
  private onEnded = () => {
    if (this.disposed) return;
    this.publish(false);
    const preferences = this.dependencies.preferences();
    const action = musicEndAction(preferences.mode, preferences.autoplay);
    if (
      action === "repeat" &&
      (!this.state.track || !this.disliked(this.state.track.id))
    ) {
      if (this.audio) this.audio.currentTime = 0;
      void this.play();
    } else if (
      action === "next" ||
      (this.state.track &&
        this.disliked(this.state.track.id) &&
        preferences.autoplay)
    ) {
      if (this.state.loading) {
        this.endedDuringRequest = true;
        return;
      }
      void this.next(true, true);
    }
  };
  private getAudio() {
    if (!this.audio) {
      this.audio = this.dependencies.createAudio();
      this.audio.preload = "metadata";
      this.audio.addEventListener("play", this.onPlay);
      this.audio.addEventListener("pause", this.onPause);
      this.audio.addEventListener("timeupdate", this.onTime);
      this.audio.addEventListener("loadedmetadata", this.onMetadata);
      this.audio.addEventListener("error", this.onError);
      this.audio.addEventListener("ended", this.onEnded);
    }
    return this.audio;
  }
  ensureLoaded() {
    if (this.initialized) return;
    this.initialized = true;
    void this.recommend({ category: this.dependencies.preferences().category });
  }

  async recommend(
    selection: PlaybackSelection,
    autoplay = false,
    selectFirst = false,
    automatic = false,
  ) {
    this.initialized = true;
    const version = ++this.requestVersion;
    const playVersion = this.playVersion;
    this.update({ loading: true, error: "", empty: false, selection });
    const preferences = this.dependencies.preferences();
    try {
      const batch = await this.dependencies.recommend(
        ++this.offset,
        preferences.hasTasks,
        selection.context?.hour ?? new Date().getHours(),
        selection.category,
        selection.search ?? "",
        {
          context: selection.context,
          feedback: this.dependencies.feedback(),
          recentIds: [
            ...new Set([
              ...this.dependencies.recentIds(),
              ...(this.state.track ? [this.state.track.id] : []),
            ]),
          ],
        },
      );
      if (version !== this.requestVersion || this.disposed) return;
      // Recheck feedback after the async request: a click may have happened meanwhile.
      const tracks = batch.tracks
        .filter((track) => !this.disliked(track.id))
        .slice(0, 5);
      this.update({
        candidates: tracks,
        trace: batch.trace,
        empty: tracks.length === 0,
      });
      if (!tracks.length) {
        this.update({
          error:
            "没有符合当前条件的候选歌曲。可调整类别或撤销不喜欢；不会绕过你的选择。",
        });
        return;
      }
      // Explicit recommendation refreshes the list, not a song already playing.
      // A later play/pause command wins, but still keep the new candidate list.
      // Automatic continuation additionally respects the current autoplay switch.
      if (
        playVersion === this.playVersion &&
        (!automatic || this.dependencies.preferences().autoplay) &&
        (selectFirst || autoplay || (!this.state.track && !this.state.local))
      )
        await this.selectTrack(tracks[0], autoplay, false);
    } catch {
      if (version === this.requestVersion)
        this.update({
          candidates: [],
          empty: true,
          error: "暂时无法获取候选歌曲，请稍后重试；已有播放不会被中断。",
        });
    } finally {
      if (version === this.requestVersion) {
        this.update({ loading: false });
        const resume = this.endedDuringRequest;
        this.endedDuringRequest = false;
        // Wait for the user's fresh batch before continuing. Empty results stay
        // stopped instead of recursively fetching or bypassing feedback.
        if (resume && this.state.candidates.length) this.onEnded();
      }
    }
  }

  async selectTrack(track: SmartTrack, autoplay = true, cancelPending = true) {
    if (this.disliked(track.id)) {
      this.update({ error: "你已将这首标为不喜欢。撤销后才能再次选择播放。" });
      return;
    }
    if (cancelPending) {
      this.requestVersion += 1;
      this.mediaSelectionRevision += 1;
    }
    this.endedDuringRequest = false;
    const audio = this.getAudio();
    this.playVersion += 1;
    audio.pause();
    const oldLocal = this.state.local?.url;
    audio.src = track.audioUrl;
    this.lastRememberedId = undefined;
    this.update({
      track,
      local: undefined,
      playing: false,
      loading: false,
      currentTime: 0,
      duration: 0,
      error: "",
    });
    if (oldLocal) URL.revokeObjectURL(oldLocal);
    if (autoplay) await this.play();
  }

  loadLocal(name: string, blob: Blob) {
    // The importer has validated the header; never accept an executable Blob MIME.
    if (
      !["audio/mpeg", "audio/wav", "audio/ogg", "audio/flac"].includes(
        blob.type,
      )
    )
      throw new Error("不支持的本地音频类型");
    this.requestVersion += 1;
    this.playVersion += 1;
    this.mediaSelectionRevision += 1;
    this.endedDuringRequest = false;
    this.initialized = true;
    const audio = this.getAudio();
    const url = URL.createObjectURL(blob);
    audio.pause();
    const oldLocal = this.state.local?.url;
    audio.src = url;
    this.update({
      local: { name: name.slice(0, 500), url },
      track: undefined,
      playing: false,
      loading: false,
      error: "",
      currentTime: 0,
      duration: 0,
    });
    if (oldLocal) URL.revokeObjectURL(oldLocal);
  }

  async play() {
    if (!this.state.track && !this.state.local) return;
    this.endedDuringRequest = false;
    if (this.state.track && this.disliked(this.state.track.id)) {
      this.update({ error: "这首已标记不喜欢，请撤销反馈或选择其他候选。" });
      return;
    }
    const version = ++this.playVersion;
    this.update({ error: "" });
    try {
      await this.getAudio().play();
    } catch {
      if (version !== this.playVersion) return;
      this.publish(false);
      this.update({
        error: "播放未能开始，可能被系统阻止。可再次点击播放或选择其他歌曲。",
      });
    }
  }
  toggle() {
    if (this.state.playing) {
      this.playVersion += 1;
      this.getAudio().pause();
    } else void this.play();
  }
  seek(seconds: number) {
    if (!Number.isFinite(seconds) || !this.audio || this.state.duration <= 0)
      return;
    this.audio.currentTime = Math.max(
      0,
      Math.min(seconds, this.state.duration),
    );
    this.onTime();
  }
  async next(autoplay = this.state.playing, automatic = false) {
    if (!automatic) this.mediaSelectionRevision += 1;
    const preferences = this.dependencies.preferences();
    const recent = this.dependencies.recentIds();
    const available = this.state.candidates.filter(
      (track) =>
        !this.disliked(track.id) &&
        track.id !== this.state.track?.id &&
        !recent.includes(track.id),
    );
    if (available.length) {
      const index =
        preferences.mode === "shuffle"
          ? Math.floor(Math.random() * available.length)
          : 0;
      await this.selectTrack(available[index], autoplay, !automatic);
    } else {
      this.offset += nextMusicOffset(preferences.mode);
      await this.recommend(this.state.selection, autoplay, true, automatic);
    }
  }
  clearCurrent() {
    this.requestVersion += 1;
    this.playVersion += 1;
    this.mediaSelectionRevision += 1;
    this.endedDuringRequest = false;
    this.audio?.pause();
    if (this.audio) this.audio.removeAttribute("src");
    const oldLocal = this.state.local?.url;
    this.update({
      track: undefined,
      local: undefined,
      playing: false,
      loading: false,
      error: "",
      currentTime: 0,
      duration: 0,
    });
    if (oldLocal) URL.revokeObjectURL(oldLocal);
    this.dependencies.publish(false);
  }
  dispose() {
    this.clearCurrent();
    this.disposed = true;
    if (this.audio) {
      this.audio.removeEventListener("play", this.onPlay);
      this.audio.removeEventListener("pause", this.onPause);
      this.audio.removeEventListener("timeupdate", this.onTime);
      this.audio.removeEventListener("loadedmetadata", this.onMetadata);
      this.audio.removeEventListener("error", this.onError);
      this.audio.removeEventListener("ended", this.onEnded);
    }
    this.listeners.clear();
  }
}

let singleton: MusicPlaybackController | undefined;
export function getMusicPlayback() {
  singleton ??= new MusicPlaybackController({
    createAudio: () => new Audio(),
    recommend: recommendMusicBatch,
    preferences: () => {
      const state = useAppStore.getState();
      return {
        category: state.preferences.musicCategory,
        autoplay: state.preferences.musicAutoplay,
        mode: state.preferences.musicPlayMode,
        hasTasks: state.tasks.some((task) => !task.completed),
      };
    },
    feedback: () => useMusicPreferenceStore.getState().feedback,
    recentIds: () => useMusicPreferenceStore.getState().recentIds,
    rememberTrack: (id) => useMusicPreferenceStore.getState().rememberTrack(id),
    publish: (playing) => {
      try {
        localStorage.setItem(musicStateKey, String(playing));
      } catch {
        /* Playback works when storage is unavailable. */
      }
      emit("music-state", { playing }).catch(() => undefined);
    },
  });
  return singleton;
}
export function useMusicPlayback() {
  const controller = getMusicPlayback();
  return useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
}
/** Used by isolated tests and final app teardown, never by page navigation. */
export function disposeMusicPlayback() {
  singleton?.dispose();
  singleton = undefined;
}
