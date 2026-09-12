import type { CompanionContext } from "./companionContext";
import type { MusicCategory, SmartTrack } from "./music";

export type MusicIntent = "match" | "lift";
export interface MusicFeedback {
  id: string;
  title: string;
  artist: string;
  category: MusicCategory;
  rating: "like" | "dislike";
  updatedAt: string;
}
export interface MusicRecommendationOptions {
  context?: CompanionContext & { intent: MusicIntent };
  feedback?: readonly MusicFeedback[];
  recentIds?: readonly string[];
}
export const musicAlgorithmVersion = "mood-feedback-v1";
export const maxMusicFeedback = 200;
const categories = [
  "smart",
  "focus",
  "chinese",
  "classical",
  "ambient",
  "electronic",
] as const;

export function restoreMusicFeedback(value: unknown): MusicFeedback[] {
  if (!Array.isArray(value)) return [];
  const entries = new Map<string, MusicFeedback>();
  for (const item of value.slice(0, 1000)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !/^(audius-|local-)[A-Za-z0-9_-]{1,128}$/.test(row.id) ||
      typeof row.title !== "string" ||
      !row.title.trim() ||
      typeof row.artist !== "string" ||
      !categories.includes(row.category as MusicCategory) ||
      (row.rating !== "like" && row.rating !== "dislike") ||
      typeof row.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(row.updatedAt))
    )
      continue;
    const entry: MusicFeedback = {
      id: row.id,
      title: row.title.trim().slice(0, 300),
      artist: row.artist.trim().slice(0, 160),
      category: row.category as MusicCategory,
      rating: row.rating,
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
    if (
      !entries.has(entry.id) ||
      entries.get(entry.id)!.updatedAt < entry.updatedAt
    )
      entries.set(entry.id, entry);
  }
  return [...entries.values()]
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    )
    .slice(0, maxMusicFeedback);
}

export interface MusicPlan {
  category: MusicCategory;
  query: string;
  moods: readonly string[];
  keywords: readonly string[];
  label: string;
}

/** Curated retrieval hints, not inferred emotions, audio analysis or therapy. */
export function planMusic(
  category: MusicCategory,
  hasTasks: boolean,
  hour: number,
  context?: MusicRecommendationOptions["context"],
): MusicPlan {
  const scene = context?.scene ?? "auto";
  const mood = context?.mood ?? "neutral";
  const lift = context?.intent === "lift";
  const quiet = ["sleep", "rest", "relax"].includes(scene);
  const focused = scene === "focus" || scene === "start";
  const moods =
    quiet || mood === "tense"
      ? ["Peaceful", "Easygoing"]
      : focused
        ? ["Peaceful", "Sophisticated"]
        : lift
          ? ["Upbeat", "Energizing", "Easygoing"]
          : mood === "low"
            ? ["Sentimental", "Tender", "Peaceful"]
            : mood === "tired"
              ? ["Peaceful", "Easygoing"]
              : mood === "good"
                ? ["Upbeat", "Excited"]
                : [];
  const selected =
    category !== "smart"
      ? category
      : quiet || mood === "tense" || (mood === "tired" && !lift)
        ? "ambient"
        : focused
          ? "focus"
          : lift || mood === "good"
            ? "electronic"
            : mood === "low"
              ? "classical"
              : hasTasks || (hour >= 8 && hour < 18)
                ? "focus"
                : "ambient";
  const plans = {
    focus: {
      query: "instrumental",
      keywords: ["instrumental", "lofi", "study", "focus"],
      label: "轻柔专注",
    },
    chinese: {
      query: "guzheng",
      keywords: [
        "guzheng",
        "guqin",
        "erhu",
        "pipa",
        "chinese",
        "古筝",
        "古琴",
        "民乐",
      ],
      label: "国风民乐",
    },
    classical: {
      query: "piano",
      keywords: ["classical", "piano", "orchestral", "古典", "钢琴"],
      label: "古典舒缓",
    },
    ambient: {
      query: "ambient",
      keywords: ["ambient", "rain", "nature", "forest", "环境", "雨声"],
      label: "自然环境",
    },
    electronic: {
      query: "electronic",
      keywords: ["electronic", "dance", "house", "techno", "电子"],
      label: "电子节奏",
    },
  } as const;
  return { category: selected, moods, ...plans[selected] };
}

function hash(value: string) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1)
    result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return result >>> 0;
}

function knownArtist(artist: string) {
  const normalized = artist.trim().toLocaleLowerCase();
  return normalized && normalized !== "audius 独立音乐人"
    ? normalized
    : undefined;
}

/** Deterministic, bounded reranker. Scores are heuristics, never probabilities. */
export function rankMusicCandidates(
  candidates: readonly SmartTrack[],
  plan: MusicPlan,
  options: MusicRecommendationOptions = {},
  seed = "0",
  limit = 5,
  mode: "recommendation" | "search" = "recommendation",
) {
  const feedback = restoreMusicFeedback(options.feedback);
  const byId = new Map(feedback.map((entry) => [entry.id, entry]));
  const recent = new Set((options.recentIds ?? []).slice(-30));
  const seen = new Set<string>();
  const allowed = candidates.slice(0, 80).filter((track) => {
    if (seen.has(track.id) || byId.get(track.id)?.rating === "dislike")
      return false;
    seen.add(track.id);
    return true;
  });
  const wanted = Math.max(
    0,
    Math.min(5, Number.isFinite(limit) ? Math.floor(limit) : 5),
  );
  // An explicit search is a request to find a song, including one just played.
  // Keep the catalogue's relevance order after hard safety/feedback filtering.
  if (mode === "search") {
    return {
      tracks: allowed.slice(0, wanted).map((track) => ({
        ...track,
        recommendation: {
          score: 0,
          reasons: ["按目录搜索相关顺序展示，不应用心情加分或近期播放过滤"],
          category: plan.category,
          algorithmVersion: musicAlgorithmVersion,
        },
      })),
      excludedCount: candidates.length - allowed.length,
      repeatRelaxed: false,
    };
  }
  const fresh = allowed.filter((track) => !recent.has(track.id));
  const repeatRelaxed = !fresh.length && allowed.length > 0 && recent.size > 0;
  const pool = fresh.length ? fresh : allowed;
  const likedArtists = new Set(
    feedback.flatMap((entry) => {
      const artist = knownArtist(entry.artist);
      return entry.rating === "like" && artist ? [artist] : [];
    }),
  );
  const scored = pool.map((track) => {
    const artist = knownArtist(track.artist);
    let score = 0;
    const reasons: string[] = [];
    const metadata = [track.genre ?? "", ...(track.tags ?? [])]
      .join(" ")
      .toLocaleLowerCase();
    const matched = plan.keywords.find((keyword) => metadata.includes(keyword));
    if (matched) {
      score += 8;
      reasons.push(`曲目类型/标签含“${matched}”，与${plan.label}检索方向相符`);
    }
    if (
      track.mood &&
      plan.moods.some(
        (mood) => mood.toLocaleLowerCase() === track.mood!.toLocaleLowerCase(),
      )
    ) {
      score += 12;
      reasons.push(`发布者心情标签为 ${track.mood}，符合本次筛选方向`);
    }
    if (byId.get(track.id)?.rating === "like") {
      score += 6;
      reasons.push("你在本机标记过喜欢这首歌");
    } else if (artist && likedArtists.has(artist)) {
      score += 3;
      reasons.push("你在本机喜欢过这位音乐人的作品");
    }
    if (recent.size && !recent.has(track.id))
      reasons.push("本次会话近期未播放");
    if (!reasons.length)
      reasons.push("来自本次目录检索；元数据不足，暂不能确认心情匹配");
    if (repeatRelaxed)
      reasons.push("候选较少，近期曲目已轮换一遍；本次允许重复");
    return { track, artist, score, reasons, tie: hash(`${seed}:${track.id}`) };
  });
  const selected: typeof scored = [];
  while (scored.length && selected.length < wanted) {
    const adjusted = (item: (typeof scored)[number]) =>
      item.score -
      (item.artist && selected.some((other) => other.artist === item.artist)
        ? 5
        : 0);
    scored.sort(
      (a, b) =>
        adjusted(b) - adjusted(a) ||
        a.tie - b.tie ||
        a.track.id.localeCompare(b.track.id),
    );
    const next = scored.shift()!;
    const score = adjusted(next);
    if (score !== next.score)
      next.reasons.push("同一音乐人已在候选中，排序适当后移");
    selected.push({ ...next, score });
  }
  return {
    tracks: selected.map(({ track, score, reasons }) => ({
      ...track,
      recommendation: {
        score,
        reasons,
        category: plan.category,
        algorithmVersion: musicAlgorithmVersion,
      },
    })),
    excludedCount: candidates.length - allowed.length,
    repeatRelaxed,
  };
}
