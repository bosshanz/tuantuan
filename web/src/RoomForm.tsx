import { useState } from "react";
import { type Agent, api, type Room } from "./api";

export function RoomForm({ agents, onCreated }: { agents: Agent[]; onCreated: (r: Room) => void }) {
  const [kind, setKind] = useState<"group" | "dm">("group");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const toggle = (id: string) =>
    setSelected((s) => (kind === "dm" ? [id] : s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const dmAgent = agents.find((a) => a.id === selected[0]);
      const roomName = name.trim() || (kind === "dm" && dmAgent ? `与 ${dmAgent.name} 私聊` : "");
      onCreated(await api<Room>("POST", "/api/rooms", { name: roomName, kind, agentIds: selected }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h2>新建会话</h2>
      <div className="segmented">
        {(["group", "dm"] as const).map((k) => (
          <button
            type="button"
            key={k}
            className={kind === k ? "on" : ""}
            onClick={() => {
              setKind(k);
              setSelected((s) => (k === "dm" ? s.slice(0, 1) : s));
            }}
          >
            {k === "group" ? "群聊" : "私聊"}
          </button>
        ))}
      </div>
      <p className="hint">
        {kind === "group" ? "群聊里只有被 @ 的 Agent 会回复。" : "私聊里每条消息都会交给这一个 Agent 回复，无需 @。"}
      </p>
      <label>
        名称{kind === "dm" && <span className="muted">（可留空）</span>}
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
      </label>
      <fieldset>
        <legend>{kind === "group" ? "成员 Agent（可多选）" : "选择一个 Agent"}</legend>
        {agents.length === 0 && <p className="hint">还没有 Agent，请先在左侧新建。</p>}
        {agents.map((a) => (
          <label key={a.id} className="check">
            <input
              type={kind === "dm" ? "radio" : "checkbox"}
              name="agents"
              checked={selected.includes(a.id)}
              onChange={() => toggle(a.id)}
            />
            <span className="avatar sm" style={{ background: a.color }}>
              {a.avatar}
            </span>
            {a.name}
          </label>
        ))}
      </fieldset>
      {error && <p className="error-text">{error}</p>}
      <button type="submit" className="primary" disabled={saving || (kind === "dm" && selected.length !== 1)}>
        {saving ? "创建中…" : "创建"}
      </button>
    </form>
  );
}
