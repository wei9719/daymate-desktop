import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  BookOpen,
  Check,
  ChevronRight,
  Clock3,
  Coffee,
  Database,
  Heart,
  Home,
  ListTodo,
  GripHorizontal,
  Minimize2,
  Music2,
  Pause,
  Palette,
  Play,
  Plus,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getDailyContent } from "./data/dailyContent";
import { musicCategories, type MusicCategory } from "./services/music";
import {
  SmartMusicPlayer,
  MusicFeedbackPanel,
} from "./features/music/SmartMusicPlayer";
import { LocalMusicImport } from "./features/music/LocalMusicImport";
import {
  getMusicPlayback,
  musicStateKey,
  useMusicPlayback,
} from "./features/music/playback";
import type { MusicIntent } from "./services/musicRanking";
import { getDailyTheme } from "./services/dailyTheme";
import { localDateKey, yesterdayDateKey } from "./services/activityDates";
import { aiProviders, findAiProvider } from "./services/aiProviders";
import {
  matchesAiMusicPreferences,
  matchesEncouragementPreferences,
  prepareEncouragementRequest,
  prepareAiMusicRequest,
  resolveEncouragement,
  resolveAiMusicRecommendation,
} from "./services/aiRecommendation";
import {
  companionScenes,
  companionMoods,
  companionTones,
  currentCompanionContext,
} from "./services/companionContext";
import {
  filterAiModels,
  isImageGenerationModel,
  normalizeAiModels,
} from "./services/aiModels";
import { aiProfileText } from "./services/aiPreferences";
import {
  getSystemIntegrationStatus,
  setSystemAutostart,
  sendTestNotification,
} from "./services/system";
import { version as appVersion } from "../package.json";
import { selectNextTask, useAppStore } from "./store";
import { useFocusStore } from "./focusStore";
import { useFocusClock } from "./useFocusClock";
import {
  deleteAiKey,
  deleteNativeActivity,
  getDataLocation,
  getAiUsage,
  getTodayStats,
  getAiKeyStatus,
  listAiModels,
  generateEncouragement,
  recommendMusicWithAi,
  saveAiKey,
  setNativeTracking,
  showCompanionMenu,
  testAiConnection,
  type TodayStats,
  type AiMusicRequest,
  type AiUsage,
  type AiModelList,
  type AiEncouragementRequest,
} from "./native";
import type {
  Page,
  Priority,
  Task,
  CompanionScene,
  CompanionMood,
} from "./types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  hideCompanion,
  hideMainToCompanion,
  showMainWindow,
  startCompanionDragging,
} from "./windows";
import "./App.css";

const navItems: { id: Page; label: string; icon: typeof Home }[] = [
  { id: "today", label: "今日", icon: Home },
  { id: "review", label: "时间回顾", icon: BarChart3 },
  { id: "tasks", label: "任务", icon: ListTodo },
  { id: "content", label: "每日内容", icon: Sparkles },
  { id: "privacy", label: "数据与隐私", icon: ShieldCheck },
  { id: "settings", label: "设置", icon: Settings },
];

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function Onboarding() {
  const finish = useAppStore((state) => state.finishOnboarding);
  const [step, setStep] = useState(0);
  const [nickname, setNickname] = useState("");
  const [role, setRole] = useState("学生");
  const [tone, setTone] = useState<"gentle" | "fun" | "direct" | "energetic">(
    "gentle",
  );
  const [firstTask, setFirstTask] = useState("");

  const steps = [
    <div className="welcome" key="welcome">
      <div className="brand-mark large">日</div>
      <p className="eyebrow">欢迎使用 DayMate</p>
      <h1>让每一天，更容易开始。</h1>
      <p>回顾昨天、安排今天，也给生活添一点轻松和乐趣。</p>
    </div>,
    <div key="profile">
      <p className="eyebrow">认识一下</p>
      <h2>我们该怎么称呼你？</h2>
      <label>
        昵称
        <input
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          placeholder="朋友"
        />
      </label>
      <label>
        你目前更接近
        <input
          value={role}
          onChange={(event) => setRole(event.target.value)}
          list="roles"
        />
      </label>
      <datalist id="roles">
        <option>学生</option>
        <option>研究生</option>
        <option>职场人士</option>
        <option>程序员</option>
        <option>设计师</option>
        <option>自由职业者</option>
        <option>备考者</option>
        <option>其他</option>
      </datalist>
    </div>,
    <div key="tone">
      <p className="eyebrow">陪伴方式</p>
      <h2>你喜欢怎样的语气？</h2>
      <div className="option-grid">
        {(
          [
            ["gentle", "温柔陪伴"],
            ["fun", "轻松幽默"],
            ["direct", "简洁直接"],
            ["energetic", "热血鼓励"],
          ] as const
        ).map(([value, label]) => (
          <button
            className={`option ${tone === value ? "selected" : ""}`}
            onClick={() => setTone(value)}
            key={value}
          >
            {label}
          </button>
        ))}
      </div>
    </div>,
    <div key="privacy">
      <p className="eyebrow">隐私承诺</p>
      <h2>你的日常，只属于你。</h2>
      <div className="privacy-list">
        <p>
          <Check /> 默认只记录应用名称和使用时长
        </p>
        <p>
          <Check /> 不记录键盘输入、不截屏、不读聊天正文
        </p>
        <p>
          <Check /> 窗口标题默认关闭
        </p>
        <p>
          <Check /> 所有数据默认留在本机
        </p>
      </div>
    </div>,
    <div key="task">
      <p className="eyebrow">第一小步</p>
      <h2>今天最想推进什么？</h2>
      <label>
        写下一件事
        <input
          autoFocus
          value={firstTask}
          onChange={(event) => setFirstTask(event.target.value)}
          placeholder="例如：修改汇报 PPT 的第三页"
        />
      </label>
      <p className="muted">不用写完整计划，一件具体的小事就够了。</p>
    </div>,
  ];

  return (
    <main className="onboarding-shell">
      <section className="onboarding-card">
        {steps[step]}
        <footer>
          <div className="dots">
            {steps.map((_, index) => (
              <i className={index === step ? "active" : ""} key={index} />
            ))}
          </div>
          <div className="actions">
            {step > 0 && (
              <button
                className="button ghost"
                onClick={() => setStep(step - 1)}
              >
                上一步
              </button>
            )}
            <button
              className="button primary"
              onClick={() =>
                step === steps.length - 1
                  ? finish(
                      { nickname: nickname.trim() || "朋友", role, tone },
                      firstTask,
                    )
                  : setStep(step + 1)
              }
            >
              {step === steps.length - 1 ? "开始今天" : "继续"}
              <ChevronRight size={18} />
            </button>
          </div>
        </footer>
      </section>
    </main>
  );
}

function AddTaskModal({ onClose }: { onClose: () => void }) {
  const addTask = useAppStore((state) => state.addTask);
  const [title, setTitle] = useState("");
  const [minutes, setMinutes] = useState(25);
  const [priority, setPriority] = useState<Priority>("medium");
  const [dueDate, setDueDate] = useState("");
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim()) return;
          addTask(title, minutes, priority, dueDate);
          onClose();
        }}
      >
        <header>
          <div>
            <p className="eyebrow">今天，从一件事开始</p>
            <h2>添加任务</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X />
          </button>
        </header>
        <label>
          任务名称
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="要推进的具体事情"
          />
        </label>
        <div className="form-row">
          <label>
            预计时间
            <select
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
            >
              <option value={5}>5 分钟</option>
              <option value={15}>15 分钟</option>
              <option value={25}>25 分钟</option>
              <option value={45}>45 分钟</option>
              <option value={60}>60 分钟</option>
            </select>
          </label>
          <label>
            优先级
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value as Priority)}
            >
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </select>
          </label>
        </div>
        <label>
          截止日期（可选）
          <input
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </label>
        <button className="button primary wide" type="submit">
          添加到今天
        </button>
      </form>
    </div>
  );
}

export function FocusModal({
  task,
  onClose,
}: {
  task: Task;
  onClose: () => void;
}) {
  const toggleTask = useAppStore((state) => state.toggleTask);
  const taskCompleted = useAppStore(
    (state) =>
      state.tasks.find((item) => item.id === task.id)?.completed ??
      task.completed,
  );
  const { session, seconds, error: notificationStatus } = useFocusClock();
  const [saveError, setSaveError] = useState("");
  const actOnSession = (action: () => void) => {
    try {
      action();
      setSaveError("");
    } catch {
      setSaveError("专注状态保存失败，请检查可用空间后重试。");
    }
  };
  useEffect(() => {
    if (useFocusStore.getState().session?.taskId !== task.id)
      useFocusStore.getState().start(task);
  }, [task]);
  const running = session?.status === "running";
  const ended = session?.status === "completed";
  const progress =
    1 - seconds / (session?.durationSeconds ?? task.estimatedMinutes * 60);
  return (
    <div className="focus-overlay">
      <button
        className="icon-button focus-close"
        onClick={onClose}
        aria-label="收起专注，保留计时"
        title="收起专注，保留计时"
      >
        <X />
      </button>
      <div className="focus-content">
        <p className="eyebrow">{ended ? "这一段专注完成了" : "正在专注"}</p>
        <h2>{task.title}</h2>
        <div
          className="timer-ring"
          style={
            { "--progress": `${progress * 360}deg` } as React.CSSProperties
          }
        >
          <div>
            <strong>
              {String(Math.floor(seconds / 60)).padStart(2, "0")}:
              {String(seconds % 60).padStart(2, "0")}
            </strong>
            <span>
              {ended
                ? "辛苦了，留一点时间给自己"
                : running
                  ? "慢慢来，只做眼前这一点"
                  : "已经暂停，准备好再继续"}
            </span>
          </div>
        </div>
        <div className="focus-actions">
          {ended ? (
            <button
              className="button secondary"
              onClick={() =>
                actOnSession(() => {
                  useFocusStore.getState().dismiss();
                  onClose();
                })
              }
            >
              回到今天
            </button>
          ) : (
            <button
              className="button secondary"
              onClick={() =>
                actOnSession(() =>
                  running
                    ? useFocusStore.getState().pause()
                    : useFocusStore.getState().resume(),
                )
              }
            >
              {running ? <Pause /> : <Play />}
              {running ? "暂停" : "继续"}
            </button>
          )}
          {!taskCompleted && (
            <button
              className="button primary"
              onClick={() =>
                actOnSession(() => {
                  if (
                    !useAppStore
                      .getState()
                      .tasks.find((item) => item.id === task.id)?.completed
                  )
                    toggleTask(task.id);
                  useFocusStore.getState().complete();
                })
              }
            >
              <Check />
              完成任务
            </button>
          )}
          {!ended && (
            <button
              className="button secondary"
              onClick={() => {
                if (window.confirm("结束本次专注吗？任务不会被标记完成。"))
                  actOnSession(() => {
                    useFocusStore.getState().dismiss();
                    onClose();
                  });
              }}
            >
              结束本次专注
            </button>
          )}
        </div>
        <p>收起后仍会按时间计时；离开电脑想暂停时，请先点击“暂停”。</p>
        {saveError && <p role="alert">{saveError}</p>}
        {notificationStatus && <p role="status">{notificationStatus}</p>}
      </div>
    </div>
  );
}

function TaskRow({
  task,
  onFocus,
}: {
  task: Task;
  onFocus: (task: Task) => void;
}) {
  const toggleTask = useAppStore((state) => state.toggleTask);
  const removeTask = useAppStore((state) => state.removeTask);
  return (
    <article className={`task-row ${task.completed ? "completed" : ""}`}>
      <button className="task-check" onClick={() => toggleTask(task.id)}>
        {task.completed && <Check size={15} />}
      </button>
      <div className="task-copy">
        <strong>{task.title}</strong>
        <span>
          <Clock3 size={14} /> {task.estimatedMinutes} 分钟{" "}
          {task.dueDate && ` · ${task.dueDate} 截止`}
        </span>
      </div>
      <span className={`priority ${task.priority}`}>
        {task.priority === "high"
          ? "重要"
          : task.priority === "medium"
            ? "普通"
            : "轻松"}
      </span>
      {!task.completed && (
        <button className="mini-button" onClick={() => onFocus(task)}>
          <Play size={14} /> 开始
        </button>
      )}
      <button
        className="icon-button subtle"
        onClick={() => removeTask(task.id)}
        aria-label="删除任务"
      >
        <Trash2 size={16} />
      </button>
    </article>
  );
}

export function Dashboard({
  onAdd,
  onFocus,
  setPage,
}: {
  onAdd: () => void;
  onFocus: (task: Task) => void;
  setPage: (page: Page) => void;
}) {
  const { tasks, preferences } = useAppStore();
  const content = getDailyContent();
  const active = tasks.filter((task) => !task.completed).slice(0, 3);
  const next = selectNextTask(tasks);
  const [yesterdayStats, setYesterdayStats] = useState<TodayStats>();
  const [reviewError, setReviewError] = useState(false);
  useEffect(() => {
    let disposed = false;
    getTodayStats(yesterdayDateKey())
      .then((value) => {
        if (!disposed) setYesterdayStats(value);
      })
      .catch(() => {
        if (!disposed) setReviewError(true);
      });
    return () => {
      disposed = true;
    };
  }, []);
  const hasYesterday =
    yesterdayStats &&
    (yesterdayStats.activeSeconds > 0 ||
      yesterdayStats.idleSeconds > 0 ||
      yesterdayStats.mouseClicks > 0 ||
      yesterdayStats.keyPresses > 0);
  return (
    <div className="page">
      <header className="page-header hero">
        <div>
          <p className="date-line">
            {new Intl.DateTimeFormat("zh-CN", {
              month: "long",
              day: "numeric",
              weekday: "long",
            }).format(new Date())}
          </p>
          <h1>
            {greeting()}，{preferences.nickname}。
          </h1>
          <p>今天也不用一下子解决所有事情，我们先找到值得开始的那一件。</p>
        </div>
        <button className="button primary" onClick={onAdd}>
          <Plus />
          添加任务
        </button>
      </header>
      <section className="dashboard-grid">
        <article className="card overview-card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">昨日简报</p>
              <h2>
                {reviewError
                  ? "昨日回顾暂时无法读取"
                  : !yesterdayStats
                    ? "正在读取昨日记录…"
                    : hasYesterday
                      ? `昨日活跃 ${formatUsageDuration(yesterdayStats.activeSeconds)}`
                      : "昨天还没有记录"}
              </h2>
            </div>
            <div className="soft-icon">
              <BarChart3 />
            </div>
          </div>
          <p>
            {reviewError
              ? "记录没有被删除，可以进入时间回顾重新查询。"
              : hasYesterday
                ? `离开电脑 ${formatUsageDuration(yesterdayStats.idleSeconds)}。${
                    yesterdayStats.topApps?.length
                      ? `主要使用：${yesterdayStats.topApps
                          .slice(0, 3)
                          .map((app) => applicationDisplayName(app.appName))
                          .join("、")}。`
                      : "按自己的节奏，继续今天的一小步。"
                  }`
                : yesterdayStats
                  ? "今天开始以后，明天这里就会出现属于你的第一份回顾。"
                  : "只查询本机记录，不发送给 AI。"}
          </p>
          <button className="text-button" onClick={() => setPage("review")}>
            查看时间回顾 <ChevronRight size={16} />
          </button>
        </article>
        <article className="card supply-card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">今日精神补给</p>
              <h2>“{content.quote.text}”</h2>
            </div>
            <Heart />
          </div>
          <p>— {content.quote.author}</p>
          <SmartMusicPlayer compact />
        </article>
      </section>
      <section className="section-block">
        <div className="section-heading">
          <div>
            <p className="eyebrow">今日三件事</p>
            <h2>先把世界缩小一点</h2>
          </div>
          {next && (
            <button className="button secondary" onClick={() => onFocus(next)}>
              <Sparkles />
              帮我选一件
            </button>
          )}
        </div>
        <div className="task-list">
          {active.length ? (
            active.map((task) => (
              <TaskRow key={task.id} task={task} onFocus={onFocus} />
            ))
          ) : (
            <button className="empty-task" onClick={onAdd}>
              <Plus />
              <strong>写下今天最想推进的一件事</strong>
              <span>一件就够了，随时可以再加。</span>
            </button>
          )}
        </div>
      </section>
      <section className="mini-grid">
        <article className="mini-card">
          <Coffee />
          <div>
            <span>轻松一刻</span>
            <p>{content.joke}</p>
          </div>
        </article>
        <article className="mini-card">
          <Sparkles />
          <div>
            <span>今日微挑战</span>
            <p>{content.challenge}</p>
          </div>
        </article>
      </section>
    </div>
  );
}

function TasksPage({
  onAdd,
  onFocus,
}: {
  onAdd: () => void;
  onFocus: (task: Task) => void;
}) {
  const tasks = useAppStore((state) => state.tasks);
  const [filter, setFilter] = useState<"today" | "active" | "done">("today");
  const visible = tasks.filter((task) =>
    filter === "done"
      ? task.completed
      : filter === "active"
        ? !task.completed
        : true,
  );
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">任务</p>
          <h1>把要做的事，放到看得见的地方。</h1>
          <p>不需要维护复杂项目，先照顾好今天。</p>
        </div>
        <button className="button primary" onClick={onAdd}>
          <Plus />
          添加任务
        </button>
      </header>
      <div className="tabs">
        {(
          [
            ["today", "全部"],
            ["active", "进行中"],
            ["done", "已完成"],
          ] as const
        ).map(([value, label]) => (
          <button
            className={filter === value ? "active" : ""}
            onClick={() => setFilter(value)}
            key={value}
          >
            {label}
            <span>
              {value === "today"
                ? tasks.length
                : tasks.filter((task) =>
                    value === "done" ? task.completed : !task.completed,
                  ).length}
            </span>
          </button>
        ))}
      </div>
      <div className="task-list spacious">
        {visible.length ? (
          visible.map((task) => (
            <TaskRow key={task.id} task={task} onFocus={onFocus} />
          ))
        ) : (
          <div className="empty-state">
            <ListTodo />
            <h2>这里暂时是空的</h2>
            <p>没有堆积，也是一种进展。</p>
          </div>
        )}
      </div>
    </div>
  );
}

const usageColors = [
  "#5f8f7a",
  "#d39a6a",
  "#7796b5",
  "#a986b3",
  "#cf7f7b",
  "#91a56f",
  "#c5a55f",
  "#718b88",
];

type ApplicationUsage = TodayStats["topApps"][number];

function applicationDisplayName(appName: string) {
  return appName.replace(/\.exe$/i, "");
}

function compactApplicationName(appName: string) {
  const name = applicationDisplayName(appName);
  return name.length > 14 ? `${name.slice(0, 12)}…` : name;
}

function formatUsageDuration(seconds: number) {
  if (seconds < 60) return `${seconds} 秒`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (!hours) return `${minutes} 分钟`;
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

function ApplicationIcon({
  application,
  colorIndex,
}: {
  application: ApplicationUsage;
  colorIndex: number;
}) {
  const [failed, setFailed] = useState(false);
  const name = applicationDisplayName(application.appName);
  if (application.iconDataUrl && !failed) {
    return (
      <img
        className="application-icon"
        src={application.iconDataUrl}
        alt={`${name} 图标`}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className="application-icon fallback"
      style={{ background: usageColors[colorIndex % usageColors.length] }}
      aria-hidden="true"
    >
      {name.slice(0, 1).toUpperCase() || "?"}
    </span>
  );
}

export function ReviewPage() {
  const [date, setDate] = useState(localDateKey);
  const [queryError, setQueryError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<TodayStats>({
    activeSeconds: 0,
    idleSeconds: 0,
    appSwitches: 0,
    mouseClicks: 0,
    keyPresses: 0,
    lastInputSecondsAgo: 0,
    topApps: [],
  });
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      getTodayStats(date)
        .then((value) => {
          if (!disposed) {
            setStats(value);
            setQueryError(false);
          }
        })
        .catch(() => {
          if (!disposed) setQueryError(true);
        })
        .finally(() => {
          pending = false;
          if (!disposed) setLoading(false);
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 3_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [date]);
  const totalApplicationSeconds = stats.topApps.reduce(
    (total, application) => total + application.seconds,
    0,
  );
  const rankingData = stats.topApps.slice(0, 8).map((application) => ({
    name: compactApplicationName(application.appName),
    seconds: application.seconds,
  }));
  const distributionData = stats.topApps.slice(0, 5).map((application) => ({
    name: applicationDisplayName(application.appName),
    seconds: application.seconds,
  }));
  const otherSeconds = stats.topApps
    .slice(5)
    .reduce((total, application) => total + application.seconds, 0);
  if (otherSeconds)
    distributionData.push({ name: "其他应用", seconds: otherSeconds });
  const leadingApplication = stats.topApps[0];
  const lastInput =
    stats.lastInputSecondsAgo < 5
      ? "刚刚"
      : stats.lastInputSecondsAgo < 60
        ? `${stats.lastInputSecondsAgo} 秒前`
        : `${Math.floor(stats.lastInputSecondsAgo / 60)} 分钟前`;
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">时间回顾</p>
          <h1>看见节奏，不给自己打分。</h1>
          <p>活动采集启动后，这里会呈现真实的应用时长与专注区间。</p>
        </div>
        <input
          className="date-picker"
          type="date"
          aria-label="回顾日期"
          value={date}
          max={localDateKey()}
          onChange={(event) => {
            if (!event.target.value || event.target.value === date) return;
            setDate(event.target.value);
            setLoading(true);
            setQueryError(false);
          }}
        />
      </header>
      {loading || queryError ? (
        <p role="status">
          {queryError
            ? "该日期的记录暂时无法读取，正在重试。没有删除任何数据。"
            : "正在读取所选日期…"}
        </p>
      ) : (
        <>
          <section className="stats-grid">
            {[
              ["电脑活跃", formatUsageDuration(stats.activeSeconds)],
              [
                "当前应用",
                date === localDateKey()
                  ? (stats.currentApp ?? "等待数据")
                  : "仅今日显示",
              ],
              [
                "最近键鼠输入",
                date === localDateKey() ? lastInput : "仅今日显示",
              ],
              ["鼠标点击", `${stats.mouseClicks} 次`],
              ["键盘按键", `${stats.keyPresses} 次`],
              ["离开电脑", formatUsageDuration(stats.idleSeconds)],
              ["应用切换", `${stats.appSwitches} 次`],
            ].map(([label, value]) => (
              <article className="stat-card" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>
                  {date === localDateKey()
                    ? "今日本机数据"
                    : `${date} 本机数据`}
                </small>
              </article>
            ))}
          </section>
          <section className="input-detection-note">
            <ShieldCheck size={18} />
            <div>
              <strong>活跃时间由键盘和鼠标输入共同确认</strong>
              <span>
                连续 5
                分钟没有任何输入后，保持亮屏不再计入电脑活跃时间。只保存次数，不记录按键内容或鼠标位置。
              </span>
            </div>
          </section>
          {stats.topApps.length > 0 && (
            <>
              {leadingApplication && (
                <section className="usage-insight">
                  <Sparkles size={19} />
                  <div>
                    <strong>
                      {date === localDateKey() ? "今天" : "这一天"}
                      停留最久的是「
                      {applicationDisplayName(leadingApplication.appName)}」
                    </strong>
                    <span>
                      共 {formatUsageDuration(leadingApplication.seconds)}
                      ，约占已记录应用时长的{" "}
                      {totalApplicationSeconds
                        ? Math.round(
                            (leadingApplication.seconds /
                              totalApplicationSeconds) *
                              100,
                          )
                        : 0}
                      %。这里只呈现事实，不评价你如何使用时间。
                    </span>
                  </div>
                </section>
              )}
              <section className="activity-analysis-grid">
                <article className="card analysis-card ranking-chart-card">
                  <div className="card-heading">
                    <div>
                      <p className="eyebrow">时长排行</p>
                      <h2>时间主要去了哪里</h2>
                    </div>
                    <BarChart3 />
                  </div>
                  <div
                    className="ranking-chart"
                    style={{ height: Math.max(270, rankingData.length * 48) }}
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={rankingData}
                        layout="vertical"
                        margin={{ top: 8, right: 20, bottom: 8, left: 18 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          horizontal={false}
                        />
                        <XAxis
                          type="number"
                          tickFormatter={(value) =>
                            `${Math.round(Number(value) / 60)}m`
                          }
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          type="category"
                          dataKey="name"
                          width={120}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          formatter={(value) => [
                            formatUsageDuration(Number(value)),
                            "停留时长",
                          ]}
                          cursor={{ fill: "rgba(91, 142, 120, 0.07)" }}
                        />
                        <Bar
                          dataKey="seconds"
                          radius={[0, 8, 8, 0]}
                          barSize={18}
                        >
                          {rankingData.map((application, index) => (
                            <Cell
                              key={application.name}
                              fill={usageColors[index % usageColors.length]}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </article>
                <article className="card analysis-card distribution-card">
                  <div className="card-heading">
                    <div>
                      <p className="eyebrow">占比分布</p>
                      <h2>应用时间构成</h2>
                    </div>
                    <Clock3 />
                  </div>
                  <div className="distribution-chart">
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie
                          data={distributionData}
                          dataKey="seconds"
                          nameKey="name"
                          innerRadius={58}
                          outerRadius={86}
                          paddingAngle={2}
                          stroke="none"
                        >
                          {distributionData.map((application, index) => (
                            <Cell
                              key={application.name}
                              fill={usageColors[index % usageColors.length]}
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(value) => [
                            formatUsageDuration(Number(value)),
                            "停留时长",
                          ]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="distribution-total">
                      <strong>
                        {formatUsageDuration(totalApplicationSeconds)}
                      </strong>
                      <span>已记录</span>
                    </div>
                  </div>
                  <div className="distribution-legend">
                    {distributionData.map((application, index) => (
                      <div key={application.name}>
                        <i
                          style={{
                            background: usageColors[index % usageColors.length],
                          }}
                        />
                        <span>{application.name}</span>
                        <strong>
                          {totalApplicationSeconds
                            ? Math.round(
                                (application.seconds /
                                  totalApplicationSeconds) *
                                  100,
                              )
                            : 0}
                          %
                        </strong>
                      </div>
                    ))}
                  </div>
                </article>
              </section>
            </>
          )}
          <section className="card timeline">
            <div className="card-heading">
              <div>
                <p className="eyebrow">应用明细</p>
                <h2>每个应用停留了多久</h2>
              </div>
              <Clock3 />
            </div>
            {stats.topApps.length ? (
              <div className="app-usage-list">
                {stats.topApps.map((application, index) => {
                  const percentage = totalApplicationSeconds
                    ? (application.seconds / totalApplicationSeconds) * 100
                    : 0;
                  return (
                    <article
                      className="app-usage-row"
                      key={application.appName}
                    >
                      <ApplicationIcon
                        application={application}
                        colorIndex={index}
                      />
                      <div className="app-usage-content">
                        <div className="app-usage-heading">
                          <div>
                            <strong>
                              {applicationDisplayName(application.appName)}
                            </strong>
                            <span>{application.appName}</span>
                          </div>
                          <div className="app-usage-duration">
                            <strong>
                              {formatUsageDuration(application.seconds)}
                            </strong>
                            <span>{percentage.toFixed(1)}%</span>
                          </div>
                        </div>
                        <div className="app-usage-track">
                          <i
                            style={{
                              width: `${Math.max(percentage, 1)}%`,
                              background:
                                usageColors[index % usageColors.length],
                            }}
                          />
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state review-empty">
                <div className="review-empty-icon">
                  <BarChart3 />
                </div>
                <h2>
                  {date === localDateKey()
                    ? "今天还没留下足迹"
                    : "这一天还没有活动记录"}
                </h2>
                <p>
                  {date === localDateKey()
                    ? "开启活动记录并使用电脑一段时间后，再回来看看。"
                    : "可能当天没有开启记录，或相关数据已被清理。"}
                </p>
                <span className="review-empty-tip">
                  不用刻意记录，正常使用就好。DayMate
                  只关心节奏，不关心你在做什么。
                </span>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

export function ContentPage() {
  const [contentOffset, setContentOffset] = useState(0);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [scene, setScene] = useState<CompanionScene>("auto");
  const [mood, setMood] = useState<CompanionMood>("neutral");
  const [intent, setIntent] = useState<MusicIntent>("match");
  const [sessionMusicCategory, setSessionMusicCategory] =
    useState<MusicCategory>();
  const [pendingEncouragement, setPendingEncouragement] =
    useState<AiEncouragementRequest>();
  const [encouragement, setEncouragement] =
    useState<Awaited<ReturnType<typeof resolveEncouragement>>>();
  const [encouragementBusy, setEncouragementBusy] = useState(false);
  const encouragementRunning = useRef(false);
  const encouragementVersion = useRef(0);
  const [aiMusicStatus, setAiMusicStatus] = useState("");
  const [aiMusicBusy, setAiMusicBusy] = useState(false);
  const [pendingAiRequest, setPendingAiRequest] = useState<AiMusicRequest>();
  const aiMusicRequestRunning = useRef(false);
  const aiMusicRequestVersion = useRef(0);
  const { preferences, updatePreferences } = useAppStore();
  const content = getDailyContent(contentOffset);
  const context = currentCompanionContext(scene, mood);
  const musicContext = { ...context, intent };
  const playback = getMusicPlayback();
  const { loading: musicLoading } = useMusicPlayback();
  const playingCategory = sessionMusicCategory ?? preferences.musicCategory;
  const aiTextReady =
    preferences.aiEnabled &&
    Boolean(preferences.aiModel.trim()) &&
    !isImageGenerationModel(preferences.aiModel);
  const encouragementPreview =
    pendingEncouragement &&
    matchesEncouragementPreferences(pendingEncouragement, preferences, context)
      ? pendingEncouragement
      : undefined;
  const preview =
    pendingAiRequest &&
    matchesAiMusicPreferences(pendingAiRequest, preferences, musicContext)
      ? pendingAiRequest
      : undefined;
  useEffect(
    () => () => {
      aiMusicRequestVersion.current += 1;
      encouragementVersion.current += 1;
    },
    [],
  );
  const discardMusicResults = useCallback(() => {
    aiMusicRequestVersion.current += 1;
    setPendingAiRequest(undefined);
    setAiMusicStatus("");
  }, []);
  const discardEncouragementResults = useCallback(() => {
    encouragementVersion.current += 1;
    setPendingEncouragement(undefined);
    setEncouragement(undefined);
  }, []);
  const discardAiResults = useCallback(() => {
    discardMusicResults();
    discardEncouragementResults();
  }, [discardMusicResults, discardEncouragementResults]);
  useEffect(
    () =>
      useAppStore.subscribe((state, previous) => {
        const keys = [
          "aiEnabled",
          "aiProvider",
          "aiBaseUrl",
          "aiModel",
          "aiMaxDailyCalls",
        ] as const;
        if (
          keys.some(
            (key) => state.preferences[key] !== previous.preferences[key],
          )
        ) {
          discardAiResults();
        } else {
          if (
            state.preferences.musicCategory !==
              previous.preferences.musicCategory ||
            state.preferences.aiShareActivitySummary !==
              previous.preferences.aiShareActivitySummary
          )
            discardMusicResults();
          if (state.preferences.tone !== previous.preferences.tone)
            discardEncouragementResults();
        }
      }),
    [discardAiResults, discardMusicResults, discardEncouragementResults],
  );
  const chooseCategory = (category: MusicCategory) => {
    discardMusicResults();
    setSessionMusicCategory(undefined);
    updatePreferences({ musicCategory: category });
    setSearch("");
    setSearchDraft("");
    void playback.recommend({ category, context: musicContext });
  };
  const recommendForMood = () => {
    discardMusicResults();
    setSearch("");
    setSearchDraft("");
    setSessionMusicCategory(undefined);
    void playback.recommend({
      category: preferences.musicCategory,
      context: musicContext,
    });
  };
  const previewAiMusic = async () => {
    if (
      aiMusicRequestRunning.current ||
      encouragementRunning.current ||
      !preferences.aiEnabled
    )
      return;
    aiMusicRequestRunning.current = true;
    const requestVersion = ++aiMusicRequestVersion.current;
    setAiMusicBusy(true);
    setAiMusicStatus("");
    try {
      const request = await prepareAiMusicRequest(
        preferences,
        async () => (await getTodayStats()).activeSeconds,
        () =>
          useAppStore.getState().tasks.filter((task) => !task.completed).length,
        musicContext,
      );
      if (
        requestVersion === aiMusicRequestVersion.current &&
        matchesAiMusicPreferences(request, useAppStore.getState().preferences, {
          ...currentCompanionContext(scene, mood),
          intent,
        })
      ) {
        setPendingAiRequest(request);
      }
    } catch {
      if (requestVersion === aiMusicRequestVersion.current) {
        setAiMusicStatus(
          "暂时无法读取本地摘要。可以关闭设置中的摘要分享后重试，音乐播放仍可使用。",
        );
      }
    } finally {
      aiMusicRequestRunning.current = false;
      setAiMusicBusy(false);
    }
  };
  const askAiForMusic = async () => {
    if (
      !preview ||
      aiMusicRequestRunning.current ||
      encouragementRunning.current
    )
      return;
    aiMusicRequestRunning.current = true;
    const requestVersion = ++aiMusicRequestVersion.current;
    const request = preview;
    setPendingAiRequest(undefined);
    setAiMusicBusy(true);
    setAiMusicStatus("正在挑选适合的音乐类别…");
    try {
      const suggestion = await resolveAiMusicRecommendation(
        request,
        recommendMusicWithAi,
      );
      if (requestVersion !== aiMusicRequestVersion.current) return;
      if (
        !matchesAiMusicPreferences(
          request,
          useAppStore.getState().preferences,
          { ...currentCompanionContext(scene, mood), intent },
        )
      ) {
        setAiMusicStatus("设置或音乐偏好已改变，本次结果未应用，请重新推荐。");
        return;
      }
      setSessionMusicCategory(suggestion.category);
      setSearch("");
      setSearchDraft("");
      void playback.recommend({
        category: suggestion.category,
        context: {
          scene: request.scene,
          mood: request.mood,
          hour: request.hour,
          intent: request.intent,
        },
      });
      const source = { ai: "AI 推荐", cache: "近期缓存", local: "本地推荐" }[
        suggestion.source
      ];
      setAiMusicStatus(`${source} · ${suggestion.reason}`);
    } finally {
      aiMusicRequestRunning.current = false;
      setAiMusicBusy(false);
    }
  };
  const askForEncouragement = async () => {
    if (
      !encouragementPreview ||
      encouragementRunning.current ||
      aiMusicRequestRunning.current
    )
      return;
    const request = encouragementPreview;
    const version = ++encouragementVersion.current;
    encouragementRunning.current = true;
    setEncouragementBusy(true);
    setPendingEncouragement(undefined);
    try {
      const result = await resolveEncouragement(request, generateEncouragement);
      if (
        version === encouragementVersion.current &&
        matchesEncouragementPreferences(
          request,
          useAppStore.getState().preferences,
          currentCompanionContext(scene, mood),
        )
      ) {
        setEncouragement(result);
      }
    } finally {
      encouragementRunning.current = false;
      setEncouragementBusy(false);
    }
  };
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">每日内容</p>
          <h1>给认真生活的人，一点小小补给。</h1>
          <p>同一天默认保持一致，也可以随时换一组。</p>
        </div>
        <button
          className="button secondary"
          onClick={() => setContentOffset((value) => value + 1)}
        >
          <RotateCcw />
          换一组
        </button>
      </header>
      <section className="companion-controls" aria-label="本次陪伴场景">
        <label>
          当前场景
          <select
            value={scene}
            onChange={(event) => {
              discardAiResults();
              setScene(event.target.value as CompanionScene);
            }}
          >
            {companionScenes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          此刻心情
          <select
            value={mood}
            onChange={(event) => {
              discardAiResults();
              setMood(event.target.value as CompanionMood);
            }}
          >
            {companionMoods.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          音乐陪伴方式
          <select
            value={intent}
            onChange={(event) => {
              discardMusicResults();
              setIntent(event.target.value as MusicIntent);
            }}
          >
            <option value="match">陪伴此刻</option>
            <option value="lift">提一点精神</option>
          </select>
        </label>
        <button
          className="button primary"
          onClick={recommendForMood}
          disabled={musicLoading}
        >
          {musicLoading ? "正在整理音乐…" : "按心情推荐"}
        </button>
        <span>
          选择只用于下一次推荐，不会打断当前歌曲；依据自选偏好，不是心理诊断。无需开启
          AI 也可使用。
        </span>
      </section>
      <section className="encouragement-panel" aria-label="一句鼓励">
        <div className="ai-actions">
          <button
            className="button secondary"
            disabled={!aiTextReady || encouragementBusy || aiMusicBusy}
            onClick={() => {
              setPendingEncouragement(
                prepareEncouragementRequest(preferences, context),
              );
            }}
          >
            <Heart />
            {encouragementBusy ? "正在想一句话…" : "给我一句鼓励"}
          </button>
          <span>独立生成，不改变每日好句和正在播放的音乐。</span>
        </div>
        {preferences.aiEnabled && !aiTextReady && (
          <p className="ai-test-note">
            请先在设置中选择文本聊天模型；图像生成模型不用于音乐推荐或一句鼓励。
          </p>
        )}
        {encouragementPreview && (
          <section className="ai-preview" aria-label="鼓励发送预览">
            <strong>确认鼓励发送内容</strong>
            <p>
              {findAiProvider(encouragementPreview.provider).name} ·{" "}
              {encouragementPreview.model}
            </p>
            <p className="ai-endpoint">
              接收地址：{encouragementPreview.baseUrl}
            </p>
            <ul>
              <li>
                场景：
                {
                  companionScenes.find(
                    (item) => item.id === encouragementPreview.scene,
                  )?.label
                }
              </li>
              <li>
                心情：
                {
                  companionMoods.find(
                    (item) => item.id === encouragementPreview.mood,
                  )?.label
                }
              </li>
              <li>本地时段：{encouragementPreview.hour} 点</li>
              <li>陪伴语气：{companionTones[encouragementPreview.tone]}</li>
            </ul>
            <p>
              仅发送以上四项，不读取或发送任务、应用名称、活动统计和窗口标题。确认后访问所选服务；请求共享每日{" "}
              {encouragementPreview.maxDailyCalls} 次上限，近期缓存不计入。
            </p>
            <p>生成文本可能按服务商定价收费，本机次数上限不是账单限额。</p>
            <div className="ai-actions">
              <button
                className="button primary"
                disabled={encouragementBusy || aiMusicBusy}
                onClick={askForEncouragement}
              >
                确认生成鼓励
              </button>
              <button
                className="button ghost"
                onClick={() => setPendingEncouragement(undefined)}
              >
                取消鼓励
              </button>
            </div>
          </section>
        )}
        {encouragement && (
          <p className="encouragement-result" role="status">
            <span>
              {
                { ai: "AI 鼓励", cache: "近期缓存", local: "本地鼓励" }[
                  encouragement.source
                ]
              }
            </span>
            {encouragement.text}
          </p>
        )}
      </section>
      <section className="content-grid">
        <article className="content-card quote">
          <BookOpen />
          <span>每日好句</span>
          <h2>“{content.quote.text}”</h2>
          <p>— {content.quote.author}</p>
        </article>
        <article className="content-card music music-browser">
          <Music2 />
          <span>智能音乐</span>
          <form
            className="music-search"
            onSubmit={(event) => {
              event.preventDefault();
              discardMusicResults();
              setSearch(searchDraft.trim());
              void playback.recommend({
                category: playingCategory,
                search: searchDraft.trim(),
                context: musicContext,
              });
            }}
          >
            <input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="搜索 Audius 曲名、音乐人或心情"
            />
            <button className="button secondary" type="submit">
              搜索
            </button>
          </form>
          <div className="music-categories">
            {musicCategories.map((item) => (
              <button
                type="button"
                key={item.id}
                className={
                  playingCategory === item.id && !search ? "active" : ""
                }
                onClick={() => chooseCategory(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="ai-music-row">
            <button
              className="button secondary"
              type="button"
              disabled={!aiTextReady || aiMusicBusy || encouragementBusy}
              onClick={previewAiMusic}
            >
              <Sparkles /> AI 按今日节奏推荐
            </button>
            {!preferences.aiEnabled && <span>先在设置中启用并测试 AI</span>}
          </div>
          {preview && (
            <section className="ai-preview" aria-label="AI 推荐发送预览">
              <strong>确认本次发送内容</strong>
              <p>
                {findAiProvider(preview.provider).name} · {preview.model}
              </p>
              <p className="ai-endpoint">接收地址：{preview.baseUrl}</p>
              <ul>
                <li>
                  场景：
                  {
                    companionScenes.find((item) => item.id === preview.scene)
                      ?.label
                  }
                </li>
                <li>
                  心情：
                  {
                    companionMoods.find((item) => item.id === preview.mood)
                      ?.label
                  }
                </li>
                <li>本地时段：{preview.hour} 点</li>
                <li>
                  音乐陪伴方式：
                  {preview.intent === "lift" ? "提一点精神" : "陪伴此刻"}
                </li>
                <li>
                  音乐偏好：
                  {
                    musicCategories.find(
                      (item) => item.id === preview.preferredCategory,
                    )?.label
                  }
                </li>
                {preview.activeMinutes !== null && (
                  <li>今日活跃时长：{preview.activeMinutes} 分钟</li>
                )}
                {preview.unfinishedTasks !== null && (
                  <li>未完成任务数量：{preview.unfinishedTasks} 项</li>
                )}
              </ul>
              <p>
                {preview.activeMinutes === null
                  ? "本次不发送活动统计或任务信息。"
                  : "仅发送以上汇总数字，不含应用名称和任务内容。"}{" "}
                可在设置中调整摘要分享。
                音乐喜欢/不喜欢记录仅在本机用于排序，不发送给 AI。
              </p>
              <p>
                确认后会访问该服务；每日最多 {preview.maxDailyCalls}{" "}
                次请求，测试连接和重试也计入。相同内容的推荐缓存 15
                分钟，命中缓存时不发起新请求。
              </p>
              <p>生成文本可能按服务商定价收费，本机次数上限不是账单限额。</p>
              <div className="ai-actions">
                <button
                  className="button primary"
                  disabled={aiMusicBusy || encouragementBusy}
                  onClick={askAiForMusic}
                >
                  确认推荐
                </button>
                <button
                  className="button ghost"
                  onClick={() => setPendingAiRequest(undefined)}
                >
                  取消
                </button>
              </div>
            </section>
          )}
          {aiMusicStatus && (
            <p className="ai-music-reason" role="status">
              {aiMusicStatus}
            </p>
          )}
          {search && (
            <p className="search-note">
              正在搜索“{search}”{" "}
              <button
                onClick={() => {
                  setSearch("");
                  setSearchDraft("");
                  discardMusicResults();
                  void playback.recommend({
                    category: playingCategory,
                    context: musicContext,
                  });
                }}
              >
                返回推荐
              </button>
            </p>
          )}
          <SmartMusicPlayer onInteraction={discardMusicResults} />
          <LocalMusicImport onInteraction={discardMusicResults} />
          <MusicFeedbackPanel />
        </article>
        <article className="content-card">
          <Coffee />
          <span>轻松一刻</span>
          <h2>{content.joke}</h2>
        </article>
        <article className="content-card">
          <Sparkles />
          <span>今日微挑战</span>
          <h2>{content.challenge}</h2>
        </article>
      </section>
    </div>
  );
}

function PrivacyPage() {
  const { preferences, updatePreferences } = useAppStore();
  const [location, setLocation] = useState("正在读取本地数据位置…");
  useEffect(() => {
    getDataLocation()
      .then(setLocation)
      .catch(() => setLocation("暂时无法读取数据位置"));
  }, []);
  const toggles = [
    ["trackActivity", "应用活动记录", "统计应用时长及键鼠次数，不记录输入内容"],
    ["trackWindowTitles", "窗口标题记录", "可能包含文件名，默认关闭"],
    ["idleDetection", "空闲状态检测", "离开电脑后不把时间计入应用"],
  ] as const;
  const updateTracking = (
    key: "trackActivity" | "trackWindowTitles" | "idleDetection",
    checked: boolean,
  ) => {
    const next = { ...preferences, [key]: checked };
    updatePreferences({ [key]: checked });
    setNativeTracking(
      next.trackActivity,
      next.trackWindowTitles,
      next.idleDetection,
    ).catch(() => undefined);
  };
  const clearData = async () => {
    if (!window.confirm("确定删除全部活动记录吗？此操作不可撤销。")) return;
    await deleteNativeActivity();
  };
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">数据与隐私</p>
          <h1>你始终拥有控制权。</h1>
          <p>
            DayMate 只统计键鼠次数，不记录具体按键、鼠标位置、聊天或文档正文。
          </p>
        </div>
        <div className="privacy-badge">
          <ShieldCheck />
          本地优先
        </div>
      </header>
      <section className="privacy-layout">
        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">记录控制</p>
              <h2>正在记录什么</h2>
            </div>
            <Database />
          </div>
          <div className="setting-list">
            {toggles.map(([key, title, description]) => (
              <label className="setting-row" key={key}>
                <div>
                  <strong>{title}</strong>
                  <span>{description}</span>
                </div>
                <input
                  type="checkbox"
                  checked={preferences[key]}
                  onChange={(event) =>
                    updateTracking(key, event.target.checked)
                  }
                />
              </label>
            ))}
          </div>
          <p className="data-path">数据位置：{location}</p>
        </article>
        <article className="card promise">
          <p className="eyebrow">明确不会做</p>
          <h2>边界比功能更重要</h2>
          <ul>
            <li>
              <Check />
              不记录键盘输入内容
            </li>
            <li>
              <Check />
              不截取或分析屏幕
            </li>
            <li>
              <Check />
              不读取聊天与文档正文
            </li>
            <li>
              <Check />
              不默认上传活动数据
            </li>
            <li>
              <Check />
              不把 API Key 写入普通日志
            </li>
          </ul>
        </article>
      </section>
      <section className="danger-zone">
        <div>
          <strong>清理活动数据</strong>
          <span>任务和个人设置不会被删除。此操作需要二次确认。</span>
        </div>
        <button className="button danger" onClick={clearData}>
          清空活动数据
        </button>
      </section>
    </div>
  );
}

export function SettingsPage() {
  const desktop = isTauri();
  const { preferences, updatePreferences } = useAppStore();
  const [apiKey, setApiKey] = useState("");
  const [keyState, setKeyState] = useState({
    provider: "",
    baseUrl: "",
    saved: false,
    usable: false,
    checked: false,
  });
  const [aiStatus, setAiStatus] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiUsage, setAiUsage] = useState<AiUsage>();
  const [modelList, setModelList] = useState<
    AiModelList & { provider: string; baseUrl: string }
  >();
  const [modelQuery, setModelQuery] = useState("");
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelStatus, setModelStatus] = useState("");
  const aiSettingsVersion = useRef(0);
  const aiSettingsRunning = useRef(false);
  const [systemStatus, setSystemStatus] =
    useState<Awaited<ReturnType<typeof getSystemIntegrationStatus>>>();
  const [systemMessage, setSystemMessage] = useState("");
  const [systemBusy, setSystemBusy] = useState(false);
  const systemRequestRunning = useRef(false);
  const theme = getDailyTheme(new Date(), preferences.backgroundOffset);
  const provider = findAiProvider(preferences.aiProvider);
  const currentKeyState =
    keyState.provider === provider.id &&
    keyState.baseUrl === preferences.aiBaseUrl;
  const keySaved = currentKeyState && keyState.saved;
  const keyUsable = currentKeyState && keyState.usable;
  const keyChecked = currentKeyState && keyState.checked;
  const currentModelList =
    modelList?.provider === provider.id &&
    modelList.baseUrl === preferences.aiBaseUrl
      ? modelList
      : undefined;
  const visibleModels = filterAiModels(
    currentModelList?.models ?? [],
    modelQuery,
  );
  useEffect(() => {
    const version = ++aiSettingsVersion.current;
    getAiKeyStatus(preferences.aiProvider, preferences.aiBaseUrl)
      .then((status) => {
        if (version === aiSettingsVersion.current) {
          setKeyState({
            provider: preferences.aiProvider,
            baseUrl: preferences.aiBaseUrl,
            saved: status.saved,
            usable: status.usable,
            checked: true,
          });
          setAiStatus(status.message);
        }
      })
      .catch(() => {
        if (version === aiSettingsVersion.current) {
          setKeyState({
            provider: preferences.aiProvider,
            baseUrl: preferences.aiBaseUrl,
            saved: false,
            usable: false,
            checked: true,
          });
          setAiStatus("暂时无法读取系统凭据，请重新选择服务商后重试。");
        }
      });
    return () => {
      aiSettingsVersion.current += 1;
    };
  }, [preferences.aiProvider, preferences.aiBaseUrl]);
  useEffect(() => {
    let active = true;
    getAiUsage()
      .then((usage) => {
        if (active) setAiUsage(usage);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    getSystemIntegrationStatus()
      .then((status) => {
        if (!active) return;
        setSystemStatus(status);
        updatePreferences({ autostart: status.autostartEnabled });
      })
      .catch(() => {
        if (active)
          setSystemMessage("暂时无法读取系统设置，请重新打开设置页重试。");
      });
    return () => {
      active = false;
    };
  }, [desktop, updatePreferences]);
  const updateAutostart = async (enabled: boolean) => {
    if (systemRequestRunning.current) return;
    systemRequestRunning.current = true;
    setSystemBusy(true);
    setSystemMessage("");
    try {
      const actual = await setSystemAutostart(enabled);
      setSystemStatus(
        (current) => current && { ...current, autostartEnabled: actual },
      );
      updatePreferences({ autostart: actual });
      setSystemMessage(
        actual ? "已开启 Windows 登录后启动 DayMate。" : "已关闭开机自动启动。",
      );
    } catch (error) {
      setSystemMessage(String(error));
    } finally {
      systemRequestRunning.current = false;
      setSystemBusy(false);
    }
  };
  const testNotification = async () => {
    if (systemRequestRunning.current || !preferences.notifications) return;
    systemRequestRunning.current = true;
    setSystemBusy(true);
    setSystemMessage("");
    try {
      await sendTestNotification();
      const status = await getSystemIntegrationStatus();
      setSystemStatus(status);
      setSystemMessage(
        "测试通知已交给 Windows。若没有弹出，请检查系统通知和勿扰设置。",
      );
    } catch (error) {
      setSystemMessage(String(error));
    } finally {
      systemRequestRunning.current = false;
      setSystemBusy(false);
    }
  };
  const updateFloatingBall = (enabled: boolean) => {
    updatePreferences({ floatingBall: enabled });
    if (!enabled) hideCompanion().catch(() => undefined);
  };
  const selectProvider = (id: string) => {
    const next = findAiProvider(id);
    const profile = preferences.aiProfiles[next.id] ?? next;
    aiSettingsVersion.current += 1;
    aiSettingsRunning.current = false;
    setAiBusy(false);
    setApiKey("");
    setAiStatus("");
    setModelList(undefined);
    setModelStatus("");
    setModelQuery("");
    setModelsBusy(false);
    setKeyState({
      provider: next.id,
      baseUrl: profile.baseUrl,
      saved: false,
      usable: false,
      checked: false,
    });
    updatePreferences({
      aiProvider: next.id,
    });
  };
  const fetchModels = async () => {
    if (
      aiSettingsRunning.current ||
      (provider.needsKey && (!keyChecked || !keyUsable))
    )
      return;
    aiSettingsRunning.current = true;
    const version = ++aiSettingsVersion.current;
    setAiBusy(true);
    setModelsBusy(true);
    setModelStatus("");
    try {
      const result = normalizeAiModels(
        await listAiModels(
          provider.id,
          preferences.aiBaseUrl,
          provider.needsKey,
          preferences.aiMaxDailyCalls,
        ),
      );
      if (version !== aiSettingsVersion.current) return;
      setModelList({
        ...result,
        provider: provider.id,
        baseUrl: preferences.aiBaseUrl,
      });
      setModelQuery("");
      setModelStatus(
        result.models.length
          ? `${result.source === "cache" ? "近期缓存" : "已获取"}：${result.models.length} 个模型。请选择聊天模型，不会自动替你更改或调用。`
          : "这个接口未返回模型目录，可以继续手动填写聊天模型名称。",
      );
    } catch (error) {
      if (version === aiSettingsVersion.current)
        setModelStatus(`${String(error)} 可手动填写模型名称后测试连接。`);
    } finally {
      const usage = await getAiUsage().catch(() => undefined);
      if (version === aiSettingsVersion.current) {
        if (usage) setAiUsage(usage);
        aiSettingsRunning.current = false;
        setAiBusy(false);
        setModelsBusy(false);
      }
    }
  };
  const storeKey = async () => {
    if (aiSettingsRunning.current || !apiKey.trim()) return;
    aiSettingsRunning.current = true;
    const version = ++aiSettingsVersion.current;
    setAiBusy(true);
    setAiStatus("");
    try {
      await saveAiKey(provider.id, preferences.aiBaseUrl, apiKey);
      if (version !== aiSettingsVersion.current) return;
      setKeyState({
        provider: provider.id,
        baseUrl: preferences.aiBaseUrl,
        saved: true,
        usable: true,
        checked: true,
      });
      setApiKey("");
      setModelList(undefined);
      setModelStatus("");
      setAiStatus(
        "API Key 已安全保存到 Windows 凭据管理器，并绑定当前接口地址。",
      );
    } catch (error) {
      if (version === aiSettingsVersion.current) setAiStatus(String(error));
    } finally {
      if (version === aiSettingsVersion.current) {
        aiSettingsRunning.current = false;
        setAiBusy(false);
      }
    }
  };
  const testConnection = async () => {
    if (aiSettingsRunning.current) return;
    aiSettingsRunning.current = true;
    const version = ++aiSettingsVersion.current;
    setAiBusy(true);
    setAiStatus("正在测试连接…");
    try {
      const status = await testAiConnection(
        provider.id,
        preferences.aiBaseUrl,
        preferences.aiModel,
        provider.needsKey,
        preferences.aiMaxDailyCalls,
      );
      if (version === aiSettingsVersion.current) setAiStatus(status);
    } catch (error) {
      if (version === aiSettingsVersion.current) setAiStatus(String(error));
    } finally {
      const usage = await getAiUsage().catch(() => undefined);
      if (version === aiSettingsVersion.current) {
        if (usage) setAiUsage(usage);
        aiSettingsRunning.current = false;
        setAiBusy(false);
      }
    }
  };
  const removeKey = async () => {
    if (aiSettingsRunning.current) return;
    aiSettingsRunning.current = true;
    const version = ++aiSettingsVersion.current;
    setAiBusy(true);
    setAiStatus("");
    try {
      await deleteAiKey(provider.id);
      if (version === aiSettingsVersion.current) {
        setKeyState({
          provider: provider.id,
          baseUrl: preferences.aiBaseUrl,
          saved: false,
          usable: false,
          checked: true,
        });
        setApiKey("");
        setModelList(undefined);
        setModelStatus("");
        setAiStatus("已删除该服务商的本地密钥。");
      }
    } catch (error) {
      if (version === aiSettingsVersion.current) setAiStatus(String(error));
    } finally {
      if (version === aiSettingsVersion.current) {
        aiSettingsRunning.current = false;
        setAiBusy(false);
      }
    }
  };
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">设置</p>
          <h1>把陪伴调成你舒服的样子。</h1>
          <p>普通设置保存在本机，API Key 单独保存在系统凭据管理器。</p>
        </div>
      </header>
      <section className="settings-card">
        <h2>通用</h2>
        <label className="setting-row">
          <div>
            <strong>昵称</strong>
            <span>用于每天的问候</span>
          </div>
          <input
            className="compact-input"
            value={preferences.nickname}
            onChange={(event) =>
              updatePreferences({ nickname: event.target.value })
            }
          />
        </label>
        <label className="setting-row">
          <div>
            <strong>主题</strong>
            <span>跟随系统或手动指定</span>
          </div>
          <select
            value={preferences.theme}
            onChange={(event) =>
              updatePreferences({
                theme: event.target.value as typeof preferences.theme,
              })
            }
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <div className="setting-row">
          <div>
            <strong>每日舒适背景</strong>
            <span>
              {theme.name} · {theme.mood}
            </span>
          </div>
          <div className="theme-control">
            <i
              style={{
                background: `linear-gradient(135deg, ${theme.glowA}, ${theme.glowB})`,
              }}
            />
            <button
              className="button secondary"
              onClick={() =>
                updatePreferences({
                  backgroundOffset: preferences.backgroundOffset + 1,
                })
              }
            >
              <Palette />
              换一个
            </button>
          </div>
        </div>
        <label className="setting-row">
          <div>
            <strong>音乐偏好</strong>
            <span>首页和每日内容会优先按这个类别推荐</span>
          </div>
          <select
            value={preferences.musicCategory}
            onChange={(event) =>
              updatePreferences({
                musicCategory: event.target.value as MusicCategory,
              })
            }
          >
            {musicCategories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="setting-row">
          <div>
            <strong>陪伴语气</strong>
            <span>用于独立生成的一句鼓励</span>
          </div>
          <select
            value={preferences.tone}
            onChange={(event) =>
              updatePreferences({
                tone: event.target.value as typeof preferences.tone,
              })
            }
          >
            {Object.entries(companionTones).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="setting-row">
          <div>
            <strong>智能音乐源</strong>
            <span>平台允许流播的曲目 + CC0 离线曲库，应用内直接播放</span>
          </div>
          <strong className="setting-value">Audius + CC0 离线曲库</strong>
        </label>
      </section>
      <section className="settings-card ai-settings">
        <h2>AI 服务</h2>
        <label className="setting-row">
          <div>
            <strong>启用 AI 增强</strong>
            <span>基础统计、音乐和每日背景不依赖 AI</span>
          </div>
          <input
            type="checkbox"
            checked={preferences.aiEnabled}
            onChange={(event) =>
              updatePreferences({ aiEnabled: event.target.checked })
            }
          />
        </label>
        <label className="setting-row">
          <div>
            <strong>向 AI 分享使用摘要</strong>
            <span>
              仅分享今日活跃分钟和未完成任务数量；每次推荐前可查看并确认
            </span>
          </div>
          <input
            type="checkbox"
            checked={preferences.aiShareActivitySummary}
            onChange={(event) =>
              updatePreferences({
                aiShareActivitySummary: event.target.checked,
              })
            }
          />
        </label>
        <label className="setting-row">
          <div>
            <strong>每日 AI 请求上限</strong>
            <span>
              1–100
              次，所有服务共用。获取模型、连接测试、失败和重试计入，缓存命中不计入
            </span>
          </div>
          <input
            className="compact-input"
            type="number"
            min={1}
            max={100}
            step={1}
            value={preferences.aiMaxDailyCalls}
            onChange={(event) =>
              updatePreferences({ aiMaxDailyCalls: Number(event.target.value) })
            }
          />
        </label>
        <p className="ai-usage" role="status">
          {aiUsage
            ? `今日已发起 ${aiUsage.calls} / ${preferences.aiMaxDailyCalls} 次请求`
            : "今日请求次数暂时无法读取"}
        </p>
        <div className="ai-form">
          <label>
            服务商
            <select
              value={preferences.aiProvider}
              onChange={(event) => selectProvider(event.target.value)}
            >
              {aiProviders.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Base URL
            <input
              value={preferences.aiBaseUrl}
              maxLength={2048}
              disabled={aiBusy}
              onChange={(event) => {
                const nextUrl = aiProfileText(
                  event.target.value,
                  preferences.aiBaseUrl,
                  "baseUrl",
                );
                if (nextUrl !== event.target.value.trim()) {
                  setAiStatus(
                    "接口地址不能包含密钥、用户名密码、查询参数或片段，请只填写服务商的基础地址。",
                  );
                  return;
                }
                if (nextUrl === preferences.aiBaseUrl) return;
                aiSettingsVersion.current += 1;
                setApiKey("");
                setModelList(undefined);
                setModelStatus("");
                updatePreferences({ aiBaseUrl: nextUrl });
              }}
              placeholder="https://example.com/v1"
            />
          </label>
          <p className="ai-test-note">
            每个服务商分别记住接口地址和模型名称；切换回来无需重填，密钥始终独立保存在系统凭据中。
          </p>
          {(provider.id === "siliconflow" || provider.id === "zhipu") && (
            <p className="ai-test-note">
              硅基流动上的 GLM
              是该平台托管的模型，不等于智谱官方服务；请使用所选平台签发的 API
              Key，不能互用。
            </p>
          )}
          {provider.needsKey && (
            <label className="ai-key-field">
              API Key
              <div className="key-input">
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  maxLength={2048}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={
                    keySaved
                      ? "已安全保存；输入新值可覆盖"
                      : "仅保存到 Windows 凭据管理器"
                  }
                />
                <button
                  className="button secondary"
                  disabled={!apiKey.trim() || aiBusy || !keyChecked}
                  onClick={storeKey}
                >
                  保存密钥
                </button>
              </div>
            </label>
          )}
          {provider.needsKey && (
            <p className="ai-test-note">
              保存密钥即确认仅用于当前接口：
              {preferences.aiBaseUrl || "请先填写 Base URL"}。
              修改接口地址后需重新输入并保存密钥，已有密钥不会自动转发到新地址。
            </p>
          )}
          <label className="ai-model-input">
            模型名称
            <input
              value={preferences.aiModel}
              disabled={aiBusy}
              maxLength={200}
              onChange={(event) => {
                setAiStatus("");
                updatePreferences({ aiModel: event.target.value });
              }}
              placeholder="可手动填写聊天模型名称"
            />
          </label>
          <div className="ai-model-fetch">
            <button
              className="button secondary"
              disabled={
                aiBusy ||
                !preferences.aiBaseUrl.trim() ||
                (provider.needsKey && (!keyChecked || !keyUsable))
              }
              onClick={fetchModels}
            >
              {modelsBusy ? "正在获取模型…" : "获取模型"}
            </button>
          </div>
          <p className="ai-test-note">
            点击才获取模型目录，不发送聊天内容，计入本机请求次数。不自动选择模型；目录可见不代表免费或已开通权限，实际价格和访问权限以该平台为准。
          </p>
          <p className="ai-test-note">
            请选择文本聊天模型。图像生成模型不能用于音乐类别推荐或鼓励；
            {provider.id === "sensenova"
              ? "例如 sensenova-6.8-flash-lite 是文本模型，sensenova-u1 系列用于图像。"
              : "无法识别或不支持目录的接口仍可手动填写后测试。"}
          </p>
          {currentModelList && currentModelList.models.length > 0 && (
            <>
              <label>
                筛选模型
                <input
                  value={modelQuery}
                  maxLength={200}
                  onChange={(event) => setModelQuery(event.target.value)}
                  placeholder="输入模型名称的一部分"
                />
              </label>
              <label>
                选择目录模型
                <select
                  value=""
                  disabled={aiBusy}
                  onChange={(event) => {
                    const selected = event.target.value;
                    if (
                      currentModelList.models.includes(selected) &&
                      !isImageGenerationModel(selected)
                    ) {
                      setAiStatus("");
                      updatePreferences({ aiModel: selected });
                    }
                  }}
                >
                  <option value="">
                    {visibleModels.length
                      ? `找到 ${visibleModels.length} 个，请手动选择`
                      : "没有匹配的模型，请调整筛选"}
                  </option>
                  {visibleModels.map((model) => (
                    <option
                      key={model}
                      value={model}
                      disabled={isImageGenerationModel(model)}
                    >
                      {model}
                      {isImageGenerationModel(model)
                        ? "（图像生成，不用于聊天）"
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {modelStatus && (
            <p className="ai-status" role="status">
              {modelStatus}
            </p>
          )}
          {isImageGenerationModel(preferences.aiModel) && (
            <p className="ai-status" role="alert">
              当前名称属于图像生成模型，请改为文本聊天模型后再测试或使用 AI
              陪伴。
            </p>
          )}
          <div className="ai-actions">
            <button
              className="button primary"
              disabled={
                aiBusy ||
                !preferences.aiModel.trim() ||
                isImageGenerationModel(preferences.aiModel) ||
                (provider.needsKey && (!keyChecked || !keyUsable))
              }
              onClick={testConnection}
            >
              测试连接
            </button>
            {keySaved && (
              <button
                className="button ghost"
                disabled={aiBusy}
                onClick={removeKey}
              >
                删除密钥
              </button>
            )}
            <span>
              {provider.needsKey
                ? keyUsable
                  ? "密钥已配置"
                  : keySaved
                    ? "密钥已保存，但当前接口未获授权"
                    : keyChecked
                      ? "尚未配置密钥"
                      : "正在读取密钥状态…"
                : "本机服务无需密钥"}
            </span>
          </div>
          <p className="ai-test-note">
            测试连接会向所选服务发送固定测试语句，并计入每日请求次数，不含活动或任务数据。
            文本调用可能按服务商定价收费，本机次数上限不是账单限额。
          </p>
          {aiStatus && (
            <p className="ai-status" role="status">
              {aiStatus}
            </p>
          )}
        </div>
      </section>
      <section className="settings-card">
        <h2>启动与通知</h2>
        <label className="setting-row">
          <div>
            <strong>开机自动启动</strong>
            <span>Windows 登录后启动，开关显示系统实际状态</span>
          </div>
          <input
            type="checkbox"
            checked={systemStatus?.autostartEnabled ?? false}
            disabled={!systemStatus || systemBusy}
            onChange={(event) => updateAutostart(event.target.checked)}
          />
        </label>
        <label className="setting-row">
          <div>
            <strong>桌面通知</strong>
            <span>专注结束时温和提醒，可发送测试检查系统状态</span>
          </div>
          <input
            type="checkbox"
            checked={preferences.notifications}
            onChange={(event) =>
              updatePreferences({ notifications: event.target.checked })
            }
          />
        </label>
        <div className="setting-row">
          <div>
            <strong>系统通知状态</strong>
            <span>
              {desktop
                ? (systemStatus?.notificationStatusNote ?? "正在读取系统状态…")
                : "系统集成仅在桌面版可用"}
            </span>
          </div>
          <button
            className="button secondary"
            disabled={!preferences.notifications || systemBusy || !systemStatus}
            onClick={testNotification}
          >
            发送测试通知
          </button>
        </div>
        {systemMessage && (
          <p className="ai-status" role="status">
            {systemMessage}
          </p>
        )}
        <label className="setting-row">
          <div>
            <strong>桌面浮动球</strong>
            <span>关闭主窗口后保留一个可拖动的快捷入口</span>
          </div>
          <input
            type="checkbox"
            checked={preferences.floatingBall}
            onChange={(event) => updateFloatingBall(event.target.checked)}
          />
        </label>
      </section>
      <section className="settings-card about">
        <div className="brand-mark">日</div>
        <div>
          <strong>DayMate 日伴</strong>
          <span>版本 {appVersion} · 本地优先桌面陪伴应用</span>
        </div>
        <div className="about-links">
          <a
            href="https://github.com/wei9719/daymate-desktop"
            target="_blank"
            rel="noopener noreferrer"
            className="button secondary"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            GitHub 仓库
          </a>
          <span className="about-license">MIT 开源协议</span>
        </div>
      </section>
    </div>
  );
}

function CompanionBall() {
  const openingRef = useRef(false);
  const [musicPlaying, setMusicPlaying] = useState(
    localStorage.getItem(musicStateKey) === "true",
  );
  useEffect(() => {
    document.documentElement.classList.add("companion-mode");
    return () => document.documentElement.classList.remove("companion-mode");
  }, []);
  useEffect(() => {
    const unlisten = listen<{ playing: boolean }>("music-state", (event) => {
      setMusicPlaying(event.payload.playing);
    });
    const syncStorage = (event: StorageEvent) => {
      if (event.key === musicStateKey)
        setMusicPlaying(event.newValue === "true");
    };
    window.addEventListener("storage", syncStorage);
    return () => {
      unlisten.then((dispose) => dispose()).catch(() => undefined);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    showCompanionMenu().catch(() => undefined);
  }, []);

  const handleOpen = useCallback(() => {
    if (openingRef.current) return;
    openingRef.current = true;
    showMainWindow()
      .catch(() => undefined)
      .finally(() => {
        window.setTimeout(() => {
          openingRef.current = false;
        }, 500);
      });
  }, []);

  return (
    <main
      className="companion-shell"
      aria-label="DayMate 桌面浮动球"
      onContextMenu={(event) => event.preventDefault()}
      onMouseDown={(event) => {
        if (event.button === 2) handleContextMenu(event);
      }}
    >
      <button
        className="companion-drag"
        onMouseDown={(event) => {
          if (event.button === 0)
            startCompanionDragging().catch(() => undefined);
        }}
        aria-label="拖动浮动球"
      >
        <GripHorizontal size={18} />
      </button>
      <button
        className={`companion-ball ${musicPlaying ? "music-playing" : ""}`}
        onClick={handleOpen}
        aria-label="打开 DayMate"
      >
        {musicPlaying ? (
          <span className="companion-equalizer" aria-label="音乐正在播放">
            <b />
            <b />
            <b />
            <b />
          </span>
        ) : (
          <span>日</span>
        )}
        <i />
      </button>
    </main>
  );
}

export default function App() {
  const desktop = isTauri();
  const windowLabel = desktop ? getCurrentWindow().label : "main";
  const onboarded = useAppStore((state) => state.onboarded);
  const theme = useAppStore((state) => state.preferences.theme);
  const backgroundOffset = useAppStore(
    (state) => state.preferences.backgroundOffset,
  );
  const floatingBall = useAppStore((state) => state.preferences.floatingBall);
  const trackActivity = useAppStore((state) => state.preferences.trackActivity);
  const trackWindowTitles = useAppStore(
    (state) => state.preferences.trackWindowTitles,
  );
  const idleDetection = useAppStore((state) => state.preferences.idleDetection);
  const [page, setPage] = useState<Page>("today");
  const [adding, setAdding] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [focusSaveError, setFocusSaveError] = useState("");
  const { session: focusSession, error: focusError } = useFocusClock(
    windowLabel === "main",
  );
  const startFocus = useCallback((task: Task) => {
    const current = useFocusStore.getState().session;
    if (
      current &&
      current.status !== "completed" &&
      current.taskId !== task.id &&
      !window.confirm("已有一段专注尚未结束。结束它并开始这个任务吗？")
    )
      return;
    try {
      useFocusStore.getState().start(task);
      setFocusSaveError("");
      setFocusOpen(true);
    } catch {
      setFocusSaveError("专注状态未能保存，请检查本地可用空间后重试。");
    }
  }, []);
  const focusTask = focusSession
    ? (useAppStore
        .getState()
        .tasks.find((task) => task.id === focusSession.taskId) ?? {
        id: focusSession.taskId,
        title: focusSession.taskTitle,
        estimatedMinutes: focusSession.durationSeconds / 60,
        priority: "medium" as const,
        completed: true,
        createdAt: "",
      })
    : undefined;
  const [activitySaveError, setActivitySaveError] = useState("");
  const startupHandled = useRef(false);
  useEffect(() => {
    if (!desktop || windowLabel !== "main") return;
    const unlisten = listen<string>("activity-save-error", (event) =>
      setActivitySaveError(event.payload),
    );
    return () => {
      unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, [desktop, windowLabel]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const dailyTheme = getDailyTheme(new Date(), backgroundOffset);
    const root = document.documentElement.style;
    root.setProperty("--daily-base", dailyTheme.base);
    root.setProperty("--daily-glow-a", dailyTheme.glowA);
    root.setProperty("--daily-glow-b", dailyTheme.glowB);
    root.setProperty("--primary", dailyTheme.accent);
  }, [backgroundOffset]);
  useEffect(() => {
    if (!desktop || windowLabel !== "main") return;
    const current = getCurrentWindow();
    const unlisten = current.onCloseRequested(async (event) => {
      event.preventDefault();
      if (floatingBall) await hideMainToCompanion();
      else await current.hide();
    });
    return () => {
      unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, [desktop, floatingBall, windowLabel]);
  useEffect(() => {
    if (!desktop || windowLabel !== "main") return;
    setNativeTracking(
      onboarded && trackActivity,
      onboarded && trackWindowTitles,
      idleDetection,
    ).catch(() => undefined);
  }, [
    desktop,
    idleDetection,
    onboarded,
    trackActivity,
    trackWindowTitles,
    windowLabel,
  ]);
  useEffect(() => {
    if (
      !desktop ||
      windowLabel !== "main" ||
      !onboarded ||
      startupHandled.current
    )
      return;
    startupHandled.current = true;
    getSystemIntegrationStatus()
      .then(async (status) => {
        if (!status.autostartLaunch) return;
        if (useAppStore.getState().preferences.floatingBall)
          await hideMainToCompanion();
        else await getCurrentWindow().hide();
      })
      .catch(() => undefined);
  }, [desktop, onboarded, windowLabel]);
  const body = useMemo(() => {
    if (page === "today")
      return (
        <Dashboard
          onAdd={() => setAdding(true)}
          onFocus={startFocus}
          setPage={setPage}
        />
      );
    if (page === "tasks")
      return <TasksPage onAdd={() => setAdding(true)} onFocus={startFocus} />;
    if (page === "review") return <ReviewPage />;
    if (page === "content") return <ContentPage />;
    if (page === "privacy") return <PrivacyPage />;
    return <SettingsPage />;
  }, [page, startFocus]);
  if (windowLabel === "companion") return <CompanionBall />;
  if (!onboarded) return <Onboarding />;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">日</div>
          <div>
            <strong>DayMate</strong>
            <span>日伴</span>
          </div>
        </div>
        <nav>
          {navItems.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <Sparkles size={17} />
          <p>
            不用准备好才开始。
            <br />
            开始以后，会慢慢准备好的。
          </p>
        </div>
        {floatingBall && (
          <button
            className="collapse-button"
            disabled={!desktop}
            title={desktop ? "收起为浮球" : "悬浮球仅在桌面版中可用"}
            onClick={() => hideMainToCompanion().catch(() => undefined)}
          >
            <Minimize2 size={16} />
            收起为浮球
          </button>
        )}
      </aside>
      <main className="main-content">
        {activitySaveError && (
          <p role="alert">
            {activitySaveError}
            。记录仍保留在内存中，请检查数据目录后再次从托盘退出。
          </p>
        )}
        {(focusError || focusSaveError) && (
          <p role="alert">{focusError || focusSaveError}</p>
        )}
        {focusSession && !focusOpen && (
          <button
            className="button secondary"
            onClick={() => setFocusOpen(true)}
          >
            {focusSession.status === "completed"
              ? "查看专注结果"
              : focusSession.status === "paused"
                ? "返回已暂停的专注"
                : "返回正在进行的专注"}{" "}
            · {focusSession.taskTitle}
          </button>
        )}
        {body}
      </main>
      {adding && <AddTaskModal onClose={() => setAdding(false)} />}
      {focusOpen && focusTask && (
        <FocusModal task={focusTask} onClose={() => setFocusOpen(false)} />
      )}
    </div>
  );
}
