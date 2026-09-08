export type Page =
  "today" | "review" | "tasks" | "content" | "privacy" | "settings";

export type Priority = "high" | "medium" | "low";
export type MusicPlayMode = "sequence" | "shuffle" | "single";

export interface Task {
  id: string;
  title: string;
  estimatedMinutes: number;
  dueDate?: string;
  priority: Priority;
  completed: boolean;
  createdAt: string;
  completedAt?: string;
}

export interface Preferences {
  nickname: string;
  role: string;
  tone: "gentle" | "fun" | "direct" | "energetic";
  theme: "system" | "light" | "dark";
  trackActivity: boolean;
  trackWindowTitles: boolean;
  idleDetection: boolean;
  notifications: boolean;
  autostart: boolean;
  floatingBall: boolean;
  musicCategory:
    "smart" | "focus" | "chinese" | "classical" | "ambient" | "electronic";
  musicAutoplay: boolean;
  musicPlayMode: MusicPlayMode;
  backgroundOffset: number;
  aiEnabled: boolean;
  aiProvider: string;
  aiBaseUrl: string;
  aiModel: string;
  aiMaxDailyCalls: number;
  aiShareActivitySummary: boolean;
}

export interface DailyContent {
  quote: { text: string; author: string };
  joke: string;
  challenge: string;
}
