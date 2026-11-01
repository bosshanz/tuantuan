import {
  ArrowRightLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  Copy,
  Download,
  Eye,
  Files,
  Globe,
  Inbox,
  Info,
  LayoutGrid,
  LoaderCircle,
  Pause,
  Play,
  Plug,
  RotateCcw,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  Users,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Expression } from "../../web/src/avatarState";
import { BotAvatar } from "../../web/src/BotAvatar";
import { BrandMark } from "../../web/src/BrandMark";
import { BRAND_SVG } from "../../web/src/brandIcons";
import { COPY, LANG_NAME, LOCALE_PATH, LOCALES, type Locale, README_FILE } from "./i18n";

export const REPO = "https://github.com/bosshanz/tuantuan";
export const RELEASE = `${REPO}/releases/tag/v0.3.2`;
const ACP = "https://agentclientprotocol.com";
/** The bundle is tuantuan.app (CFBundleName 团团); the xattr path must use the file name. */
const BREW = "brew install --cask bosshanz/tap/tuantuan";
const XATTR = "xattr -dr com.apple.quarantine /Applications/tuantuan.app";
const INSTALL_DOC = `${REPO}/blob/main/docs/install.md`;

/** Agent colours used in the demo: Claude Code's coral cat, Codex's blue rabbit (app palette). */
const CAT = "#d97757";
const RABBIT = "#3d7bfa";

/** Pi's mark as published in the ACP Registry (cdn.agentclientprotocol.com/registry/v1/latest/pi-acp.svg). */
const PI_SVG =
  '<path d="M1 1H11.7692V7.9999H8.17942V11.4999H4.58982V15H1V1ZM4.58982 4.50005V7.9999H8.17942V4.50005H4.58982Z"/><path d="M11.7692 7.46154H15V15H11.7692V7.46154Z"/>';

/** GitHub's mark (Octicons mark-github, MIT). */
const GITHUB_PATH =
  "M12 .3a12 12 0 0 0-3.8 23.38c.6.12.82-.26.82-.57v-2c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.82.58A12 12 0 0 0 12 .3";

type Harness = { name: string; svg: string; viewBox: string };
const HARNESSES: Harness[] = [
  { name: "Claude Code", svg: BRAND_SVG.anthropic ?? "", viewBox: "0 0 24 24" },
  { name: "Codex", svg: BRAND_SVG.openai ?? "", viewBox: "0 0 24 24" },
  { name: "DeepSeek", svg: BRAND_SVG.deepseek ?? "", viewBox: "0 0 24 24" },
  { name: "OpenCode", svg: BRAND_SVG.opencode ?? "", viewBox: "0 0 24 24" },
  { name: "Pi", svg: PI_SVG, viewBox: "0 0 16 16" },
  { name: "Grok Build", svg: BRAND_SVG.xai ?? "", viewBox: "0 0 24 24" },
  { name: "MiniMax Code", svg: BRAND_SVG.minimax ?? "", viewBox: "0 0 24 24" },
];

const FEATURE_ICONS = [Plug, Users, ArrowRightLeft, SquareTerminal, Eye, SlidersHorizontal, Search, Files, Inbox];

function Logo({ svg, viewBox, label, size = 28 }: { svg: string; viewBox: string; label: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="currentColor"
      fillRule="evenodd"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static vendor marks bundled at build time */}
      <g dangerouslySetInnerHTML={{ __html: svg }} />
    </svg>
  );
}

function GitHubMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={GITHUB_PATH} />
    </svg>
  );
}

const EXPRESSIONS: Expression[] = ["idle", "working", "sad", "happy"];

/** Every expression is pre-rendered from the app's own BotAvatar; CSS shows the one in data-expr. */
function Bot({ who, shape, color, size }: { who: "a" | "b"; shape: "cat" | "rabbit"; color: string; size: number }) {
  return (
    <span className="av" data-who={who} data-expr="idle" style={{ width: size, height: size }}>
      {EXPRESSIONS.map((e) => (
        <BotAvatar key={e} shape={shape} color={color} size={size} expression={e} animate />
      ))}
      <svg className="sweat" viewBox="0 0 10 14" aria-hidden="true">
        <path d="M5 0C6.5 3 9 5.5 9 8.5A4 4 0 0 1 1 8.5C1 5.5 3.5 3 5 0Z" />
      </svg>
    </span>
  );
}

/** A chat item that expands in at `at` (the demo phase). */
function Item({ at, className = "", children }: { at: number; className?: string; children: ReactNode }) {
  return (
    <div className={`it ${className}`} data-at={at}>
      <div className="it-in">{children}</div>
    </div>
  );
}

function Tool({ id, label, status, fx, ok }: { id: string; label: string; status: string; fx?: string; ok?: boolean }) {
  return (
    <div className={`tool${ok ? " ok" : ""}`} id={id} data-fx={fx}>
      <span className="tool-ic" aria-hidden="true">
        <LoaderCircle className="i-run" size={14} strokeWidth={2} />
        <CircleX className="i-fail" size={14} strokeWidth={2} />
        <CircleCheck className="i-ok" size={14} strokeWidth={2} />
      </span>
      <span className="mono tool-label">{label}</span>
      <span className="tool-status">{status}</span>
    </div>
  );
}

const DIFF: [" " | "-" | "+", number, string][] = [
  [" ", 12, "export async function getToken(s: Session) {"],
  ["-", 13, "  if (s.expired) return refresh(s);"],
  ["+", 13, "  if (s.expired) {"],
  ["+", 14, "    inflight ??= refresh(s).finally(() => (inflight = null));"],
  ["+", 15, "    return inflight;"],
  ["+", 16, "  }"],
];

function Demo({ locale }: { locale: Locale }) {
  const h = COPY[locale].handoff;
  return (
    <div className="demo" id="demo" data-phase="16">
      <div className="win" aria-hidden="true">
        <div className="win-bar">
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
          <span className="win-title">
            <span className="hash">#</span>
            {h.room}
          </span>
          <span className="members">
            <Bot who="a" shape="cat" color={CAT} size={20} />
            <Bot who="b" shape="rabbit" color={RABBIT} size={20} />
          </span>
          <span className="goal" data-fx="16:done">
            <span className="goal-ck">
              <Check size={10} strokeWidth={3} />
            </span>
            {h.goal}
          </span>
        </div>
        <div className="log">
          <Item at={1} className="row-user">
            <div className="bubble">
              <span className="mention">@Claude Code</span> {h.user}
            </div>
          </Item>
          <Item at={2} className="row-agent">
            <div className="who">
              <Bot who="a" shape="cat" color={CAT} size={24} />
              <b>Claude Code</b>
            </div>
            <Tool id="t1" label={h.run} status={h.fail} fx="3:fail" />
          </Item>
          <Item at={4} className="row-agent cont">
            <Tool id="t2" label={h.retry} status={h.fail} fx="5:fail" />
          </Item>
          <Item at={6} className="row-agent cont">
            <p className="say">
              {h.stuck} <span className="mention">@Codex</span>
              <span className="chip chip-stuck">{h.stuckLabel}</span>
            </p>
          </Item>
          <Item at={7} className="row-agent cont">
            <div className="handoff" data-fx="12:sent">
              <div className="ho-head">
                <ArrowRightLeft size={14} strokeWidth={2.2} />
                <b>{h.cardTitle}</b>
                <span className="ho-to">
                  → <Bot who="b" shape="rabbit" color={RABBIT} size={16} /> Codex
                </span>
              </div>
              <dl className="ho-rows">
                {h.fields.map(([k, v], i) => (
                  <div className="ho-row" data-at={8 + i} key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="ho-foot">
                <Check size={12} strokeWidth={3} />
                {h.sent}
              </div>
            </div>
          </Item>
          <Item at={13} className="row-agent">
            <div className="who">
              <Bot who="b" shape="rabbit" color={RABBIT} size={24} />
              <b>Codex</b>
            </div>
            <p className="say">{h.found}</p>
          </Item>
          <Item at={14} className="row-agent cont">
            <div className="diff">
              <div className="diff-head">
                <span className="mono">src/auth/refresh.ts</span>
                <span className="mono">
                  <b className="add">+4</b> <b className="del">−1</b>
                </span>
              </div>
              {DIFF.map(([k, n, code], i) => (
                <div
                  className={`dl dl-${k === "+" ? "add" : k === "-" ? "del" : "ctx"}`}
                  style={{ "--i": i } as never}
                  key={`${k}${n}`}
                >
                  <span className="dn">{n}</span>
                  <span className="dk">{k}</span>
                  <code>{code}</code>
                </div>
              ))}
            </div>
          </Item>
          <Item at={15} className="row-agent cont">
            <Tool id="t3" label="bun test auth" status={h.pass} ok />
          </Item>
          <Item at={16} className="row-agent cont">
            <span className="chip chip-back">
              <ArrowRightLeft size={12} strokeWidth={2.4} />
              {h.returned}
            </span>
          </Item>
        </div>
      </div>
    </div>
  );
}

type SiteCopy = (typeof COPY)[Locale];

/** Muted, in-view autoplaying promo clip with play/pause and sound controls (wired in main.ts). */
function VideoFigure({
  id,
  base,
  name,
  label,
  t,
}: {
  id: string;
  base: string;
  name: string;
  label: string;
  t: SiteCopy;
}) {
  return (
    <figure className="video" id={id}>
      <video muted loop playsInline preload="metadata" poster={`${base}assets/${name}-poster.jpg`} aria-label={label}>
        <source src={`${base}assets/${name}-social.mp4`} type="video/mp4" />
      </video>
      <button type="button" className="video-play" data-label-play={t.video.play} aria-label={t.video.play}>
        <Play size={22} strokeWidth={2} fill="currentColor" aria-hidden="true" />
      </button>
      <div className="video-ctl">
        <button
          type="button"
          className="icon-btn on-media"
          data-act="toggle"
          data-play={t.video.play}
          data-pause={t.video.pause}
          aria-label={t.video.play}
        >
          <Play className="i-play" size={15} strokeWidth={2} fill="currentColor" aria-hidden="true" />
          <Pause className="i-pause" size={15} strokeWidth={2} fill="currentColor" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-btn on-media"
          data-act="sound"
          data-on={t.video.soundOn}
          data-off={t.video.soundOff}
          aria-label={t.video.soundOn}
        >
          <VolumeX className="i-muted" size={15} strokeWidth={2} aria-hidden="true" />
          <Volume2 className="i-sound" size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </figure>
  );
}

function rel(from: Locale, to: Locale): string {
  const up = from === "en" ? "" : "../";
  return `${up}${LOCALE_PATH[to]}` || "./";
}

export function Page({ locale, siteUrl }: { locale: Locale; siteUrl: string }) {
  const t = COPY[locale];
  const base = locale === "en" ? "" : "../";
  const url = `${siteUrl}${LOCALE_PATH[locale]}`;
  const og = `${siteUrl}assets/og/${locale}.png`;
  const headScript = `document.documentElement.classList.add("js");${
    locale === "en"
      ? `(function(){try{var m={"zh-CN":"zh-CN/","zh-TW":"zh-TW/",ja:"ja/"},s=localStorage.getItem("tt-lang");if(s==="en")return;var l=s;if(!l){var n=(navigator.languages||[navigator.language]).map(function(x){return String(x).toLowerCase()});for(var i=0;i<n.length&&!l;i++){var x=n[i];if(/^zh-(tw|hk|mo)|^zh-hant/.test(x))l="zh-TW";else if(/^zh/.test(x))l="zh-CN";else if(/^ja/.test(x))l="ja";else if(/^en/.test(x))l="en"}}if(l&&m[l])location.replace(m[l]+location.hash)}catch(e){}})();`
      : ""
  }`;
  return (
    <html lang={t.htmlLang}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{t.title}</title>
        <meta name="description" content={t.description} />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f5f5f3" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#111113" />
        <link rel="canonical" href={url} />
        {LOCALES.map((l) => (
          <link key={l} rel="alternate" hrefLang={l} href={`${siteUrl}${LOCALE_PATH[l]}`} />
        ))}
        <link rel="alternate" hrefLang="x-default" href={siteUrl} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Tuantuan" />
        <meta property="og:title" content={t.title} />
        <meta property="og:description" content={t.description} />
        <meta property="og:url" content={url} />
        <meta property="og:image" content={og} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content={`${t.name} — ${t.hero.tagline}`} />
        <meta property="og:locale" content={t.ogLocale} />
        {LOCALES.filter((l) => l !== locale).map((l) => (
          <meta key={l} property="og:locale:alternate" content={COPY[l].ogLocale} />
        ))}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={t.title} />
        <meta name="twitter:description" content={t.description} />
        <meta name="twitter:image" content={og} />
        <link rel="icon" type="image/svg+xml" href={`${base}favicon.svg`} />
        <link rel="icon" type="image/png" sizes="32x32" href={`${base}favicon-32.png`} />
        <link rel="apple-touch-icon" href={`${base}apple-touch-icon.png`} />
        <link
          rel="preload"
          href={`${base}assets/fonts/plus-jakarta-sans-latin.woff2`}
          as="font"
          type="font/woff2"
          crossOrigin=""
        />
        <link rel="stylesheet" href={`${base}assets/site.css`} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static inline bootstrap written by the build */}
        <script dangerouslySetInnerHTML={{ __html: headScript }} />
        <script type="module" src={`${base}assets/main.js`} />
      </head>
      <body data-locale={locale}>
        <a className="skip" href="#main">
          {t.nav.skip}
        </a>
        <header className="top" id="top">
          <div className="wrap top-in">
            <a className="brand" href={rel(locale, locale)} aria-label={t.name}>
              <BrandMark size={26} />
              <span>{t.name}</span>
            </a>
            <nav className="nav" aria-label="Primary">
              <a href="#handoff">{t.nav.handoff}</a>
              <a href="#harnesses">{t.nav.harnesses}</a>
              <a href="#features">{t.nav.features}</a>
              <a href="#start">{t.nav.start}</a>
            </nav>
            <div className="top-actions">
              <div className="lang" id="lang">
                <button
                  type="button"
                  className="icon-btn lang-btn"
                  aria-haspopup="true"
                  aria-expanded="false"
                  aria-controls="lang-menu"
                  aria-label={t.nav.language}
                >
                  <Globe size={16} strokeWidth={1.9} aria-hidden="true" />
                  <span className="lang-cur">{LANG_NAME[locale]}</span>
                  <ChevronDown className="chev" size={14} strokeWidth={2} aria-hidden="true" />
                </button>
                <ul className="lang-menu" id="lang-menu" hidden>
                  {LOCALES.map((l) => (
                    <li key={l}>
                      <a
                        href={rel(locale, l)}
                        hrefLang={l}
                        lang={l}
                        data-lang={l}
                        aria-current={l === locale ? "true" : undefined}
                      >
                        {LANG_NAME[l]}
                        {l === locale && <Check size={14} strokeWidth={2.4} aria-hidden="true" />}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
              <a className="icon-btn" href={REPO} aria-label="GitHub">
                <GitHubMark />
              </a>
            </div>
          </div>
        </header>

        <main id="main">
          <section className="hero">
            <div className="wrap hero-in">
              <p className="eyebrow" data-reveal>
                <span className="eyebrow-dot" />
                {t.hero.eyebrow}
              </p>
              <h1 data-reveal>{t.name}</h1>
              <p className="tagline" data-reveal>
                {t.hero.tagline}
              </p>
              <p className="lede" data-reveal>
                {t.hero.sub}
              </p>
              <div className="cta" data-reveal>
                <a
                  className="btn btn-primary"
                  id="download"
                  href={RELEASE}
                  data-mac={t.download.mac}
                  data-win={t.download.win}
                  data-linux={t.download.linux}
                >
                  <Download size={17} strokeWidth={2.1} aria-hidden="true" />
                  <span className="dl-label">{t.download.any}</span>
                </a>
                <a className="btn btn-quiet" href={REPO}>
                  <GitHubMark size={17} />
                  <span>GitHub</span>
                </a>
              </div>
              <p className="meta" data-reveal>
                {t.hero.meta}{" "}
                <a href={INSTALL_DOC}>
                  {t.download.notes}
                  <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
                </a>
              </p>
              <details className="mac-first" id="mac-first" data-reveal>
                <summary>
                  <Info size={15} strokeWidth={2} aria-hidden="true" />
                  <span>{t.macFirst.summary}</span>
                  <ChevronDown className="mac-first-chev" size={15} strokeWidth={2} aria-hidden="true" />
                </summary>
                <div className="mac-first-body">
                  <p>{t.macFirst.brew}</p>
                  <Code copy={t.start.copy} copied={t.start.copied} lines={[BREW]} />
                  <p>{t.macFirst.blocked}</p>
                  <blockquote>{t.macFirst.prompt}</blockquote>
                  <ol>
                    {t.macFirst.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                  <p>{t.macFirst.fallback}</p>
                  <Code copy={t.start.copy} copied={t.start.copied} lines={[XATTR]} />
                </div>
              </details>
            </div>
            <div className="wrap" data-reveal>
              <VideoFigure id="video" base={base} name="six-windows" label={t.video.label} t={t} />
              <p className="video-full">
                <a href={`${base}assets/six-windows.mp4`} target="_blank" rel="noopener">
                  {t.video.full}
                  <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
                </a>
              </p>
            </div>
          </section>

          <section className="section" id="handoff">
            <div className="wrap ho-grid">
              <div className="ho-copy">
                <h2 data-reveal>{t.handoff.title}</h2>
                <p className="sub" data-reveal>
                  {t.handoff.sub}
                </p>
                <ol className="steps" data-reveal>
                  {t.handoff.steps.map((s, i) => (
                    <li key={s.title}>
                      <button type="button" className="step" data-step={i}>
                        <span className="step-n">{i + 1}</span>
                        <span className="step-t">
                          <b>{s.title}</b>
                          <span>{s.body}</span>
                        </span>
                        <span className="step-bar" aria-hidden="true">
                          <i />
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
                <div className="demo-ctl" data-reveal>
                  <button
                    type="button"
                    className="btn btn-small"
                    data-demo="toggle"
                    data-play={t.handoff.play}
                    data-pause={t.handoff.pause}
                  >
                    <Pause className="i-pause" size={14} strokeWidth={2.2} aria-hidden="true" />
                    <Play className="i-play" size={14} strokeWidth={2.2} aria-hidden="true" />
                    <span>{t.handoff.pause}</span>
                  </button>
                  <button type="button" className="btn btn-small" data-demo="replay">
                    <RotateCcw size={14} strokeWidth={2.2} aria-hidden="true" />
                    <span>{t.handoff.replay}</span>
                  </button>
                  <span className="caption">{t.handoff.caption}</span>
                </div>
              </div>
              <div data-reveal>
                <Demo locale={locale} />
              </div>
            </div>
          </section>

          <section className="section" id="harnesses">
            <div className="wrap">
              <header className="sec-head">
                <h2 data-reveal>{t.harness.title}</h2>
                <p className="sub" data-reveal>
                  {t.harness.sub}
                </p>
              </header>
              <ul className="harnesses" data-reveal>
                {HARNESSES.map((h) => (
                  <li className="harness" key={h.name}>
                    <span className="harness-logo">
                      <Logo svg={h.svg} viewBox={h.viewBox} label={h.name} />
                    </span>
                    <span className="harness-name">{h.name}</span>
                  </li>
                ))}
                <li className="harness harness-more">
                  <a href={ACP}>
                    <span className="harness-logo">
                      <LayoutGrid size={26} strokeWidth={1.7} aria-hidden="true" />
                    </span>
                    <span className="harness-name">
                      {t.harness.registry}
                      <small>{t.harness.registryMore}</small>
                    </span>
                    <ArrowUpRight className="harness-arrow" size={15} strokeWidth={2} aria-hidden="true" />
                  </a>
                </li>
              </ul>
            </div>
          </section>

          <section className="section" id="features">
            <div className="wrap">
              <header className="sec-head">
                <h2 data-reveal>{t.features.title}</h2>
                <p className="sub" data-reveal>
                  {t.features.sub}
                </p>
              </header>
              <ul className="cards">
                {t.features.cards.map((c, i) => {
                  const Icon = FEATURE_ICONS[i] ?? Plug;
                  return (
                    <li className="card" key={c.title} data-reveal>
                      <span className="card-ic">
                        <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
                      </span>
                      <h3>{c.title}</h3>
                      <p>{c.body}</p>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>

          <section className="section" id="session-score">
            <div className="wrap">
              <header className="sec-head">
                <h2 data-reveal>{t.score.title}</h2>
                <p className="sub" data-reveal>
                  {t.score.sub}
                </p>
              </header>
              <div data-reveal>
                <VideoFigure id="score-video" base={base} name="session-score" label={t.score.label} t={t} />
                <p className="video-full">
                  <a href={`${base}assets/session-score.mp4`} target="_blank" rel="noopener">
                    {t.video.full}
                    <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
                  </a>
                </p>
              </div>
            </div>
          </section>

          <section className="section" id="start">
            <div className="wrap start-grid">
              <header className="sec-head left">
                <h2 data-reveal>{t.start.title}</h2>
                <p className="sub" data-reveal>
                  {t.start.sub}
                </p>
                <p className="start-links" data-reveal>
                  <a href={INSTALL_DOC}>
                    {t.start.desktop}
                    <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
                  </a>
                  <a href={RELEASE}>
                    v0.3.2
                    <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
                  </a>
                </p>
              </header>
              <div className="start-body" data-reveal>
                <Code
                  copy={t.start.copy}
                  copied={t.start.copied}
                  lines={[
                    "git clone https://github.com/bosshanz/tuantuan.git",
                    "cd tuantuan",
                    "bun install",
                    "bun run dev",
                  ]}
                />
                <p className="note">{t.start.open}</p>
                <p className="note">{t.start.mock}</p>
                <Code copy={t.start.copy} copied={t.start.copied} lines={["TUANTUAN_MOCK_HARNESS=1 bun run dev"]} />
                {t.start.langNote && <p className="note muted">{t.start.langNote}</p>}
              </div>
            </div>
          </section>
        </main>

        <footer className="foot">
          <div className="wrap foot-in">
            <div className="foot-brand">
              <a className="brand" href={rel(locale, locale)} aria-label={t.name}>
                <BrandMark size={22} />
                <span>{t.name}</span>
              </a>
              <p className="tm">{t.footer.trademark}</p>
            </div>
            <nav className="foot-links" aria-label="Footer">
              <a href={`${REPO}/blob/main/${README_FILE[locale]}`}>README</a>
              <a href={`${REPO}/blob/main/docs/README.md`}>{t.footer.docs}</a>
              <a href={RELEASE}>{t.footer.releases}</a>
              <a href={`${REPO}/blob/main/CONTRIBUTING.md`}>{t.footer.contributing}</a>
              <a href={`${REPO}/blob/main/SECURITY.md`}>{t.footer.security}</a>
              <a href={`${REPO}/blob/main/LICENSE`}>{t.footer.license}</a>
            </nav>
            <nav className="foot-langs" aria-label={t.nav.language}>
              {LOCALES.map((l) => (
                <a
                  key={l}
                  href={rel(locale, l)}
                  hrefLang={l}
                  lang={l}
                  data-lang={l}
                  aria-current={l === locale ? "true" : undefined}
                >
                  {LANG_NAME[l]}
                </a>
              ))}
              <span className="copyright">© 2026 bosshanz · MIT</span>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}

function Code({ lines, copy, copied }: { lines: string[]; copy: string; copied: string }) {
  return (
    <div className="code">
      <pre>
        <code>
          {lines.map((l) => (
            <span className="ln" key={l}>
              <span className="prompt" aria-hidden="true">
                $
              </span>
              {l}
            </span>
          ))}
        </code>
      </pre>
      <button
        type="button"
        className="icon-btn copy"
        data-copy={lines.join("\n")}
        data-copied={copied}
        aria-label={copy}
      >
        <Copy className="i-copy" size={15} strokeWidth={2} aria-hidden="true" />
        <Check className="i-done" size={15} strokeWidth={2.4} aria-hidden="true" />
      </button>
    </div>
  );
}
