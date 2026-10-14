import { Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, Room } from "./api";
import { AgentAvatar, RoomIcon } from "./ui";

interface Item {
  key: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
  path: string;
}

export function CommandPalette(props: {
  agents: Agent[];
  rooms: Room[];
  onClose: () => void;
  onGo: (path: string) => void;
  state?: "open" | "closing";
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const returnFocus = useRef<Element | null>(document.activeElement);
  useEffect(() => () => (returnFocus.current as HTMLElement | null)?.focus?.(), []);

  const items = useMemo<Item[]>(() => {
    const all: Item[] = [
      ...props.rooms.map((r) => ({
        key: `r${r.id}`,
        label: r.name,
        hint: "会话",
        icon: <RoomIcon room={r} agents={props.agents} size={24} />,
        path: `c/${r.id}`,
      })),
      ...props.agents.map((a) => ({
        key: `a${a.id}`,
        label: a.name,
        hint: "Agent",
        icon: <AgentAvatar agent={a} size={24} />,
        path: `a/${a.id}`,
      })),
      { key: "new-agent", label: "新建 Agent", hint: "操作", icon: <Plus size={16} />, path: "a/new" },
      { key: "new-room", label: "新建会话", hint: "操作", icon: <Plus size={16} />, path: "c/new" },
    ];
    const s = q.trim().toLowerCase();
    return s ? all.filter((i) => i.label.toLowerCase().includes(s)) : all;
  }, [q, props.agents, props.rooms]);

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const pick = (i: Item | undefined) => i && props.onGo(i.path);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop closes the dialog; Escape is handled on the input
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above
    <div
      className="overlay"
      data-state={props.state ?? "open"}
      onClick={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="快速切换">
        <div className="palette-input">
          <Search size={18} className="muted" />
          <input
            ref={inputRef}
            placeholder="搜索会话、Agent 或操作…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") props.onClose();
              else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const n = items.length || 1;
                setActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(items[active]);
              }
            }}
          />
        </div>
        <div className="palette-list" role="listbox">
          {items.length === 0 && <div className="pick-empty">没有匹配的结果</div>}
          {items.map((it, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              key={it.key}
              className="pop-item"
              onMouseMove={() => setActive(i)}
              onClick={() => pick(it)}
            >
              <span className="pop-icon">{it.icon}</span>
              <span style={{ flex: 1 }}>{it.label}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {it.hint}
              </span>
            </button>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>Enter</kbd> 打开
          </span>
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
        </div>
      </div>
    </div>
  );
}
