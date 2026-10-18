/**
 * Landing-page check (needs `bun site/build.tsx` first and Chrome; CHROME_PATH overrides the path).
 * Shoots every locale × theme × viewport, fails on horizontal overflow, clipped controls, console
 * errors, broken internal links/anchors, and checks language auto-detection and the language menu.
 * External links are requested too; set SKIP_EXTERNAL=1 to skip them offline.
 *
 *   SHOTS_DIR=/tmp/site-shots bun site/verify.ts
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { LOCALE_PATH, LOCALES } from "./src/i18n";

const dist = join(resolve(import.meta.dir), "dist");
const shots = process.env.SHOTS_DIR ?? "/tmp/site-shots";
await mkdir(shots, { recursive: true });

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = Bun.file(join(dist, path));
    if (!path.includes("..") && (await file.exists())) return new Response(file);
    return new Response("Not found", { status: 404 });
  },
});
const origin = `http://localhost:${server.port}`;
const problems: string[] = [];
const fail = (m: string) => {
  problems.push(m);
  console.log(`  ✗ ${m}`);
};

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, mobile: false },
  tablet: { width: 820, height: 1180, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
  narrow: { width: 320, height: 640, mobile: true },
} as const;
const BROWSER_LOCALE = { en: "en-US", "zh-CN": "zh-CN", "zh-TW": "zh-TW", ja: "ja-JP" } as const;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });

/** Layout problems: page wider than the viewport, or text cut inside a control that should fit. */
async function layoutIssues(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1)
      out.push(`page scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
    const clips = (el: Element | null): boolean => {
      for (let p = el?.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p);
        if (/(hidden|auto|scroll|clip)/.test(o.overflowX)) return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || getComputedStyle(el).visibility === "hidden") continue;
      if ((r.right > vw + 1 || r.left < -1) && !clips(el))
        out.push(`${el.tagName.toLowerCase()}.${el.className} spills (${Math.round(r.left)}..${Math.round(r.right)})`);
    }
    for (const el of document.querySelectorAll<HTMLElement>(
      ".btn, .harness-name, .step-t b, .card h3, h1, h2, .tagline, .eyebrow, .nav a, .goal, .chip",
    )) {
      if (el.offsetParent && el.scrollWidth > el.clientWidth + 1)
        out.push(`text clipped in ${el.className || el.tagName}: "${el.textContent?.trim().slice(0, 40)}"`);
    }
    return [...new Set(out)].slice(0, 12);
  });
}

async function revealAll(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 30));
    }
    scrollTo(0, 0);
  });
  await page.waitForTimeout(250);
}

const links = new Map<string, string>();
console.log("screenshots + layout");
for (const locale of LOCALES) {
  for (const scheme of ["light", "dark"] as const) {
    for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vpName === "desktop" ? 1 : 2,
        isMobile: vp.mobile,
        hasTouch: vp.mobile,
        colorScheme: scheme,
        reducedMotion: "reduce",
        locale: BROWSER_LOCALE[locale],
      });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      page.on("requestfailed", (r) => !r.url().endsWith(".mp4") && errors.push(`request failed ${r.url()}`));
      page.on(
        "response",
        (r) => r.url().startsWith(origin) && r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`),
      );
      await page.goto(`${origin}/${LOCALE_PATH[locale]}`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await revealAll(page);
      // Lay out the macOS first-launch hint expanded too, so its steps and command are checked.
      await page.evaluate(() => {
        for (const d of document.querySelectorAll("details")) d.open = true;
      });
      const tag = `${locale}-${scheme}-${vpName}`;
      for (const e of errors) fail(`${tag}: ${e}`);
      for (const issue of await layoutIssues(page)) fail(`${tag}: ${issue}`);
      if (vpName === "desktop" || vpName === "mobile")
        await page.screenshot({ path: join(shots, `${tag}.png`), fullPage: true });
      if (scheme === "light" && vpName === "desktop") {
        for (const href of await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href)))
          links.set(href, tag);
        for (const sel of ["link[rel=icon]", "link[rel=stylesheet]", "meta[property='og:image']"]) {
          const v = await page.$eval(sel, (el) => el.getAttribute("href") ?? el.getAttribute("content"));
          if (!v) fail(`${tag}: missing ${sel}`);
        }
        const alts = await page.$$eval("link[rel=alternate][hreflang]", (ls) =>
          ls.map((l) => l.getAttribute("hreflang")),
        );
        if (alts.length !== LOCALES.length + 1) fail(`${tag}: hreflang count ${alts.length}`);
      }
      await ctx.close();
    }
  }
}

console.log("motion: handoff demo mid-story, hover states");
for (const scheme of ["light", "dark"] as const) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
    locale: "en-US",
  });
  const page = await ctx.newPage();
  await page.goto(`${origin}/`);
  await page.locator("#handoff").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector("#demo")?.getAttribute("data-phase") === "11", null, {
    timeout: 15000,
  });
  await page.waitForTimeout(500);
  await page.locator("#handoff").screenshot({ path: join(shots, `motion-handoff-${scheme}.png`) });
  await page.waitForFunction(() => document.querySelector("#demo")?.getAttribute("data-phase") === "16", null, {
    timeout: 15000,
  });
  await page.waitForTimeout(1400);
  await page.locator("#handoff").screenshot({ path: join(shots, `motion-diff-${scheme}.png`) });
  if (scheme === "light") {
    await page.locator(".step").first().click();
    if ((await page.getAttribute("#demo", "data-phase")) !== "0") fail("step 1 click did not rewind the demo");
    const video = await page.evaluate(async () => {
      const v = document.querySelector("video") as HTMLVideoElement;
      v.scrollIntoView();
      await new Promise((r) => setTimeout(r, 900));
      return { paused: v.paused, muted: v.muted, ready: v.readyState };
    });
    await page.evaluate(() => scrollTo(0, 0));
    if (video.paused || !video.muted) fail(`hero video should autoplay muted in view: ${JSON.stringify(video)}`);
    await page.hover(".harness >> nth=0");
    await page.waitForTimeout(250);
    await page.locator("#harnesses").screenshot({ path: join(shots, "hover-harness.png") });
  }
  await ctx.close();
}

console.log("macOS first-launch hint");
for (const locale of LOCALES) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: BROWSER_LOCALE[locale] });
  const page = await ctx.newPage();
  await page.goto(`${origin}/${LOCALE_PATH[locale]}`);
  const hint = page.locator("#mac-first");
  if (await hint.locator(".mac-first-body").isVisible()) fail(`${locale}: macOS hint should start collapsed`);
  await hint.locator("summary").click();
  if (!(await hint.locator(".mac-first-body").isVisible())) fail(`${locale}: macOS hint did not expand`);
  const cmds = await hint.locator("button[data-copy]").evaluateAll((bs) => bs.map((b) => b.getAttribute("data-copy")));
  const want = [
    "brew install --cask bosshanz/tap/tuantuan",
    "xattr -dr com.apple.quarantine /Applications/tuantuan.app",
  ];
  if (JSON.stringify(cmds) !== JSON.stringify(want)) fail(`${locale}: hint commands are ${JSON.stringify(cmds)}`);
  if ((await hint.locator("ol li").count()) !== 3) fail(`${locale}: macOS hint should list 3 steps`);
  if (locale === "en" || locale === "zh-CN") {
    await page.waitForTimeout(300);
    await hint.screenshot({ path: join(shots, `mac-first-${locale}.png`) });
  }
  await ctx.close();
}

console.log("language detection + menu");
{
  const cases: [string, string][] = [
    ["ja-JP", "/ja/"],
    ["zh-TW", "/zh-TW/"],
    ["zh-HK", "/zh-TW/"],
    ["zh-CN", "/zh-CN/"],
    ["en-GB", "/"],
    ["fr-FR", "/"],
  ];
  for (const [loc, want] of cases) {
    const ctx = await browser.newContext({ locale: loc });
    const page = await ctx.newPage();
    await page.goto(`${origin}/`);
    await page.waitForLoadState("load");
    const got = new URL(page.url()).pathname;
    if (got !== want) fail(`browser ${loc} landed on ${got}, expected ${want}`);
    await ctx.close();
  }
  const ctx = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${origin}/`);
  await page.waitForURL(/\/ja\/$/);
  await page.click(".lang-btn");
  if (await page.locator(".lang-menu").isHidden()) fail("language menu did not open");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "lang-menu.png"), clip: { x: 840, y: 0, width: 600, height: 280 } });
  await page.keyboard.press("Escape");
  if (await page.locator(".lang-menu").isVisible()) fail("Escape did not close the language menu");
  await page.click(".lang-btn");
  await page.click('.lang-menu a[data-lang="en"]');
  await page.waitForURL(`${origin}/`);
  await page.goto(`${origin}/`);
  if (new URL(page.url()).pathname !== "/") fail("stored English choice was not honoured");
  await ctx.close();
}

console.log("links");
const sameOrigin = [...links.keys()].filter((u) => u.startsWith(origin));
for (const u of sameOrigin) {
  const url = new URL(u);
  const res = await fetch(url.origin + url.pathname);
  if (!res.ok) fail(`internal ${u} → ${res.status}`);
  if (url.hash) {
    const html = await res.text();
    if (!html.includes(`id="${url.hash.slice(1)}"`)) fail(`missing anchor ${u}`);
  }
}
const external = [...new Set([...links.keys()].filter((u) => !u.startsWith(origin)).map((u) => u.replace(/#.*$/, "")))];
const knownPending: string[] = [];
if (!process.env.SKIP_EXTERNAL) {
  for (const u of external) {
    let status = 0;
    try {
      status = (await fetch(u, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 tuantuan-site-check" } }))
        .status;
    } catch (e) {
      status = -1;
      console.log(`  ? ${u}: ${e}`);
    }
    if (status === 200) console.log(`  ✓ ${status} ${u}`);
    else if (u.endsWith("/releases/tag/v0.2.0")) {
      knownPending.push(`${u} → ${status} (release not published yet)`);
      console.log(`  ! ${status} ${u} (release draft)`);
    } else fail(`external ${u} → ${status}`);
  }
}

await browser.close();
server.stop();
console.log(`\nchecked ${sameOrigin.length} internal + ${external.length} external links; shots in ${shots}`);
for (const k of knownPending) console.log(`pending: ${k}`);
if (problems.length) {
  console.log(`${problems.length} problem(s)`);
  process.exit(1);
}
console.log("site verify: ok");
