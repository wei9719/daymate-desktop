import { test, expect, type Page } from "@playwright/test";

const checks = new WeakMap<
  Page,
  {
    consoleErrors: string[];
    pageErrors: string[];
    blockedRequests: string[];
  }
>();

test.beforeEach(async ({ page }, testInfo) => {
  const errors = {
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    blockedRequests: [] as string[],
  };
  checks.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => errors.pageErrors.push(error.message));
  testInfo.annotations.push({
    type: "scope",
    description:
      "GitHub Chromium browser preview with fictional local state and mocked Audius search/audio. No keys, real AI, real music playback or Tauri IPC.",
  });

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
        body: JSON.stringify({
          data: Array.from({ length: 40 }, (_, index) => ({
            id: `ui-fixture-${index}`,
            title: `云端模拟曲目 ${index + 1}`,
            user: { name: "演示音乐人" },
            genre: "Instrumental",
            is_streamable: true,
            is_available: true,
            is_stream_gated: false,
            is_delete: false,
            is_unlisted: false,
            access: { stream: true },
          })),
        }),
      });
    }
    if (
      url.origin === "https://api.audius.co" &&
      /^\/v1\/tracks\/ui-fixture-\d+\/stream$/.test(url.pathname)
    ) {
      return route.fulfill({
        status: 200,
        contentType: "audio/ogg",
        // Existing bundled CC0 audio only supplies metadata. No remote audio is
        // downloaded, and these tests do not claim real streaming verification.
        path: "public/music/calm-theme.ogg",
      });
    }
    errors.blockedRequests.push(`${url.origin}${url.pathname}`);
    return route.abort("blockedbyclient");
  });

  await page.addInitScript(() => {
    // Never inject Tauri internals or an API Key: exercise the real browser branch.
    if (!window.localStorage.getItem("daymate-state-v1")) {
      window.localStorage.setItem(
        "daymate-state-v1",
        JSON.stringify({
          state: {
            onboarded: true,
            tasks: [],
            preferences: {
              nickname: "云端演示",
              theme: "light",
              aiEnabled: true,
              aiProvider: "sensenova",
              aiBaseUrl: "https://token.sensenova.cn/v1",
              aiModel: "sensenova-6.8-flash-lite",
              aiShareActivitySummary: false,
              trackActivity: false,
              trackWindowTitles: false,
              notifications: false,
              autostart: false,
              musicCategory: "focus",
              musicAutoplay: false,
              musicPlayMode: "sequence",
            },
          },
          version: 0,
        }),
      );
    }
  });
  await page.clock.setFixedTime(new Date("2026-09-08T02:00:00Z"));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "云端演示",
  );
  await expect(
    page.getByRole("button", { name: "播放音乐", exact: true }),
  ).toBeVisible();
});

test.afterEach(async ({ page }) => {
  const errors = checks.get(page);
  expect(errors).toBeDefined();
  expect.soft(errors?.consoleErrors, "Browser console errors").toEqual([]);
  expect.soft(errors?.pageErrors, "Unhandled browser exceptions").toEqual([]);
  expect
    .soft(errors?.blockedRequests, "Unexpected external requests (all blocked)")
    .toEqual([]);
});

test("今日与设置：服务商配置恢复，浏览器不调用模型接口", async ({
  page,
}, testInfo) => {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "AI 服务", exact: true }),
  ).toBeVisible();
  const provider = page.getByLabel("服务商", { exact: true });
  const baseUrl = page.getByLabel("Base URL", { exact: true });
  const model = page.getByLabel("模型名称", { exact: true });
  const getModels = page.getByRole("button", { name: "获取模型", exact: true });
  await expect(getModels).toBeDisabled();

  await baseUrl.fill("https://sense-ui.invalid/v1");
  await model.fill("sensenova-ui-saved-model");
  await provider.selectOption("siliconflow");
  await expect(baseUrl).toHaveValue("https://api.siliconflow.cn/v1");
  await model.fill("Qwen/ui-saved-model");
  await provider.selectOption("sensenova");
  await expect(baseUrl).toHaveValue("https://sense-ui.invalid/v1");
  await expect(model).toHaveValue("sensenova-ui-saved-model");
  await provider.selectOption("siliconflow");
  await expect(model).toHaveValue("Qwen/ui-saved-model");

  // Ollama needs no saved key, so the enabled button exercises the browser-only
  // refusal instead of faking a credential or a Tauri bridge.
  await provider.selectOption("ollama");
  await expect(getModels).toBeEnabled();
  await getModels.click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "请在 DayMate 桌面版中获取模型" }),
  ).toBeVisible();
  await expect(model).toHaveValue("qwen3:8b");

  await provider.selectOption("sensenova");
  await baseUrl.fill("https://token.sensenova.cn/v1");
  await model.fill("sensenova-6.8-flash-lite");
  await page.reload();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await provider.selectOption("siliconflow");
  await expect(model).toHaveValue("Qwen/ui-saved-model");
  await provider.selectOption("sensenova");
  await expect(baseUrl).toHaveValue("https://token.sensenova.cn/v1");
  await expect(model).toHaveValue("sensenova-6.8-flash-lite");
  await expect(getModels).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("settings.png"),
    fullPage: true,
  });
  await testInfo.attach("设置页（云端浏览器演示）", {
    path: testInfo.outputPath("settings.png"),
    contentType: "image/png",
  });
});

test("内容：场景与鼓励本地回退，音乐操作不改变每日好句", async ({
  page,
}, testInfo) => {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "每日内容", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "给认真生活的人，一点小小补给。",
  );
  const quote = page.locator(".content-card.quote h2");
  const quoteText = await quote.innerText();
  const music = page.locator(".music-browser");
  const musicTitle = music.locator(".music-copy strong");
  await expect(musicTitle).toContainText("云端模拟曲目");
  await page.getByLabel("当前场景", { exact: true }).selectOption("focus");
  await page.getByLabel("此刻心情", { exact: true }).selectOption("tired");

  await music.getByRole("button", { name: "国风民乐", exact: true }).click();
  await expect(musicTitle).toContainText("云端模拟曲目");
  await expect(quote).toHaveText(quoteText);
  await music.getByRole("button", { name: "单曲循环", exact: true }).click();
  await expect(
    music.getByRole("button", { name: "单曲循环", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await music.getByRole("button", { name: "随机推荐", exact: true }).click();
  await expect(
    music.getByRole("button", { name: "随机推荐", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await music
    .getByRole("button", { name: "开启自动连播", exact: true })
    .click();
  await expect(
    music.getByRole("button", { name: "关闭自动连播", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const firstTrack = await musicTitle.innerText();
  await music.getByRole("button", { name: "换一首", exact: true }).click();
  await expect(musicTitle).not.toHaveText(firstTrack);
  const selectedTrack = await musicTitle.innerText();
  await expect(quote).toHaveText(quoteText);

  await page.getByRole("button", { name: "给我一句鼓励", exact: true }).click();
  const preview = page.getByRole("region", {
    name: "鼓励发送预览",
    exact: true,
  });
  await expect(preview).toContainText("专心做事");
  await expect(preview).toContainText("有些疲惫");
  await expect(preview).toContainText("不读取或发送任务");
  await preview
    .getByRole("button", { name: "确认生成鼓励", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "一句鼓励", exact: true })
      .getByRole("status"),
  ).toContainText("本地鼓励");
  await expect(quote).toHaveText(quoteText);
  await expect(musicTitle).toHaveText(selectedTrack);

  await music
    .getByRole("button", { name: "AI 按今日节奏推荐", exact: true })
    .click();
  const musicPreview = page.getByRole("region", {
    name: "AI 推荐发送预览",
    exact: true,
  });
  await expect(musicPreview).toContainText("本次不发送活动统计或任务信息");
  await musicPreview
    .getByRole("button", { name: "确认推荐", exact: true })
    .click();
  await expect(music.getByRole("status")).toContainText("本地推荐");
  await expect(musicTitle).toContainText("云端模拟曲目");
  await expect(quote).toHaveText(quoteText);
  await page.screenshot({
    path: testInfo.outputPath("content.png"),
    fullPage: true,
  });
  await testInfo.attach("每日内容（模拟曲库与本地回退）", {
    path: testInfo.outputPath("content.png"),
    contentType: "image/png",
  });
});
