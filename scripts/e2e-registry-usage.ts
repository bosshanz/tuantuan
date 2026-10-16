import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { HarnessUsage } from "../server/usage";

/** UI contract fixtures; native ACP protocol and cache behavior are covered by API tests. */
export async function registryUsageSmoke(browser: Browser, base: string, shotsDir?: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  let remaining = 82;
  let refreshes = 0;
  const rows = (): HarnessUsage[] => [
    {
      harness: "reg:antigravity-acp",
      name: "Google Antigravity",
      live: true,
      today: null,
      week: null,
      plan: "Google AI Pro",
      limits: [
        { label: "Gemini Models · Weekly Limit Remaining", usedPercent: 0, resetsAt: "2026-10-23T02:05:00Z" },
        { label: "Gemini Models · Five Hour Limit Remaining", usedPercent: 0, resetsAt: "2026-10-16T07:05:00Z" },
        { label: "Claude and GPT models · Weekly Limit Remaining", usedPercent: 1, resetsAt: "2026-10-23T02:05:00Z" },
        {
          label: "Claude and GPT models · Five Hour Limit Remaining",
          usedPercent: 0,
          resetsAt: "2026-10-16T07:05:00Z",
        },
        {
          label: "Gemini 4 Argon · Gemini 4 Argon Weekly Limit",
          usedPercent: 100 - remaining,
          resetsAt: "2026-10-23T02:05:00Z",
        },
      ],
      limitsAt: Date.now(),
      limitsSource: "Antigravity /usage",
      notes: [],
    },
    {
      harness: "reg:zcode-acp",
      name: "ZCode",
      live: true,
      today: null,
      week: null,
      plan: null,
      limits: [],
      limitsAt: Date.now(),
      limitsSource: "ZCode account/usage_stats",
      notes: ["社区桥接 0.70.0 尚不支持团队套餐；查询结果不代表团队余额。"],
    },
  ];
  try {
    await page.route("**/api/usage", (route) => route.fulfill({ json: { harnesses: rows(), tuantuan: [] } }));
    await page.route(/\/api\/usage\/reg(?:%3A|:)antigravity-acp\/live$/i, async (route) => {
      if (route.request().method() !== "POST") throw new Error("quota refresh must be explicit POST");
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 150));
      remaining = 77;
      await route.fulfill({ json: { harnesses: rows() } });
    });
    await page.goto(`${base}/#/providers`);
    const agy = page.getByTestId("usage-reg:antigravity-acp");
    const zcode = page.getByTestId("usage-reg:zcode-acp");
    await agy.getByText("剩 82%", { exact: true }).waitFor();
    await agy.getByText("Google AI Pro", { exact: true }).waitFor();
    await zcode.getByText("额度未知", { exact: true }).waitFor();
    if (await zcode.getByText("剩 0%", { exact: true }).count()) throw new Error("unknown quota became zero");
    if (await agy.getByText("今天", { exact: true }).count())
      throw new Error("quota-only card shows empty token totals");
    if (refreshes) throw new Error("opening usage page queried the harness");
    const refresh = agy.getByRole("button", { name: "刷新 Google Antigravity 额度", exact: true });
    await refresh.click();
    await agy.getByText("剩 77%", { exact: true }).waitFor();
    if (refreshes !== 1) throw new Error("quota refresh count mismatch");
    await agy.scrollIntoViewIfNeeded();
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "registry-usage.png") });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "registry-usage-dark.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await agy.scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    if (overflow) throw new Error("registry quota cards overflow narrow viewport");
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "registry-usage-narrow.png") });
    console.log("registry usage browser: PASS (dynamic cards, unknown quota, refresh, dark/narrow)");
  } finally {
    await context.close();
  }
}
