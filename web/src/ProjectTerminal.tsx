import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { ChevronDown, Plus, RotateCcw, SquareTerminal, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProjectTerminalEvent, ProjectTerminalMeta } from "../../shared/project-terminal";
import { api, type Project } from "./api";
import { translateError, useI18n } from "./i18n";
import "@xterm/xterm/css/xterm.css";

export interface TerminalFocusRequest {
  origin: Element | null;
}

type Connection = "starting" | "connected" | "reconnecting" | "error";
type Session = { meta: ProjectTerminalMeta; connection: Connection; error: string | null; attempt: number };
const newSession = (meta: ProjectTerminalMeta): Session => ({ meta, connection: "starting", error: null, attempt: 0 });
const tabId = (id: string) => `terminal-tab-${id}`;
const panelId = (id: string) => `terminal-panel-${id}`;

/** Project-owned shells retain their sockets, screens and processes while hidden. */
export default function ProjectTerminal(props: {
  project: Project;
  visible: boolean;
  height: number;
  onHeightChange: (height: number) => void;
  focusRequest: TerminalFocusRequest | null;
  onHide: () => void;
  onEnded: () => void;
}) {
  const { t: tr } = useI18n();
  const { project, visible, height, onHeightChange } = props;
  const dock = useRef<HTMLElement>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const sessionsNow = useRef(sessions);
  const activeNow = useRef(active);
  const [focusRequest, setFocusRequest] = useState(props.focusRequest);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const creatingNow = useRef(false);
  const [closing, setClosing] = useState<{ id: string; restart: boolean } | null>(null);
  const [maxHeight, setMaxHeight] = useState(600);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const endpoint = `/api/projects/${encodeURIComponent(project.id)}/terminal`;
  const selected = sessions.find((session) => session.meta.id === active);
  useLayoutEffect(() => {
    sessionsNow.current = sessions;
    activeNow.current = active;
  }, [sessions, active]);
  useLayoutEffect(() => setFocusRequest(props.focusRequest), [props.focusRequest]);
  const select = (id: string, focus = true) => {
    setActive(id);
    setFocusRequest(focus ? { origin: document.activeElement } : null);
  };
  useEffect(() => {
    if (!active) return;
    document.getElementById(tabId(active))?.scrollIntoView({ block: "nearest", inline: "nearest" });
    try {
      sessionStorage.setItem(`tuantuan.terminal.active.${project.id}`, active);
    } catch {
      /* Private browsing may disable session storage. */
    }
  }, [active, project.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries loading the project sessions.
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        let terminals = await api<ProjectTerminalMeta[]>("GET", `${endpoint}?all=1`);
        if (!terminals.length) terminals = [await api<ProjectTerminalMeta>("POST", endpoint)];
        if (disposed) return;
        let remembered: string | null = null;
        try {
          remembered = sessionStorage.getItem(`tuantuan.terminal.active.${project.id}`);
        } catch {
          /* Private browsing may disable session storage. */
        }
        setSessions(terminals.map(newSession));
        setActive(terminals.find((terminal) => terminal.id === remembered)?.id ?? terminals[0]?.id ?? null);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [endpoint, project.id, attempt]);
  const update = useCallback((id: string, patch: Partial<Session>) => {
    setSessions((current) => current.map((session) => (session.meta.id === id ? { ...session, ...patch } : session)));
  }, []);
  const add = async () => {
    if (creatingNow.current) return;
    creatingNow.current = true;
    setCreating(true);
    setError(null);
    const origin = document.activeElement;
    try {
      const meta = await api<ProjectTerminalMeta>("POST", endpoint, { create: true });
      setSessions((current) => [...current, newSession(meta)]);
      setActive(meta.id);
      setFocusRequest({ origin });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      creatingNow.current = false;
      setCreating(false);
    }
  };
  const end = async (id: string, restart = false) => {
    setClosing({ id, restart });
    setError(null);
    const origin = document.activeElement;
    let remaining: Session[] | null = null;
    try {
      await api("DELETE", `${endpoint}?terminalId=${encodeURIComponent(id)}`);
      const index = sessionsNow.current.findIndex((session) => session.meta.id === id);
      remaining = sessionsNow.current.filter((session) => session.meta.id !== id);
      if (restart) {
        // Remove the exited tab first so a failed replacement never leaves a dead tab registered.
        setSessions(remaining);
        const meta = await api<ProjectTerminalMeta>("POST", endpoint, { create: true });
        setSessions((current) => {
          const next = [...current];
          next.splice(index, 0, newSession(meta));
          return next;
        });
        if (activeNow.current === id) {
          const ownsFocus =
            document.activeElement === origin ||
            (document.activeElement === document.body &&
              origin instanceof HTMLButtonElement &&
              (!origin.isConnected || origin.disabled));
          setActive(meta.id);
          setFocusRequest(ownsFocus ? { origin: document.activeElement } : null);
        }
      } else {
        const next = remaining[Math.min(index, remaining.length - 1)];
        // Disabling the clicked close button can move focus to body while the request runs.
        const ownsFocus =
          document.activeElement === origin ||
          (document.activeElement === document.body && origin instanceof HTMLButtonElement && origin.disabled);
        if (activeNow.current === id && next) {
          if (ownsFocus) document.getElementById(tabId(next.meta.id))?.focus();
          select(next.meta.id, document.activeElement === document.getElementById(tabId(next.meta.id)));
        }
        if (remaining.length) setSessions(remaining);
        else {
          if (ownsFocus) dock.current?.querySelector<HTMLButtonElement>("[data-terminal-hide]")?.focus();
          props.onEnded();
        }
      }
    } catch (e) {
      setError((e as Error).message);
      // A restart can fail after the old shell was removed. Keep surviving tabs usable.
      if (remaining && activeNow.current === id) setActive(remaining[0]?.meta.id ?? null);
    } finally {
      setClosing(null);
    }
  };
  useEffect(() => {
    const workspace = dock.current?.closest(".conversation-workspace");
    if (!workspace) return;
    const observer = new ResizeObserver(() => {
      const max = Math.max(180, Math.min(720, workspace.clientHeight - 260));
      setMaxHeight(max);
      if (height > max) onHeightChange(max);
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [height, onHeightChange]);

  const restarting = !!closing?.restart && (!selected || active === closing.id);
  const inputReady =
    visible &&
    !!selected &&
    selected.connection === "connected" &&
    selected.meta.status === "running" &&
    !loading &&
    !creating &&
    closing?.id !== active;
  const status =
    loading || creating || restarting
      ? tr("正在打开…")
      : selected?.connection === "starting"
        ? tr("正在打开…")
        : selected?.connection === "reconnecting"
          ? tr("正在重连…")
          : selected?.connection === "error"
            ? tr("连接失败")
            : selected?.meta.status === "exited"
              ? `${tr("已退出")}${selected.meta.exitCode === null ? "" : ` · ${selected.meta.exitCode}`}`
              : "";
  return (
    <section
      ref={dock}
      className="project-terminal"
      style={{ height }}
      aria-label={tr("项目终端")}
      aria-busy={
        loading ||
        creating ||
        restarting ||
        selected?.connection === "starting" ||
        selected?.connection === "reconnecting"
      }
      data-ready={inputReady || undefined}
    >
      <hr
        className="terminal-resize"
        tabIndex={0}
        aria-label={tr("调整终端高度")}
        aria-orientation="horizontal"
        aria-valuemin={180}
        aria-valuemax={maxHeight}
        aria-valuenow={height}
        onPointerDown={(event) => {
          drag.current = { y: event.clientY, height };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (drag.current)
            onHeightChange(Math.max(180, Math.min(maxHeight, drag.current.height + drag.current.y - event.clientY)));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          onHeightChange(
            event.key === "Home"
              ? 180
              : event.key === "End"
                ? maxHeight
                : Math.max(180, Math.min(maxHeight, height + (event.key === "ArrowUp" ? 20 : -20))),
          );
        }}
      />
      <header className="terminal-head">
        <SquareTerminal size={16} />
        <div className="terminal-tabs" role="tablist" aria-label={tr("项目终端会话")}>
          {sessions.map((session, index) => (
            <div key={session.meta.id} className="terminal-tab" data-active={active === session.meta.id || undefined}>
              <button
                type="button"
                role="tab"
                id={tabId(session.meta.id)}
                aria-controls={panelId(session.meta.id)}
                aria-selected={active === session.meta.id}
                tabIndex={active === session.meta.id ? 0 : -1}
                onClick={() => select(session.meta.id)}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    sessions[
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? sessions.length - 1
                          : (index + (event.key === "ArrowRight" ? 1 : -1) + sessions.length) % sessions.length
                    ];
                  if (next) {
                    document.getElementById(tabId(next.meta.id))?.focus();
                    select(next.meta.id, false);
                  }
                }}
              >
                {tr("终端 {count}", { count: session.meta.number })}
              </button>
              <button
                type="button"
                className="terminal-tab-close"
                aria-label={tr("关闭终端 {count}", { count: session.meta.number })}
                title={tr("关闭终端 {count}", { count: session.meta.number })}
                disabled={closing !== null || creating}
                onClick={() => void end(session.meta.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn ghost icon"
          aria-label={tr("新建终端")}
          title={tr("新建终端")}
          aria-busy={creating || undefined}
          disabled={loading || closing !== null}
          onClick={() => void add()}
        >
          <Plus size={16} />
        </button>
        <span className="terminal-context" title={selected?.meta.cwd ?? project.cwd}>
          {project.name}
          <span> / {selected?.meta.shell.split(/[\\/]/).at(-1) ?? "shell"}</span>
        </span>
        <span className="terminal-status" role="status">
          {status}
        </span>
        {((selected && (selected.meta.status === "exited" || selected.connection === "error")) ||
          (!loading && !sessions.length)) && (
          <button
            type="button"
            className="btn ghost sm"
            disabled={closing !== null || creating}
            onClick={() => {
              if (!selected) setAttempt((value) => value + 1);
              else if (selected.connection === "error") update(selected.meta.id, { attempt: selected.attempt + 1 });
              else void end(selected.meta.id, true);
            }}
          >
            <RotateCcw size={14} />
            {selected?.meta.status === "exited" ? tr("重新打开") : tr("重试连接")}
          </button>
        )}
        <button
          type="button"
          className="btn ghost icon"
          title={tr("结束终端")}
          aria-label={tr("结束终端")}
          disabled={!selected || closing !== null || creating}
          onClick={() => selected && void end(selected.meta.id)}
        >
          <Trash2 size={15} />
        </button>
        <button
          type="button"
          className="btn ghost icon"
          title={tr("收起终端（Ctrl+`）")}
          aria-label={tr("收起终端")}
          data-terminal-hide
          onClick={props.onHide}
        >
          <ChevronDown size={17} />
        </button>
      </header>
      {error && (
        <div className="terminal-error" role="alert">
          {translateError(error)}
        </div>
      )}
      <div className="terminal-sessions">
        {sessions.map((session) => (
          <TerminalSession
            key={session.meta.id}
            session={session}
            endpoint={endpoint}
            active={active === session.meta.id}
            visible={visible && active === session.meta.id}
            focusRequest={active === session.meta.id ? focusRequest : null}
            onState={update}
          />
        ))}
      </div>
    </section>
  );
}

function TerminalSession({
  session,
  endpoint,
  active,
  visible,
  focusRequest: requestedFocus,
  onState,
}: {
  session: Session;
  endpoint: string;
  active: boolean;
  visible: boolean;
  focusRequest: TerminalFocusRequest | null;
  onState: (id: string, patch: Partial<Session>) => void;
}) {
  const { t: tr } = useI18n();
  const { meta } = session;
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<() => void>(() => {});
  const ready = useRef(false);
  const visibleNow = useRef(visible);
  const focusRequest = useRef(requestedFocus);
  const focusedRequest = useRef<TerminalFocusRequest | null>(null);
  const focusRequested = useCallback(() => {
    const request = focusRequest.current;
    if (!visibleNow.current || !ready.current || !request || focusedRequest.current === request) return;
    focusedRequest.current = request;
    if (document.activeElement === request.origin) terminal.current?.focus();
  }, []);
  useLayoutEffect(() => {
    visibleNow.current = visible;
    focusRequest.current = requestedFocus;
    if (terminal.current) terminal.current.options.disableStdin = !visible || !ready.current;
    if (visible) fit.current();
    focusRequested();
  }, [visible, requestedFocus, focusRequested]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the session ID and retry counter own this connection; metadata updates do not replace it.
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    ready.current = false;
    let running = false;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      screenReaderMode: true,
      disableStdin: true,
      allowTransparency: false,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);
    terminal.current = term;
    const theme = () => {
      const css = getComputedStyle(host);
      const dark =
        document.documentElement.dataset.theme === "dark" ||
        (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
      term.options.theme = {
        background: css.getPropertyValue("--surface").trim(),
        foreground: css.getPropertyValue("--text").trim(),
        cursor: css.getPropertyValue("--text").trim(),
        selectionBackground: dark ? "#ffffff33" : "#18181a22",
        black: dark ? "#34343a" : "#25252a",
        red: dark ? "#ff7b72" : "#b42318",
        green: dark ? "#7ee787" : "#167044",
        yellow: dark ? "#e3b341" : "#8a6200",
        blue: dark ? "#79c0ff" : "#175eb8",
        magenta: dark ? "#d2a8ff" : "#8449a7",
        cyan: dark ? "#76e3ea" : "#067280",
        white: dark ? "#dedee3" : "#6d6d75",
        brightBlack: "#858590",
        brightRed: dark ? "#ffa198" : "#bf3434",
        brightGreen: dark ? "#aff5b4" : "#20844c",
        brightYellow: dark ? "#f8d96c" : "#936d0c",
        brightBlue: dark ? "#a5d6ff" : "#286dc7",
        brightMagenta: dark ? "#e2c5ff" : "#9154b5",
        brightCyan: dark ? "#b3f0ff" : "#167f8e",
        brightWhite: dark ? "#ffffff" : "#44444b",
      };
    };
    theme();
    const themeObserver = new MutationObserver(theme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", theme);
    const resize = () => {
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        fitAddon.fit();
        term.refresh(0, term.rows - 1);
      }
    };
    fit.current = resize;
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    term.onResize(({ cols, rows }) => {
      if (ready.current && socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    term.onData((data) => {
      if (!ready.current || !visibleNow.current || socket?.readyState !== WebSocket.OPEN) return;
      // Paste can be larger than one frame. Do not split a Unicode surrogate pair.
      for (let start = 0; start < data.length; ) {
        let end = Math.min(start + 4096, data.length);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1] ?? "")) end--;
        socket.send(JSON.stringify({ type: "input", data: data.slice(start, end) }));
        start = end;
      }
    });
    const fail = (e: unknown) => {
      if (disposed) return;
      ready.current = false;
      term.options.disableStdin = true;
      onState(meta.id, { connection: "error", error: e instanceof Error ? e.message : String(e) });
    };
    const connect = (id: string) => {
      if (disposed) return;
      socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/terminal/${id}`);
      socket.onmessage = (event) => {
        if (disposed) return;
        const message = JSON.parse(event.data) as ProjectTerminalEvent;
        if (message.type === "snapshot") {
          running = message.terminal.status === "running";
          failures = 0;
          currentMeta = message.terminal;
          onState(meta.id, { meta: currentMeta, error: null });
          term.reset();
          term.resize(message.terminal.cols, message.terminal.rows);
          term.write(message.output, () => {
            if (disposed) return;
            ready.current = running;
            term.options.disableStdin = !ready.current || !visibleNow.current;
            onState(meta.id, { connection: "connected" });
            resize();
            if (ready.current && socket?.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
            focusRequested();
          });
        } else if (message.type === "output") term.write(message.data);
        else if (message.type === "exit") {
          running = false;
          ready.current = false;
          term.options.disableStdin = true;
          // Exit is authoritative: late input/resize acknowledgements may have reported the closing PTY first.
          currentMeta = { ...currentMeta, status: "exited", exitCode: message.exitCode };
          onState(meta.id, { meta: currentMeta, error: null, connection: "connected" });
        } else if (message.type === "error" && (running || message.error !== "终端已退出，请重新打开")) {
          fail(new Error(message.error));
        }
      };
      socket.onclose = () => {
        ready.current = false;
        term.options.disableStdin = true;
        if (disposed) return;
        onState(meta.id, { connection: "reconnecting" });
        const delay = Math.min(1000 * 2 ** failures, 5000);
        failures++;
        reconnect = setTimeout(async () => {
          try {
            const current = await api<ProjectTerminalMeta[]>("GET", `${endpoint}?all=1`);
            if (!current.some((terminal) => terminal.id === id)) {
              fail(new Error("终端已结束，请重新打开。"));
              return;
            }
            connect(id);
          } catch (e) {
            if (failures >= 3) fail(e);
            else connect(id);
          }
        }, delay);
      };
    };
    onState(meta.id, { connection: "starting", error: null });
    let currentMeta = meta;
    connect(meta.id);
    return () => {
      disposed = true;
      clearTimeout(reconnect);
      socket?.close();
      observer.disconnect();
      themeObserver.disconnect();
      media.removeEventListener("change", theme);
      terminal.current = null;
      fit.current = () => {};
      ready.current = false;
      term.dispose();
    };
  }, [endpoint, meta.id, session.attempt, focusRequested, onState]);

  useEffect(() => {
    Terminal.strings.promptLabel = tr("终端输入");
    Terminal.strings.tooMuchOutput = tr("输出过多，已暂停朗读，请手动浏览各行");
    terminal.current?.textarea?.setAttribute("aria-label", Terminal.strings.promptLabel);
  }, [tr]);

  return (
    <div
      className="terminal-session"
      id={panelId(meta.id)}
      role="tabpanel"
      aria-labelledby={tabId(meta.id)}
      hidden={!active}
      inert={!active}
      aria-hidden={!active}
    >
      {session.error && (
        <div className="terminal-error" role="alert">
          {translateError(session.error)}
        </div>
      )}
      <div className="terminal-screen" ref={container} />
    </div>
  );
}
