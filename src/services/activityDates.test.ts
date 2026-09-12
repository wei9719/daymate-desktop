import { describe, expect, it } from "vitest";
import { localDateKey, yesterdayDateKey } from "./activityDates";

describe("本地回顾日期", () => {
  it("使用本地年月日，支持跨月和跨年", () => {
    expect(localDateKey(new Date(2026, 8, 12, 0, 1))).toBe("2026-09-12");
    expect(yesterdayDateKey(new Date(2026, 0, 1, 0, 1))).toBe("2025-12-31");
    expect(yesterdayDateKey(new Date(2024, 2, 1))).toBe("2024-02-29");
  });
});
