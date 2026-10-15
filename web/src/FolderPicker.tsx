import { ChevronRight, Clock, Folder, FolderOpen, GitBranch, Home, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

interface DirEntry {
  name: string;
  path: string;
  git: boolean;
}
interface DirListing {
  path: string;
  parent: string | null;
  crumbs: { name: string; path: string }[];
  dirs: DirEntry[];
  git: boolean;
}
interface Place {
  name: string;
  path: string;
  kind: "home" | "common" | "recent";
}
type PickResult = { path: string } | { cancelled: true } | { unsupported: true };

/**
 * Ask for a folder: the OS dialog when the server can show one (macOS / Linux desktop, later
 * Electrobun), otherwise the in-app browser. Resolves to an absolute path or null when cancelled.
 */
export function useFolderPicker() {
  const [browse, setBrowse] = useState<{ title: string; start?: string; resolve: (p: string | null) => void } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const pick = useCallback(async (title: string, start?: string): Promise<string | null> => {
    setBusy(true);
    try {
      const r = await api<PickResult>("POST", "/api/fs/pick", { title, start }).catch(
        () => ({ unsupported: true }) as PickResult,
      );
      if ("path" in r) return r.path;
      if ("cancelled" in r) return null;
    } finally {
      setBusy(false);
    }
    return new Promise((resolve) => setBrowse({ title, start, resolve }));
  }, []);
  const dialog = browse ? (
    <FolderBrowser
      title={browse.title}
      start={browse.start}
      onClose={(p) => {
        browse.resolve(p);
        setBrowse(null);
      }}
    />
  ) : null;
  return { pick, busy, dialog };
}

/** A chosen folder as a chip with 更改, or a 选择文件夹 button when empty. */
export function FolderField(props: {
  value: string;
  onChange: (path: string) => void;
  title?: string;
  label?: string;
}) {
  const { pick, busy, dialog } = useFolderPicker();
  const choose = async () => {
    const p = await pick(props.title ?? "选择文件夹", props.value || undefined);
    if (p) props.onChange(p);
  };
  return (
    <>
      {props.value ? (
        <div className="folder-chip">
          <FolderOpen size={15} className="folder-chip-icon" />
          <span className="folder-chip-path" title={props.value}>
            <span className="folder-chip-dir">{"\u200e" + props.value.replace(/\/[^/]+$/, "/")}</span>
            <b>{props.value.split("/").pop() || props.value}</b>
          </span>
          <button type="button" className="btn ghost sm" onClick={() => void choose()} disabled={busy}>
            {busy ? <Loader2 size={13} className="spin" /> : "更改"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn folder-choose"
          onClick={() => void choose()}
          disabled={busy}
          aria-label={props.label ?? "选择文件夹"}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <Folder size={14} />}
          选择文件夹…
        </button>
      )}
      {dialog}
    </>
  );
}

function FolderBrowser(props: { title: string; start?: string; onClose: (path: string | null) => void }) {
  const [list, setList] = useState<DirListing | null>(null);
  const [placesList, setPlaces] = useState<Place[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const open = useCallback(
    async (path?: string) => {
      try {
        const q = new URLSearchParams();
        if (path) q.set("path", path);
        if (hidden) q.set("hidden", "1");
        const l = await api<DirListing>("GET", `/api/fs/dirs?${q}`);
        setList(l);
        setActive(0);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [hidden],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: start once; re-list on hidden toggle
  useEffect(() => {
    void open(list?.path ?? props.start);
  }, [open]);
  useEffect(() => listRef.current?.focus(), []);
  useEffect(() => {
    void api<Place[]>("GET", "/api/fs/places").then(setPlaces, () => {});
  }, []);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    const dirs = list?.dirs ?? [];
    if (e.key === "Escape") props.onClose(null);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(dirs.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter" || e.key === "ArrowRight") {
      const d = dirs[active];
      if (d) {
        e.preventDefault();
        void open(d.path);
      }
    } else if ((e.key === "Backspace" || e.key === "ArrowLeft") && list?.parent) {
      e.preventDefault();
      void open(list.parent);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop closes the dialog; Escape is handled in the dialog
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose(null)}
    >
      <div className="modal folder-browser" role="dialog" aria-modal="true" aria-label={props.title} onKeyDown={onKey}>
        <div className="fb-head">
          <h3>{props.title}</h3>
          <button type="button" className="btn ghost icon sm" aria-label="关闭" onClick={() => props.onClose(null)}>
            <X size={16} />
          </button>
        </div>
        <div className="fb-body">
          <nav className="fb-places" aria-label="常用位置">
            {placesList.map((p, i) => (
              <button
                key={p.path}
                type="button"
                className="fb-place"
                aria-current={list?.path === p.path ? "true" : undefined}
                title={p.path}
                onClick={() => void open(p.path)}
              >
                {p.kind === "home" ? (
                  <Home size={14} />
                ) : p.kind === "recent" ? (
                  <Clock size={14} />
                ) : (
                  <Folder size={14} />
                )}
                <span>{p.name}</span>
                {p.kind === "recent" && placesList[i - 1]?.kind !== "recent" && <span className="sr-only">最近</span>}
              </button>
            ))}
          </nav>
          <div className="fb-main">
            <div className="fb-crumbs">
              {list?.crumbs.map((c, i) => (
                <span key={c.path} className="fb-crumb">
                  {i > 0 && <ChevronRight size={12} className="muted" />}
                  <button type="button" onClick={() => void open(c.path)}>
                    {c.name}
                  </button>
                </span>
              ))}
            </div>
            <div className="fb-list" ref={listRef} role="listbox" aria-label="文件夹" tabIndex={0}>
              {!list && !error && (
                <div className="fb-empty">
                  <Loader2 size={14} className="spin" />
                </div>
              )}
              {error && <div className="fb-empty error-text">{error}</div>}
              {list && list.dirs.length === 0 && <div className="fb-empty muted">没有子文件夹</div>}
              {list?.dirs.map((d, i) => (
                <button
                  key={d.path}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-i={i}
                  data-active={i === active || undefined}
                  className="fb-row"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => void open(d.path)}
                >
                  <Folder size={15} className="fb-icon" />
                  <span className="fb-name">{d.name}</span>
                  {d.git && (
                    <span className="badge fb-git">
                      <GitBranch size={11} />
                      git
                    </span>
                  )}
                  <ChevronRight size={14} className="muted" />
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="fb-foot">
          <label className="fb-hidden">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
            显示隐藏
          </label>
          <span className="fb-current mono" title={list?.path}>
            {list?.git && <GitBranch size={12} />}
            {list ? `\u200e${list.path}\u200e` : null}
          </span>
          <button type="button" className="btn sm" onClick={() => props.onClose(null)}>
            取消
          </button>
          <button
            type="button"
            className="btn sm primary"
            disabled={!list}
            onClick={() => list && props.onClose(list.path)}
          >
            选择此文件夹
          </button>
        </div>
      </div>
    </div>
  );
}
