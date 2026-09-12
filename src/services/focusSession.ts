import type { Task } from "../types";
import { asRecord, createTaskId, validTaskMinutes } from "./persistedState";

export interface FocusSession {
  id: string;
  taskId: string;
  taskTitle: string;
  durationSeconds: number;
  remainingSeconds: number;
  deadlineMs?: number;
  status: "running" | "paused" | "completed";
  notificationClaimed: boolean;
}

export function startFocusSession(task: Task, now = Date.now()): FocusSession {
  const durationSeconds = Math.ceil(
    validTaskMinutes(task.estimatedMinutes) * 60,
  );
  return {
    id: createTaskId(),
    taskId: task.id,
    taskTitle: task.title,
    durationSeconds,
    remainingSeconds: durationSeconds,
    deadlineMs: now + durationSeconds * 1000,
    status: "running",
    notificationClaimed: false,
  };
}

export function remainingFocusSeconds(session: FocusSession, now = Date.now()) {
  if (session.status === "completed") return 0;
  if (session.status === "paused") return session.remainingSeconds;
  return Math.min(
    session.durationSeconds,
    Math.max(0, Math.ceil(((session.deadlineMs ?? now) - now) / 1000)),
  );
}

export function restoreFocusSession(value: unknown): FocusSession | undefined {
  const row = asRecord(value);
  if (!row || !["running", "paused", "completed"].includes(String(row.status)))
    return;
  if (
    ["id", "taskId", "taskTitle"].some(
      (key) => typeof row[key] !== "string" || !(row[key] as string).trim(),
    )
  )
    return;
  if (
    typeof row.durationSeconds !== "number" ||
    !Number.isInteger(row.durationSeconds) ||
    row.durationSeconds < 1 ||
    row.durationSeconds > 86400 ||
    typeof row.remainingSeconds !== "number" ||
    !Number.isInteger(row.remainingSeconds) ||
    row.remainingSeconds < 0 ||
    row.remainingSeconds > row.durationSeconds
  )
    return;
  if (
    row.status === "running" &&
    (typeof row.deadlineMs !== "number" ||
      !Number.isSafeInteger(row.deadlineMs) ||
      row.deadlineMs < 0 ||
      row.deadlineMs > 8.64e15)
  )
    return;
  return {
    id: (row.id as string).slice(0, 128),
    taskId: (row.taskId as string).slice(0, 128),
    taskTitle: (row.taskTitle as string).slice(0, 1000),
    durationSeconds: row.durationSeconds,
    remainingSeconds: row.remainingSeconds,
    deadlineMs:
      row.status === "running" ? (row.deadlineMs as number) : undefined,
    status: row.status as FocusSession["status"],
    notificationClaimed: row.notificationClaimed === true,
  };
}
