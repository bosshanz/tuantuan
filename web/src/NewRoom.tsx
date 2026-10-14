import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { type Agent, api, type Project, type Room } from "./api";
import { PickList } from "./PickList";
import { AgentAvatar } from "./ui";

export function NewRoom({
  agents,
  projects,
  projectId,
  onCreated,
  onBack,
}: {
  agents: Agent[];
  projects: Project[];
  projectId: string;
  onCreated: (r: Room) => void;
  onBack: () => void;
}) {
  const [project, setProject] = useState(projectId);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [main, setMain] = useState<string>("");
  const mainId = selected.includes(main) ? main : (selected[0] ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const autoName = selected.map((id) => agents.find((a) => a.id === id)?.name ?? "").join("、");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onCreated(
        await api<Room>("POST", "/api/rooms", {
          name: (name.trim() || autoName).slice(0, 64),
          agentIds: selected,
          mainAgentId: mainId || null,
          projectId: project,
        }),
      );
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
        <div className="page-inner form-page" style={{ maxWidth: 600 }}>
          <label className="field">
            <span className="label">项目</span>
            <select className="select" aria-label="项目" value={project} onChange={(e) => setProject(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">
              名称<span className="muted">（可选）</span>
            </span>
            <input
              className="input"
              aria-label="会话名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              placeholder={autoName || "会话名称"}
            />
          </label>
          <div className="field">
            <span className="label">Agent（已选 {selected.length}）</span>
            <PickList
              mode="multi"
              searchPlaceholder="搜索 Agent"
              emptyText="还没有 Agent"
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
              onToggle={(id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
            />
          </div>
          <div className={`collapse${selected.length > 1 ? " open" : ""}`}>
            <div>
              <label className="field">
                <span className="label">主 Agent</span>
                <select
                  className="select"
                  aria-label="主 Agent"
                  value={mainId}
                  onChange={(e) => setMain(e.target.value)}
                  tabIndex={selected.length > 1 ? 0 : -1}
                >
                  {selected.map((id) => (
                    <option key={id} value={id}>
                      {agents.find((a) => a.id === id)?.name ?? id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={saving || selected.length === 0}>
              {saving ? "创建中…" : "创建会话"}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
