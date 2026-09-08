import { describe, expect, it } from "vitest";
import { getDailyTheme } from "./dailyTheme";

describe("daily theme", () => {
  it("stays stable during the same day", () => {
    expect(getDailyTheme(new Date(2026, 6, 14))).toEqual(
      getDailyTheme(new Date(2026, 6, 14, 23, 59)),
    );
  });

  it("can be changed manually", () => {
    expect(getDailyTheme(new Date(2026, 6, 14), 1).name).not.toBe(
      getDailyTheme(new Date(2026, 6, 14)).name,
    );
  });
});
