import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright-core";
import { HARNESSES } from "../server/harness";
import { DEFAULT_PROFILE } from "../server/profile";
import { LOCALES } from "../shared/i18n";

/** Real built UI with isolated display fixtures; no Harness process or installation is started. */
export async function onboardingLayoutSmoke(browser: Browser, base: string, shotsDir?: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "light" });
  const errors: string[] = [];
  const evidence = [];
  let language: (typeof LOCALES)[number] = LOCALES[0];
  const harnesses = HARNESSES.filter((h) => h.curated || h.id === "mock").map((h) => ({
    ...h,
    registryId: h.registry ?? null,
    command: ["deepseek", "pi", "minimax"].includes(h.id) ? null : "onboarding-layout-fixture",
    installers: [],
    installable: false,
  }));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${base}/api/profile`, (route) =>
    route.fulfill({ json: { ...DEFAULT_PROFILE, theme: "light", language } }),
  );
  await page.route(`${base}/api/meta`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), onboarded: false } });
  });
  await page.route(`${base}/api/harnesses`, (route) => route.fulfill({ json: harnesses }));
  await page.route(`${base}/api/harnesses/*/test`, (route) => route.fulfill({ json: { ok: true, loggedIn: true } }));
  // Logos do not affect the text geometry; keep the fixture independent of the Registry network/cache.
  await page.route(`${base}/api/registry/icon/*`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16"/></svg>',
    }),
  );
  const shot = async (name: string) => {
    if (!shotsDir) return;
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
  };
  try {
    for (language of LOCALES) {
      for (const width of [320, 390, 1024, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`${base}/?onboarding-layout=${language}-${width}#/setup`);
        await page.waitForFunction((value) => document.documentElement.lang === value, language);
        const cards = page.locator(".onb-card");
        await page.waitForFunction(
          (count) => document.querySelectorAll(".onb-card").length === count,
          harnesses.length,
        );
        await page.evaluate(() => document.fonts.ready);
        const geometry = await cards.evaluateAll((elements) => {
          const overlap = (a: DOMRect, b: DOMRect) =>
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
          return elements.map((card) => {
            const name = card.querySelector(".onb-card-name") as HTMLElement;
            const state = card.querySelector(".onb-card-state") as HTMLElement;
            const badge = card.querySelector(".badge") as HTMLElement | null;
            const rect = card.getBoundingClientRect();
            const items = [name, state, ...(badge ? [badge] : [])];
            const clipsText = items.some((item) => {
              const range = document.createRange();
              range.selectNodeContents(item);
              const box = item.getBoundingClientRect();
              return [...range.getClientRects()].some(
                (text) =>
                  text.left < Math.max(rect.left, box.left) - 0.5 ||
                  text.right > Math.min(rect.right, box.right) + 0.5 ||
                  text.top < Math.max(rect.top, box.top) - 0.5 ||
                  text.bottom > Math.min(rect.bottom, box.bottom) + 0.5,
              );
            });
            const bounds = items.map((item) => item.getBoundingClientRect());
            return {
              name: name.textContent,
              left: rect.left,
              top: rect.top,
              height: rect.height,
              nameOffset: name.getBoundingClientRect().left - rect.left,
              nameTop: name.getBoundingClientRect().top - rect.top,
              stateOffset: state.getBoundingClientRect().left - rect.left,
              clipsText,
              overlaps: bounds.some((a, index) => bounds.slice(index + 1).some((b) => overlap(a, b))),
            };
          });
        });
        const overflow = await page.evaluate(() => {
          const grid = document.querySelector(".onb-grid") as HTMLElement;
          const title = document.querySelector(".onb-head > .title")?.getBoundingClientRect();
          const skip = document.querySelector(".onb-head > button")?.getBoundingClientRect();
          return {
            page: document.documentElement.scrollWidth - innerWidth,
            grid: grid.scrollWidth - grid.clientWidth,
            headerOverlap: !!title && !!skip && title.right > skip.left - 4,
          };
        });
        if (
          geometry.some(
            (card) => card.clipsText || card.overlaps || Math.abs(card.nameOffset - card.stateOffset) > 0.5,
          ) ||
          geometry.some((card) =>
            geometry.some(
              (other) =>
                Math.abs(card.top - other.top) < 0.5 &&
                (Math.abs(card.height - other.height) > 0.5 || Math.abs(card.nameTop - other.nameTop) > 0.5),
            ),
          ) ||
          overflow.page > 1 ||
          overflow.grid > 1 ||
          overflow.headerOverlap
        ) {
          await shot(`onboarding-failure-${language}-${width}`);
          throw new Error(`onboarding layout ${language}/${width}: ${JSON.stringify({ geometry, overflow })}`);
        }
        const deepseek = cards.filter({ hasText: "DeepSeek Harness" });
        await deepseek.click();
        if ((await deepseek.getAttribute("aria-pressed")) !== "true")
          throw new Error(`onboarding could not select DeepSeek in ${language}/${width}`);
        if ((await page.locator('.onb-card[aria-pressed="true"]').count()) !== 1)
          throw new Error(`onboarding selected multiple cards in ${language}/${width}`);
        await page.locator(".onb-note").waitFor({ state: "hidden" });
        await shot(`onboarding-${language}-${width}`);
        if (shotsDir && language === "zh-CN" && width === 1440)
          await deepseek.screenshot({ path: join(shotsDir, "onboarding-deepseek.png"), animations: "disabled" });
        const codex = cards.filter({ hasText: "Codex" });
        await codex.focus();
        await page.keyboard.press("Enter");
        await page.locator('.onb-step:nth-child(3)[data-state="active"] input').waitFor();
        if ((await codex.getAttribute("aria-pressed")) !== "true")
          throw new Error(`onboarding keyboard selection failed in ${language}/${width}`);
        evidence.push({
          language,
          width,
          cards: geometry.length,
          columns: geometry.filter((card) => card.top === geometry[0]?.top).length,
        });
      }
    }
    if (errors.length) throw new Error(`onboarding browser errors: ${errors.join("; ")}`);
    console.log(`PASS onboarding layout: ${JSON.stringify(evidence)}`);
    return evidence;
  } finally {
    await page.close();
  }
}

if (import.meta.main) {
  const dir = mkdtempSync(join(tmpdir(), "tuantuan-onboarding-"));
  process.env.TUANTUAN_WORKSPACES = join(dir, "workspaces");
  process.env.TUANTUAN_REGISTRY_OFFLINE = "1";
  const { serve } = await import("../server/app");
  const { app, server } = serve(
    { dbPath: join(dir, "onboarding.db"), staticDir: process.env.E2E_DIST ?? "web/dist" },
    0,
  );
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
  try {
    await onboardingLayoutSmoke(browser, `http://localhost:${server.port}`, process.env.SHOTS_DIR);
  } finally {
    await browser.close();
    app.host.shutdown();
    await app.projectTerminals.shutdown();
    server.stop(true);
    app.store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
