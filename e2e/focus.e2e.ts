import { test, expect } from "@playwright/test";

test("专注收起、暂停、重载与截止时刻恢复（真实浏览器分支）", async ({
  page,
}, testInfo) => {
  testInfo.annotations.push({
    type: "scope",
    description:
      "GitHub-only browser preview, fictional local state and empty mocked music directory. No native bridge, installed application, production data or external API.",
  });
  const pageErrors: string[] = [];
  const unexpectedRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4173") return route.continue();
    if (
      url.origin === "https://api.audius.co" &&
      url.pathname === "/v1/tracks/search"
    ) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: '{"data":[]}',
      });
    }
    unexpectedRequests.push(`${url.origin}${url.pathname}`);
    return route.abort("blockedbyclient");
  });
  await page.addInitScript(() => {
    if (localStorage.getItem("daymate-state-v1")) return;
    localStorage.setItem(
      "daymate-state-v1",
      JSON.stringify({
        version: 0,
        state: {
          onboarded: true,
          tasks: [
            {
              id: "cloud-focus-task",
              title: "云端专注演示",
              estimatedMinutes: 5,
              priority: "medium",
              completed: false,
              createdAt: "2026-09-12T02:00:00Z",
            },
          ],
          preferences: {
            nickname: "云端演示",
            aiEnabled: false,
            trackActivity: false,
            trackWindowTitles: false,
            notifications: false,
            autostart: false,
            musicAutoplay: false,
          },
        },
      }),
    );
  });
  await page.clock.install({ time: new Date("2026-09-12T02:00:00Z") });
  await page.goto("/");
  await page.clock.pauseAt(new Date("2026-09-12T02:01:00Z"));
  await page.getByRole("button", { name: "开始", exact: true }).click();
  await expect(page.locator(".timer-ring strong")).toHaveText("05:00");
  await page.clock.fastForward(60_000);
  await expect(page.locator(".timer-ring strong")).toHaveText("04:00");

  await page
    .getByRole("button", { name: "收起专注，保留计时", exact: true })
    .click();
  await expect(page.locator(".focus-overlay")).toHaveCount(0);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "任务", exact: true })
    .click();
  await page.clock.fastForward(30_000);
  await page.getByRole("button", { name: /返回正在进行的专注/ }).click();
  await expect(page.locator(".timer-ring strong")).toHaveText("03:30");
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await page.clock.fastForward(600_000);
  await expect(page.locator(".timer-ring strong")).toHaveText("03:30");

  await page.reload();
  await page.getByRole("button", { name: /返回已暂停的专注/ }).click();
  await expect(page.locator(".timer-ring strong")).toHaveText("03:30");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.clock.fastForward(210_000);
  await expect(
    page.getByText("这一段专注完成了", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".timer-ring strong")).toHaveText("00:00");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("daymate-state-v1")!).state.tasks[0]
          .completed,
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "完成任务", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("daymate-state-v1")!).state.tasks[0]
          .completed,
    ),
  ).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(unexpectedRequests).toEqual([]);
});
