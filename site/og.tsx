/**
 * Renders the Open Graph / Twitter cards (1200×630, light theme) into site/public/assets/og/<locale>.png.
 * Run after a build when copy or branding changes: `bun site/build.tsx && bun site/og.tsx`.
 * Needs Chrome (CHROME_PATH, default /usr/bin/google-chrome).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import { BotAvatar } from "../web/src/BotAvatar";
import { BrandMark } from "../web/src/BrandMark";
import { COPY, LOCALES } from "./src/i18n";

const root = resolve(import.meta.dir);
const dist = join(root, "dist");
const outDir = join(root, "public/assets/og");
await mkdir(outDir, { recursive: true });
const css = (await readFile(join(dist, "assets/site.css"), "utf8")).replaceAll("url(fonts/", "url(assets/fonts/");

const bots = [
  ["cat", "#d97757"],
  ["rabbit", "#3d7bfa"],
  ["dog", "#a86b45"],
  ["orb", "#13a594"],
  ["clover", "#2bb06a"],
  ["flower", "#9a5bea"],
] as const;

function Card({ locale }: { locale: (typeof LOCALES)[number] }) {
  const t = COPY[locale];
  return (
    <div className="og">
      <BrandMark size={96} />
      <h1>{t.name}</h1>
      <p>{t.hero.tagline}</p>
      <div className="og-bots">
        {bots.map(([shape, color]) => (
          <BotAvatar key={shape} shape={shape} color={color} size={52} />
        ))}
      </div>
      <span className="og-url">github.com/bosshanz/tuantuan</span>
    </div>
  );
}

const ogCss = `
html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#f5f5f3}
.og{position:relative;height:630px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;
  background:radial-gradient(55% 60% at 50% 0%,rgb(242 85 60/.1),transparent 70%),#f5f5f3}
.og h1{margin:26px 0 0;font-size:76px;line-height:1.05;font-weight:800;letter-spacing:-.035em;color:#18181a}
.og p{margin:16px 60px 0;font-size:31px;font-weight:650;letter-spacing:-.01em;color:#55555b}
.og-bots{display:flex;gap:26px;margin-top:44px}
.og-url{position:absolute;bottom:34px;font-size:20px;font-weight:600;color:#d03b20}
`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, colorScheme: "light" });
for (const locale of LOCALES) {
  const html = `<!doctype html><html lang="${COPY[locale].htmlLang}"><head><meta charset="utf-8"><style>${css}${ogCss}</style></head><body>${renderToStaticMarkup(<Card locale={locale} />)}</body></html>`;
  const tmp = join(dist, "_og.html");
  await writeFile(tmp, html);
  await page.goto(`file://${tmp}`);
  await rm(tmp);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(outDir, `${locale}.png`) });
  console.log(`og: ${locale}.png`);
}
await browser.close();
