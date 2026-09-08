export function normalizeAiDailyLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(1, Math.trunc(value)))
    : 20;
}
