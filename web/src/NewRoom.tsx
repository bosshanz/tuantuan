import { ChevronLeft, Hash, MessageCircle } from "lucide-react";
import { useState } from "react";
import { type Agent, api, type Room } from "./api";
import { PickList } from "./PickList";
import { AgentAvatar } from "./ui";

export function NewRoom({
  agents,
  onCreated,
  onBack,
}: {
  agents: Agent[];
  onCreated: (r: Room) => void;
  onBack: () => void;
}) {
  const [kind, setKind] = useState<"group" | "dm">("group");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dmAgent = agents.find((a) => a.id === selected[0]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const roomName = name.trim() || (kind === "dm" && dmAgent ? `与 ${dmAgent.name} 私聊` : "");
      onCreated(await api<Room>("POST", "/api/rooms", { name: roomName, kind, agentIds: selected }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <header className="main-head">
        <button type="button" className="btn ghost icon back-btn" onClick={onBack} aria-label="返回">
          <ChevronLeft size={18} />
        </button>
        <div className="title">
          <h2>新建会话</h2>
        </div>
      </header>
      <form className="page" onSubmit={submit}>
        <div className="page-inner" style={{ maxWidth: 600 }}>
          <div className="row wrap-sm">
            {(
              [
                ["group", <Hash key="g" size={18} />, "群聊", "把多个 Agent 拉进来，@ 谁谁回答"],
                ["dm", <MessageCircle key="d" size={18} />, "私聊", "和一个 Agent 一对一，无需 @"],
              ] as const
            ).map(([k, icon, title, sub]) => (
              <label key={k} className="radio-card grow">
                <input
                  type="radio"
                  name="kind"
                  checked={kind === k}
                  onChange={() => {
                    setKind(k);
                    setSelected((s) => (k === "dm" ? s.slice(0, 1) : s));
                  }}
                />
                <span>
                  <span className="rc-title" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {icon}
                    {title}
                  </span>
                  <span className="rc-sub">{sub}</span>
                </span>
              </label>
            ))}
          </div>
          <label className="field">
            <span className="label">名称{kind === "dm" && <span className="muted">（可留空）</span>}</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              placeholder={kind === "dm" ? (dmAgent ? `与 ${dmAgent.name} 私聊` : "与 … 私聊") : "例如：产品研发群"}
            />
          </label>
          <div className="field">
            <span className="label">
              {kind === "group" ? `成员 Agent（已选 ${selected.length}）` : "选择一个 Agent"}
            </span>
            <PickList
              mode={kind === "dm" ? "single" : "multi"}
              searchPlaceholder="搜索 Agent"
              emptyText="还没有 Agent，请先创建。"
              groups={[
                {
                  items: agents.map((a) => ({
                    id: a.id,
                    title: a.name,
                    description: a.identity.slice(0, 80) || (a.harness ? a.harness : "未绑定 Harness"),
                    leading: <AgentAvatar agent={a} size={24} />,
                    plain: true,
                  })),
                },
              ]}
              selected={selected}
              onToggle={(id) =>
                setSelected((s) => (kind === "dm" ? [id] : s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
              }
            />
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div>
            <button
              type="submit"
              className="btn primary"
              disabled={saving || (kind === "dm" ? selected.length !== 1 : name.trim() === "")}
            >
              {saving ? "创建中…" : "创建会话"}
            </button>
            {kind === "group" && name.trim() === "" && (
              <span className="muted" style={{ marginLeft: 12, fontSize: 12 }}>
                请填写群名
              </span>
            )}
          </div>
        </div>
      </form>
    </>
  );
}
