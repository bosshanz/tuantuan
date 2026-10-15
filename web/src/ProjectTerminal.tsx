import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { ChevronDown, RotateCcw, SquareTerminal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProjectTerminalEvent, ProjectTerminalMeta } from "../../shared/project-terminal";
import { api, type Project } from "./api";
import "@xterm/xterm/css/xterm.css";

export interface TerminalFocusRequest {
  origin: Element | null;
}

type Connection = "starting" | "connected" | "reconnecting" | "error";

/** One project-owned shell. Hiding the dock never closes its socket or process. */
export default function ProjectTerminal(props: {
  project: Project;
  visible: boolean;
  height: number;
  onHeightChange: (height: number) => void;
  focusRequest: TerminalFocusRequest | null;
  onHide: () => void;
  onEnded: () => void;
}) {
  const { project, visible, height, onHeightChange } = props;
  const dock = useRef<HTMLElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const ready = useRef(false);
  const visibleNow = useRef(visible);
  const focusRequest = useRef(props.focusRequest);
  const focusedRequest = useRef<TerminalFocusRequest | null>(null);
  const focusRequested = useCallback(() => {
    const request = focusRequest.current;
    if (!visibleNow.current || !ready.current || !request || focusedRequest.current === request) return;
    focusedRequest.current = request;
    // Opening is intentional, but a slow lazy load or reconnect must not steal a newer focus choice.
    if (document.activeElement === request.origin) terminal.current?.focus();
  }, []);
  useLayoutEffect(() => {
    visibleNow.current = visible;
    focusRequest.current = props.focusRequest;
    if (terminal.current) terminal.current.options.disableStdin = !visible || !ready.current;
    focusRequested();
  }, [visible, props.focusRequest, focusRequested]);
  const [meta, setMeta] = useState<ProjectTerminalMeta | null>(null);
  const [connection, setConnection] = useState<Connection>("starting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [closing, setClosing] = useState(false);
  const [maxHeight, setMaxHeight] = useState(600);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const endpoint = `/api/projects/${encodeURIComponent(project.id)}/terminal`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly restarts the connection after a user retry.
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
      if (host.clientWidth > 0 && host.clientHeight > 0) fitAddon.fit();
    };
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
      setConnection("error");
      setError(e instanceof Error ? e.message : String(e));
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
          setMeta(message.terminal);
          setError(null);
          setConnection("connected");
          term.reset();
          term.resize(message.terminal.cols, message.terminal.rows);
          term.write(message.output, () => {
            if (disposed) return;
            ready.current = running;
            term.options.disableStdin = !ready.current || !visibleNow.current;
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
          setConnection("connected");
          setError(null);
          setMeta((current) => current && { ...current, status: "exited", exitCode: message.exitCode });
        } else if (message.type === "error" && (running || message.error !== "终端已退出，请重新打开")) {
          fail(new Error(message.error));
        }
      };
      socket.onclose = () => {
        ready.current = false;
        term.options.disableStdin = true;
        if (disposed) return;
        setConnection("reconnecting");
        const delay = Math.min(1000 * 2 ** failures, 5000);
        failures++;
        reconnect = setTimeout(async () => {
          try {
            const current = await api<ProjectTerminalMeta | null>("GET", endpoint);
            if (!current || current.id !== id) {
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
    setConnection("starting");
    setError(null);
    setMeta(null);
    void api<ProjectTerminalMeta>("POST", endpoint, { cols: term.cols, rows: term.rows }).then((opened) => {
      if (disposed) return;
      setMeta(opened);
      connect(opened.id);
    }, fail);
    return () => {
      disposed = true;
      clearTimeout(reconnect);
      socket?.close();
      observer.disconnect();
      themeObserver.disconnect();
      media.removeEventListener("change", theme);
      terminal.current = null;
      ready.current = false;
      term.dispose();
    };
  }, [endpoint, attempt]);

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

  const end = async (restart: boolean) => {
    setClosing(true);
    try {
      if (meta) await api("DELETE", `${endpoint}?terminalId=${encodeURIComponent(meta.id)}`);
      if (restart) setAttempt((value) => value + 1);
      else props.onEnded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClosing(false);
    }
  };
  const status =
    connection === "starting"
      ? "正在打开…"
      : connection === "reconnecting"
        ? "正在重连…"
        : connection === "error"
          ? "连接失败"
          : meta?.status === "exited"
            ? `已退出${meta.exitCode === null ? "" : ` · ${meta.exitCode}`}`
            : "";
  return (
    <section ref={dock} className="project-terminal" style={{ height }} aria-label="项目终端">
      <hr
        className="terminal-resize"
        tabIndex={0}
        aria-label="调整终端高度"
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
        <strong>终端</strong>
        <span className="terminal-context" title={meta?.cwd ?? project.cwd}>
          {project.name}
          <span> / {meta?.shell.split(/[\\/]/).at(-1) ?? "shell"}</span>
        </span>
        <span className="terminal-status" role="status">
          {status}
        </span>
        {(meta?.status === "exited" || connection === "error") && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              if (connection === "error") setAttempt((value) => value + 1);
              else void end(true);
            }}
            disabled={closing}
          >
            <RotateCcw size={14} />
            {connection === "error" ? "重试连接" : "重新打开"}
          </button>
        )}
        <button
          type="button"
          className="btn ghost icon"
          title="结束终端"
          aria-label="结束终端"
          disabled={!meta || closing}
          onClick={() => void end(false)}
        >
          <Trash2 size={15} />
        </button>
        <button
          type="button"
          className="btn ghost icon"
          title="收起终端（Ctrl+`）"
          aria-label="收起终端"
          onClick={props.onHide}
        >
          <ChevronDown size={17} />
        </button>
      </header>
      {error && (
        <div className="terminal-error" role="alert">
          {error}
        </div>
      )}
      <div className="terminal-screen" ref={container} />
    </section>
  );
}
