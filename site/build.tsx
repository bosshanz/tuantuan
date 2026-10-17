/**
 * Builds the static landing page into site/dist: one HTML file per locale (rendered from the app's
 * own React components), the client script, CSS, fonts and media. `--serve` previews dist locally.
 *
 *   bun site/build.tsx            # build
 *   bun site/build.tsx --serve    # build, then serve http://localhost:4173
 *
 * SITE_URL (default https://bosshanz.github.io/tuantuan/) sets canonical, hreflang and og:image URLs.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { LOCALE_PATH, LOCALES } from "./src/i18n";
import { Page } from "./src/Page";

const root = resolve(import.meta.dir);
const repo = resolve(root, "..");
const out = join(root, "dist");
const siteUrl = (process.env.SITE_URL ?? "https://bosshanz.github.io/tuantuan/").replace(/\/?$/, "/");

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "assets/fonts"), { recursive: true });

for (const locale of LOCALES) {
  const html = `<!doctype html>${renderToStaticMarkup(<Page locale={locale} siteUrl={siteUrl} />)}`;
  const file = join(out, LOCALE_PATH[locale], "index.html");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html);
}

const js = await Bun.build({ entrypoints: [join(root, "src/main.ts")], minify: true, target: "browser" });
if (!js.success) throw new AggregateError(js.logs, "site: main.ts failed to build");
const [bundle] = js.outputs;
if (!bundle) throw new Error("site: main.ts produced no output");
await writeFile(join(out, "assets/main.js"), await bundle.text());

const css = await Promise.all(["src/styles.css", "src/avatar.css"].map((f) => readFile(join(root, f), "utf8")));
await writeFile(join(out, "assets/site.css"), css.join("\n"));

const fonts = join(repo, "node_modules/@fontsource-variable/plus-jakarta-sans/files");
await cp(
  join(fonts, "plus-jakarta-sans-latin-wght-normal.woff2"),
  join(out, "assets/fonts/plus-jakarta-sans-latin.woff2"),
);
await cp(
  join(fonts, "plus-jakarta-sans-latin-ext-wght-normal.woff2"),
  join(out, "assets/fonts/plus-jakarta-sans-latin-ext.woff2"),
);
for (const f of ["favicon.svg", "favicon-32.png", "apple-touch-icon.png"])
  await cp(join(repo, "web/public", f), join(out, f));
await cp(join(root, "public"), out, { recursive: true });

const urls = LOCALES.map((l) => `${siteUrl}${LOCALE_PATH[l]}`);
const alt = LOCALES.map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${siteUrl}${LOCALE_PATH[l]}"/>`).join(
  "",
);
await writeFile(
  join(out, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls.map((u) => `<url><loc>${u}</loc>${alt}</url>`).join("")}</urlset>\n`,
);
await writeFile(join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${siteUrl}sitemap.xml\n`);
console.log(`site: built ${LOCALES.length} locales into ${out}`);

if (process.argv.includes("--serve")) {
  const port = Number(process.env.PORT ?? 4173);
  Bun.serve({
    port,
    async fetch(req) {
      let path = decodeURIComponent(new URL(req.url).pathname);
      if (path.endsWith("/")) path += "index.html";
      const file = Bun.file(join(out, path));
      if (!path.includes("..") && (await file.exists())) return new Response(file);
      const dir = Bun.file(join(out, path, "index.html"));
      if (await dir.exists()) return Response.redirect(`${path}/`, 301);
      return new Response("Not found", { status: 404 });
    },
  });
  console.log(`site: http://localhost:${port}/`);
}
