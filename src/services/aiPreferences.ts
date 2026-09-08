import type { AiProfile } from "../types";
import { aiProviders } from "./aiProviders";

export function normalizeAiDailyLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(1, Math.trunc(value)))
    : 20;
}

export function aiProfileText(
  value: unknown,
  fallback: string,
  field: keyof AiProfile,
) {
  if (typeof value !== "string") return fallback;
  const result = value.trim();
  if (
    result.length > (field === "baseUrl" ? 2048 : 200) ||
    Array.from(result).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    /^(sk-|Bearer\s)/i.test(result)
  )
    return fallback;
  // Interface URLs never need embedded credentials, query keys or fragments.
  // Keep incomplete URL drafts editable; the native boundary validates on use.
  if (field === "baseUrl" && /[@?#]/.test(result)) return fallback;
  return result;
}

export function restoreAiProfiles(
  value: unknown,
  defaults: Record<string, AiProfile> = {},
) {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const profiles: Record<string, AiProfile> = {};
  for (const provider of aiProviders) {
    const candidate = Object.prototype.hasOwnProperty.call(record, provider.id)
      ? record[provider.id]
      : undefined;
    const saved =
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>)
        : undefined;
    const fallback = defaults[provider.id];
    if (!saved && !fallback) continue;
    profiles[provider.id] = {
      baseUrl: aiProfileText(
        saved?.baseUrl,
        fallback?.baseUrl ?? provider.baseUrl,
        "baseUrl",
      ),
      model: aiProfileText(
        saved?.model,
        fallback?.model ?? provider.model,
        "model",
      ),
    };
  }
  return profiles;
}
