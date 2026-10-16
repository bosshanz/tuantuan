import { Check, ChevronDown, ChevronLeft, Folder, FolderOpen, Inbox } from "lucide-react";
import { useRef, useState } from "react";
import { type Agent, api, type Project, type Room } from "./api";
import { Popover } from "./ConfigChips";
import { translateError, useI18n } from "./i18n";
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
  const { t: tr } = useI18n();
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
        <button type="button" className="btn ghost icon back-btn" onClick={onBack} aria-label={tr("返回")}>
          <ChevronLeft size={18} />
        </button>
        <div className="title">
          <h2>{tr("新建会话")}</h2>
        </div>
      </header>
      <form className="page" onSubmit={submit}>
        <div className="page-inner form-page" style={{ maxWidth: 600 }}>
          <div className="field">
            <span className="label">
              {tr("项目")}
              <span className="muted">{tr("（可选）")}</span>
            </span>
            <ProjectPicker projects={projects} value={project} onChange={setProject} />
          </div>
          <label className="field">
            <span className="label">
              {tr("名称")}
              <span className="muted">{tr("（可选）")}</span>
            </span>
            <input
              className="input"
              aria-label={tr("会话名称")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              placeholder={autoName || tr("会话名称")}
            />
          </label>
          <div className="field">
            <span className="label">{tr("Agent（已选 {count}）", { count: selected.length })}</span>
            <PickList
              mode="multi"
              searchPlaceholder={tr("搜索 Agent")}
              emptyText={tr("还没有 Agent")}
              groups={[
                {
                  items: agents.map((a) => ({
                    id: a.id,
                    title: a.name,
                    description: a.identity.slice(0, 80) || (a.harness ? a.harness : tr("未绑定 Harness")),
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
                <span className="label">{tr("主 Agent")}</span>
                <select
                  className="select"
                  aria-label={tr("主 Agent")}
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
              {translateError(error)}
            </div>
          )}
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={saving || selected.length === 0}>
              {saving ? tr("创建中…") : tr("创建会话")}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}

const DRAFTS = "drafts";

/** 项目（可选）: "不选项目" files the conversation under 草稿; otherwise a real project. */
export function ProjectPicker(props: {
  projects: Project[];
  value: string;
  onChange: (id: string) => void;
  /** The "no project" entry: its value and wording. Defaults to 草稿. */
  none?: { id: string; label: string; desc: string; hint: string };
  className?: string;
}) {
  const { t: tr } = useI18n();
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const none = props.none ?? {
    id: DRAFTS,
    label: tr("不选项目"),
    desc: tr("放进「草稿」，以后可以移到项目里"),
    hint: tr("放进「草稿」"),
  };
  const DRAFTS_ID = none.id;
  const real = props.projects.filter((p) => p.id !== DRAFTS);
  const current = real.find((p) => p.id === props.value) ?? null;
  const pick = (id: string) => {
    props.onChange(id);
    setOpen(false);
    btn.current?.focus();
  };
  const row = (id: string, icon: React.ReactNode, name: string, desc: string) => (
    <button
      type="button"
      key={id}
      role="option"
      aria-selected={(current?.id ?? DRAFTS_ID) === id}
      className="opt-row"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => pick(id)}
    >
      <span className="opt-icon proj-icon">{icon}</span>
      <span className="opt-text">
        <span className="opt-name">{name}</span>
        {desc && <span className="opt-desc">{desc}</span>}
      </span>
      <Check size={14} className="opt-check" aria-hidden />
    </button>
  );
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`select proj-picker ${props.className ?? ""}`}
        aria-label={tr("项目")}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {current ? <Folder size={15} className="proj-icon" /> : <Inbox size={15} className="proj-icon muted" />}
        <span className={current ? "" : "muted"}>{current ? current.name : none.label}</span>
        {!current && none.hint && <span className="proj-hint">{none.hint}</span>}
        <ChevronDown size={15} className="proj-caret" />
      </button>
      {open && (
        <Popover
          anchor={btn.current}
          onClose={() => setOpen(false)}
          label={tr("选择项目")}
          width={Math.max(btn.current?.offsetWidth ?? 0, 240)}
        >
          <div role="listbox" aria-label={tr("项目")} className="opt-list">
            {row(DRAFTS_ID, <Inbox size={14} />, none.label, none.desc)}
            {real.map((p) =>
              row(p.id, p.id === current?.id ? <FolderOpen size={14} /> : <Folder size={14} />, p.name, p.cwd ?? ""),
            )}
          </div>
        </Popover>
      )}
    </>
  );
}
