export {};

/** Landing-page behaviour: OS-aware download label, language menu, hero video, handoff demo, copy buttons. */
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [
  ...root.querySelectorAll<T>(sel),
];

/* ---------- download button follows the visitor's OS ---------- */
function detectOs(): "mac" | "win" | "linux" | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } };
  if (nav.userAgentData?.mobile) return null;
  const p = `${nav.userAgentData?.platform ?? ""} ${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (/iphone|ipad|ipod|android/.test(p)) return null;
  if (/mac/.test(p)) return "mac";
  if (/win/.test(p)) return "win";
  if (/linux|x11|cros/.test(p)) return "linux";
  return null;
}
const dl = $<HTMLAnchorElement>("#download");
const os = detectOs();
if (dl && os) {
  const label = dl.dataset[os];
  const span = $(".dl-label", dl);
  if (label && span) span.textContent = label;
  dl.dataset.os = os;
}

/* ---------- language menu: remember the choice ---------- */
for (const a of $$<HTMLAnchorElement>("a[data-lang]")) {
  a.addEventListener("click", () => {
    try {
      localStorage.setItem("tt-lang", a.dataset.lang ?? "en");
    } catch {}
  });
}
const lang = $("#lang");
const langBtn = lang && $<HTMLButtonElement>(".lang-btn", lang);
const langMenu = lang && $<HTMLUListElement>(".lang-menu", lang);
if (lang && langBtn && langMenu) {
  const set = (open: boolean) => {
    langBtn.setAttribute("aria-expanded", String(open));
    langMenu.hidden = !open;
    lang.classList.toggle("open", open);
    if (open) $<HTMLAnchorElement>("a[aria-current]", langMenu)?.focus();
  };
  langBtn.addEventListener("click", () => set(langMenu.hidden !== false));
  document.addEventListener("click", (e) => {
    if (!lang.contains(e.target as Node)) set(false);
  });
  lang.addEventListener("keydown", (e) => {
    const items = $$<HTMLAnchorElement>("a", langMenu);
    const i = items.indexOf(document.activeElement as HTMLAnchorElement);
    if (e.key === "Escape" && !langMenu.hidden) {
      set(false);
      langBtn.focus();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !langMenu.hidden) {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  });
}

/* ---------- header hairline once the page scrolls ---------- */
const header = $("#top");
const onScroll = () => header?.classList.toggle("scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

/* ---------- reveal on scroll (one-shot) ---------- */
const revealIo = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      revealIo.unobserve(e.target);
    }
  },
  { rootMargin: "0px 0px -8% 0px" },
);
for (const el of $$("[data-reveal]")) revealIo.observe(el);

/* ---------- hero video: muted autoplay in view, never under reduced motion ---------- */
const fig = $("#video");
const video = fig && $<HTMLVideoElement>("video", fig);
if (fig && video) {
  const toggle = $<HTMLButtonElement>('[data-act="toggle"]', fig);
  const sound = $<HTMLButtonElement>('[data-act="sound"]', fig);
  const big = $<HTMLButtonElement>(".video-play", fig);
  let userPaused = false;
  const sync = () => {
    const playing = !video.paused;
    fig.classList.toggle("playing", playing);
    fig.classList.toggle("muted", video.muted);
    if (toggle) toggle.setAttribute("aria-label", (playing ? toggle.dataset.pause : toggle.dataset.play) ?? "");
    if (sound) sound.setAttribute("aria-label", (video.muted ? sound.dataset.on : sound.dataset.off) ?? "");
  };
  const play = () => video.play().catch(() => sync());
  for (const ev of ["play", "pause", "volumechange"]) video.addEventListener(ev, sync);
  const flip = () => {
    userPaused = !video.paused;
    if (video.paused) play();
    else video.pause();
  };
  toggle?.addEventListener("click", flip);
  big?.addEventListener("click", flip);
  video.addEventListener("click", flip);
  sound?.addEventListener("click", () => {
    video.muted = !video.muted;
    if (!video.muted && video.paused) play();
  });
  new IntersectionObserver(
    ([e]) => {
      if (!e) return;
      if (!e.isIntersecting) video.pause();
      else if (!userPaused && !reduceMotion.matches) play();
    },
    { threshold: 0.35 },
  ).observe(fig);
  sync();
}

/* ---------- handoff demo ---------- */
type Expr = "idle" | "working" | "sad" | "happy";
/** Hold time (ms) per phase; phases 0–6 = step 1, 7–12 = step 2, 13–16 = step 3. */
const HOLD = [500, 1000, 1100, 900, 1000, 900, 1700, 500, 420, 420, 420, 700, 1500, 1000, 1900, 900, 4200];
const STEP_START = [0, 7, 13] as const;
/** First phase of step i, or the phase count after the last step. */
const stepStart = (i: number) => STEP_START[i] ?? HOLD.length;
const LAST = HOLD.length - 1;
const exprA = (p: number): Expr =>
  p >= 16 ? "happy" : p >= 13 ? "idle" : p >= 5 ? "sad" : p >= 2 ? "working" : "idle";
const exprB = (p: number): Expr => (p >= 15 ? "happy" : p >= 13 ? "working" : p >= 12 ? "happy" : "idle");
const stepOf = (p: number) => (p >= STEP_START[2] ? 2 : p >= STEP_START[1] ? 1 : 0);

const demo = $("#demo");
if (demo) {
  const section = $("#handoff");
  const steps = $$<HTMLButtonElement>(".step");
  const toggleBtn = $<HTMLButtonElement>('[data-demo="toggle"]');
  const replayBtn = $<HTMLButtonElement>('[data-demo="replay"]');
  const fx = $$("[data-fx]", demo).map((el) => ({
    el,
    rules: (el.dataset.fx ?? "").split(/\s+/).map((r) => {
      const [n, cls] = r.split(":");
      return { n: Number(n), cls: cls ?? "" };
    }),
  }));
  const ats = $$("[data-at]", demo).map((el) => ({ el, n: Number(el.dataset.at) }));
  let phase = LAST;
  let timer = 0;
  let playing = !reduceMotion.matches;
  let inView = false;
  let visible = false;
  let started = 0;
  const updateVisible = () => {
    visible = inView && document.visibilityState === "visible";
  };

  const apply = (p: number, jump = false) => {
    phase = p;
    if (jump) demo.classList.add("jump");
    demo.dataset.phase = String(p);
    for (const { el, n } of ats) el.classList.toggle("on", p >= n);
    for (const { el, rules } of fx) for (const r of rules) el.classList.toggle(r.cls, p >= r.n);
    for (const el of $$("[data-who=a]", demo)) el.dataset.expr = exprA(p);
    for (const el of $$("[data-who=b]", demo)) el.dataset.expr = exprB(p);
    const s = stepOf(p);
    steps.forEach((b, i) => {
      b.classList.toggle("active", i === s);
      b.classList.toggle("done", i < s || (p === LAST && i === s));
      b.setAttribute("aria-current", i === s ? "step" : "false");
    });
    if (jump) requestAnimationFrame(() => requestAnimationFrame(() => demo.classList.remove("jump")));
  };

  /** Step progress bar: CSS animates width over the remaining time of the step. */
  const runBar = (p: number) => {
    const s = stepOf(p);
    const end = stepStart(s + 1);
    const total = HOLD.slice(stepStart(s), end).reduce((a, b) => a + b, 0);
    const left = HOLD.slice(p, end).reduce((a, b) => a + b, 0);
    steps.forEach((b, i) => {
      const bar = $<HTMLElement>(".step-bar i", b);
      if (!bar) return;
      bar.style.transition = "none";
      bar.style.width = i < s ? "100%" : i > s ? "0%" : `${((total - left) / total) * 100}%`;
      if (i === s && playing && visible) {
        void bar.offsetWidth;
        bar.style.transition = `width ${left}ms linear`;
        bar.style.width = "100%";
      }
    });
  };

  const schedule = () => {
    clearTimeout(timer);
    runBar(phase);
    if (!playing || !visible) return;
    timer = window.setTimeout(next, HOLD[phase]);
  };
  const next = () => {
    if (phase >= LAST) {
      demo.classList.add("resetting");
      timer = window.setTimeout(() => {
        apply(0, true);
        demo.classList.remove("resetting");
        schedule();
      }, 450);
      return;
    }
    apply(phase + 1);
    schedule();
  };
  const setPlaying = (on: boolean) => {
    playing = on;
    toggleBtn?.classList.toggle("paused", !on);
    const span = toggleBtn && $("span", toggleBtn);
    if (span && toggleBtn) span.textContent = (on ? toggleBtn.dataset.pause : toggleBtn.dataset.play) ?? "";
    schedule();
  };

  steps.forEach((b, i) => {
    b.addEventListener("click", () => {
      const target = reduceMotion.matches ? stepStart(i + 1) - 1 : stepStart(i);
      apply(target, true);
      schedule();
    });
  });
  toggleBtn?.addEventListener("click", () => {
    if (!playing && phase >= LAST) apply(0, true);
    setPlaying(!playing);
  });
  replayBtn?.addEventListener("click", () => {
    apply(0, true);
    setPlaying(true);
  });

  apply(LAST, true);
  setPlaying(playing);
  if (section) {
    new IntersectionObserver(
      ([e]) => {
        inView = !!e?.isIntersecting;
        updateVisible();
        // First time in view: start the story from the top instead of showing the end state.
        if (visible && !started && playing) {
          started = 1;
          apply(0, true);
        }
        if (!visible) clearTimeout(timer);
        schedule();
      },
      { threshold: 0.3 },
    ).observe(section);
  }
  document.addEventListener("visibilitychange", () => {
    updateVisible();
    if (!visible) clearTimeout(timer);
    schedule();
  });
  reduceMotion.addEventListener("change", () => setPlaying(!reduceMotion.matches));
}

/* ---------- copy buttons ---------- */
for (const b of $$<HTMLButtonElement>("button[data-copy]")) {
  const label = b.getAttribute("aria-label") ?? "";
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.copy ?? "");
      b.classList.add("done");
      b.setAttribute("aria-label", b.dataset.copied ?? label);
      setTimeout(() => {
        b.classList.remove("done");
        b.setAttribute("aria-label", label);
      }, 1600);
    } catch {}
  });
}
