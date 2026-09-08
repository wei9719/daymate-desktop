import type { MusicPlayMode } from "../types";

export interface SmartTrack {
  id: string;
  title: string;
  artist: string;
  scene: string;
  reason: string;
  audioUrl: string;
  sourceUrl: string;
  license: string;
  source: "Audius" | "OpenGameArt";
}

export type MusicCategory =
  "smart" | "focus" | "chinese" | "classical" | "ambient" | "electronic";

export const musicCategories: { id: MusicCategory; label: string }[] = [
  { id: "smart", label: "智能推荐" },
  { id: "focus", label: "轻柔专注" },
  { id: "chinese", label: "国风民乐" },
  { id: "classical", label: "古典舒缓" },
  { id: "ambient", label: "自然环境" },
  { id: "electronic", label: "电子节奏" },
];

export function nextMusicOffset(
  mode: MusicPlayMode,
  random: () => number = Math.random,
) {
  return mode === "shuffle" ? 1 + Math.floor(random() * 39) : 1;
}

export function musicEndAction(mode: MusicPlayMode, autoplay: boolean) {
  if (mode === "single") return "repeat" as const;
  return autoplay ? ("next" as const) : ("stop" as const);
}

const bundledTracks: SmartTrack[] = [
  {
    id: "local-orient8",
    title: "Oriental 8",
    artist: "Tozan",
    scene: "国风民乐",
    reason: "带有东方弦乐色彩的轻量旋律，离线也能直接播放。",
    audioUrl: "/music/orient8.ogg",
    sourceUrl: "https://opengameart.org/content/oriental8",
    license: "CC0",
    source: "OpenGameArt",
  },
  {
    id: "local-not-that-east",
    title: "Not That East",
    artist: "KiluaBoy",
    scene: "国风民乐",
    reason: "安静的东方氛围循环，适合作为阅读或整理时的背景。",
    audioUrl: "/music/not-that-east.ogg",
    sourceUrl:
      "https://opengameart.org/content/sci-fi-adventure-eastern-quiet-piano-loop",
    license: "CC0",
    source: "OpenGameArt",
  },
  {
    id: "local-calm-theme",
    title: "Calm Theme",
    artist: "pebonius",
    scene: "轻柔专注",
    reason: "节奏平稳、存在感克制，适合进入任务。",
    audioUrl: "/music/calm-theme.ogg",
    sourceUrl: "https://opengameart.org/content/calm-theme",
    license: "CC0",
    source: "OpenGameArt",
  },
  {
    id: "local-oriented",
    title: "Oriented",
    artist: "yd",
    scene: "东方氛围",
    reason: "慢速东方氛围音乐，适合夜晚或需要安静的时候。",
    audioUrl: "/music/oriented.ogg",
    sourceUrl: "https://opengameart.org/content/oriented",
    license: "CC0",
    source: "OpenGameArt",
  },
];

export function bundledRecommendation(category: MusicCategory, offset: number) {
  const preferred =
    category === "chinese"
      ? bundledTracks.slice(0, 2)
      : category === "focus" ||
          category === "classical" ||
          category === "ambient"
        ? bundledTracks.slice(2)
        : bundledTracks;
  return preferred[recommendationIndex(offset, preferred.length)];
}

function recommendationIndex(offset: number, length: number) {
  const day = Math.floor(new Date().setHours(0, 0, 0, 0) / 86_400_000);
  const safeOffset = Number.isSafeInteger(offset) ? offset : 0;
  return (((day + safeOffset) % length) + length) % length;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedText(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function audiusSourceUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2048 || value.includes("\\"))
    return "https://audius.co";
  try {
    const url = new URL(value, "https://audius.co");
    if (url.origin === "https://audius.co" && !url.username && !url.password)
      return url.href;
  } catch {
    // An invalid permalink does not make an otherwise valid track unplayable.
  }
  return "https://audius.co";
}

const maxMusicResponseBytes = 512 * 1024;

async function readMusicResponse(response: Response): Promise<unknown> {
  const lengthHeader = response.headers.get("content-length");
  const declaredLength =
    lengthHeader === null ? undefined : Number(lengthHeader);
  if (
    declaredLength !== undefined &&
    (!Number.isFinite(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > maxMusicResponseBytes)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("音乐服务返回的数据过大或无效，请稍后再试。");
  }
  let raw: string;
  const reader = response.body?.getReader?.();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxMusicResponseBytes)
          throw new Error("音乐服务返回的数据过大，请稍后再试。");
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      raw = new TextDecoder().decode(bytes);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } else {
    // A declared Content-Length is untrusted and cannot bound text() allocation.
    throw new Error("当前浏览器无法安全读取音乐数据，可先使用离线推荐。");
  }
  if (raw.length > maxMusicResponseBytes)
    throw new Error("音乐服务返回的数据过大，请稍后再试。");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("音乐服务返回了无法读取的数据，请稍后再试。");
  }
}

interface MusicScene {
  query: string;
  keywords: readonly string[];
  scene: string;
  reason: string;
}

export function musicScene(hour: number, hasTasks: boolean) {
  if (hasTasks && hour >= 9 && hour < 18) {
    return {
      query: "instrumental focus study",
      keywords: ["work", "standing", "decision", "coexistenz", "old key"],
      scene: "轻柔专注",
      reason: "现在有待推进的事情，选一首少打扰的器乐。",
    };
  }
  if (hour >= 5 && hour < 10) {
    return {
      query: "morning acoustic peaceful",
      keywords: ["sweet sun", "picnic", "softly", "beach"],
      scene: "清醒启动",
      reason: "早晨适合从舒缓的旋律慢慢加载。",
    };
  }
  if (hour >= 10 && hour < 15) {
    return {
      query: "instrumental focus study",
      keywords: ["work", "standing", "decision", "old key"],
      scene: "稳定节奏",
      reason: "白天用没有歌词的音乐保持节奏。",
    };
  }
  if (hour >= 15 && hour < 19) {
    return {
      query: "upbeat electronic energy",
      keywords: [
        "roller fever",
        "dancing fool",
        "alive",
        "yippee",
        "after party",
      ],
      scene: "午后回血",
      reason: "下午选一首更有动感的器乐找回精力。",
    };
  }
  if (hour >= 19 && hour < 23) {
    return {
      query: "evening chill relax",
      keywords: ["softly", "i care", "sweet you", "hug", "beach"],
      scene: "下班放松",
      reason: "晚上把节奏放缓一点，给今天留个余地。",
    };
  }
  return {
    query: "ambient sleep peaceful",
    keywords: ["candle", "old saga", "softly", "untitled"],
    scene: "深夜安静",
    reason: "夜深了，推荐更轻、更慢的环境音乐。",
  };
}

function categoryScene(
  category: MusicCategory,
  fallback: ReturnType<typeof musicScene>,
) {
  const scenes = {
    focus: {
      query: "instrumental focus study",
      keywords: ["work", "standing", "decision", "old key"],
      scene: "轻柔专注",
      reason: "少歌词、低打扰，适合把注意力留给眼前的事。",
    },
    chinese: {
      query: "Chinese guzheng guqin instrumental",
      keywords: ["guzheng", "guqin", "erhu", "pipa", "chinese"],
      scene: "国风民乐",
      reason: "优先寻找开放授权的古琴、古筝、二胡和中国传统音乐。",
    },
    classical: {
      query: "classical piano peaceful",
      keywords: ["piano", "nocturne", "sonata", "bach", "mozart"],
      scene: "古典舒缓",
      reason: "用舒缓的古典旋律给思绪留一点空间。",
    },
    ambient: {
      query: "nature ambient rain forest",
      keywords: ["rain", "forest", "stream", "wind", "birds"],
      scene: "自然环境",
      reason: "雨声、森林和流水适合弱化周围的干扰。",
    },
    electronic: {
      query: "electronic upbeat energy",
      keywords: ["roller fever", "dancing fool", "alive", "after party"],
      scene: "电子节奏",
      reason: "更清晰的节拍，适合需要一点能量的时候。",
    },
  } as const;
  return category === "smart" ? fallback : scenes[category];
}

export function parseAudiusTracks(payload: unknown, scene: MusicScene) {
  const data = record(payload)?.data;
  if (!Array.isArray(data)) return [];
  const tracks: SmartTrack[] = [];
  const ids = new Set<string>();
  for (const candidate of data.slice(0, 40)) {
    const track = record(candidate);
    if (!track) continue;
    const id = track.id;
    const title = boundedText(track.title, 300);
    const access = record(track.access);
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
      ids.has(id) ||
      !title ||
      (track.is_streamable !== undefined && track.is_streamable !== true) ||
      (track.access !== undefined && !access) ||
      (access?.stream !== undefined && access.stream !== true)
    )
      continue;
    ids.add(id);
    const genre = boundedText(track.genre, 80);
    tracks.push({
      id: `audius-${id}`,
      title,
      artist: boundedText(record(track.user)?.name, 160) || "Audius 独立音乐人",
      scene: scene.scene,
      reason: `${scene.reason}${genre ? ` · ${genre}` : ""}`,
      // Never pass response-supplied stream URLs (including LAN targets) to audio.src.
      audioUrl: `https://api.audius.co/v1/tracks/${id}/stream`,
      sourceUrl: audiusSourceUrl(track.permalink),
      license: "官方可流式播放",
      source: "Audius",
    });
  }
  return tracks;
}

export async function recommendMusic(
  offset = 0,
  hasTasks = false,
  hour = new Date().getHours(),
  category: MusicCategory = "smart",
  search = "",
) {
  const scene = categoryScene(category, musicScene(hour, hasTasks));
  const query = search.trim().slice(0, 200);
  const parameters = new URLSearchParams({
    query: query || scene.query,
    limit: "40",
  });
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(
      `https://api.audius.co/v1/tracks/search?${parameters}`,
      {
        signal: controller.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error(`音乐服务返回 ${response.status}`);
    const tracks = parseAudiusTracks(await readMusicResponse(response), scene);
    if (!tracks.length)
      throw new Error(
        "开放曲库没有找到这首歌；商业版权歌曲可使用下方的本地导入播放",
      );
    return tracks[recommendationIndex(offset, tracks.length)];
  } catch (error) {
    if (search.trim()) throw error;
    return bundledRecommendation(category, offset);
  } finally {
    window.clearTimeout(timeout);
  }
}
