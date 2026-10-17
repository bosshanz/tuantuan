# Tuantuan landing page

Static site for GitHub Pages. One HTML page per locale, rendered at build time from `src/Page.tsx`
with the app's own `BotAvatar`, `BrandMark` and vendor marks (`web/src/brandIcons.ts`).

| Path | Purpose |
| --- | --- |
| `src/i18n.ts` | All copy (en, zh-CN, zh-TW, ja), based on the READMEs |
| `src/Page.tsx` | Page markup, including the handoff demo |
| `src/main.ts` | OS-aware download label, language menu, video, demo timeline, copy buttons |
| `src/styles.css`, `src/avatar.css` | Styles (tokens mirror `web/src/styles.css`) |
| `public/assets/` | Promo video, its poster frame, Open Graph images |
| `build.tsx` / `og.tsx` / `verify.ts` | Build (`--serve` to preview), OG image renderer, Playwright checks |

```bash
bun run site:dev      # http://localhost:4173
bun run site:verify   # screenshots + layout/link/language checks (needs Chrome)
```

Deploys with `.github/workflows/pages.yml` (Settings → Pages → Source: GitHub Actions).
The hero plays `public/assets/six-windows-social.mp4` (21 s, poster `six-windows-poster.jpg`) and links the full cut `six-windows.mp4` (35 s). Lower on the page, the Session Score section plays `session-score-social.mp4` (poster `session-score-poster.jpg`, full cut `session-score.mp4`). Replace those files to swap a promo. The READMEs link their poster (`docs/assets/six-windows-poster.jpg`) to the Pages copy of `six-windows.mp4`.
