import { ChevronLeft, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Project } from "./api";

function DirField(props: {
  pick: boolean;
  setPick: (v: boolean) => void;
  cwd: string;
  setCwd: (v: string) => void;
  preview: string;
}) {
  return (
    <div className="field">
      <span className="label">目录</span>
      <fieldset className="segmented" aria-label="目录">
        <button type="button" aria-pressed={!props.pick} onClick={() => props.setPick(false)}>
          新建目录
        </button>
        <button type="button" aria-pressed={props.pick} onClick={() => props.setPick(true)}>
          选择已有
        </button>
      </fieldset>
      {props.pick ? (
        <input
          className="input mono"
          aria-label="文件夹路径"
          value={props.cwd}
          onChange={(e) => props.setCwd(e.target.value)}
          maxLength={1024}
          placeholder="~/code/my-project"
          spellCheck={false}
        />
      ) : (
        <span className="muted mono dir-preview">{props.preview}</span>
      )}
    </div>
  );
}

function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return s || "project";
}

export function NewProject(props: { workspacesRoot: string; onCreated: (p: Project) => void; onBack: () => void }) {
  const [name, setName] = useState("");
  const [pick, setPick] = useState(false);
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      props.onCreated(await api<Project>("POST", "/api/projects", { name, ...(pick && { cwd: cwd.trim() }) }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <header className="main-head">
        <button type="button" className="btn ghost icon back-btn" onClick={props.onBack} aria-label="返回">
          <ChevronLeft size={18} />
        </button>
        <div className="title">
          <h2>新建项目</h2>
        </div>
      </header>
      <form className="page" onSubmit={submit}>
        <div className="page-inner form-page" style={{ maxWidth: 600 }}>
          <label className="field">
            <span className="label">名称</span>
            <input
              className="input"
              aria-label="项目名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              placeholder="my-app"
            />
          </label>
          <DirField
            pick={pick}
            setPick={setPick}
            cwd={cwd}
            setCwd={setCwd}
            preview={`${props.workspacesRoot}/${slug(name)}`}
          />
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={saving || !name.trim() || (pick && !cwd.trim())}>
              {saving ? "创建中…" : "创建项目"}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}

export function ProjectSettings(props: {
  project: Project;
  conversations: number;
  onChange: () => Promise<void>;
  onDeleted: () => void;
  onBack: () => void;
}) {
  const { project } = props;
  const [name, setName] = useState(project.name);
  const [cwd, setCwd] = useState(project.cwd);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setName(project.name);
    setCwd(project.cwd);
  }, [project.name, project.cwd]);
  const dirty = name.trim() !== project.name || cwd.trim() !== project.cwd;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const dirChanged = cwd.trim() !== project.cwd;
    if (
      dirChanged &&
      props.conversations > 0 &&
      !confirm(`更换目录会重置 ${props.conversations} 个会话的 Agent 上下文。继续？`)
    )
      return;
    setSaving(true);
    setError(null);
    try {
      await api("PATCH", `/api/projects/${project.id}`, {
        ...(name.trim() !== project.name && { name }),
        ...(dirChanged && { cwd: cwd.trim() }),
      });
      await props.onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!confirm(`删除项目「${project.name}」及其 ${props.conversations} 个会话？目录中的文件不会删除。`)) return;
    try {
      await api("DELETE", `/api/projects/${project.id}`);
      props.onDeleted();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <header className="main-head">
        <button type="button" className="btn ghost icon back-btn" onClick={props.onBack} aria-label="返回">
          <ChevronLeft size={18} />
        </button>
        <div className="title">
          <h2>{project.name}</h2>
          <span className="sub mono">{project.cwd}</span>
        </div>
      </header>
      <form className="page" onSubmit={save}>
        <div className="page-inner form-page" style={{ maxWidth: 600 }}>
          <label className="field">
            <span className="label">名称</span>
            <input
              className="input"
              aria-label="项目名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
            />
          </label>
          <label className="field">
            <span className="label">目录</span>
            <input
              className="input mono"
              aria-label="项目目录"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              maxLength={1024}
              spellCheck={false}
            />
          </label>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={saving || !dirty || !name.trim() || !cwd.trim()}>
              {saving ? "保存中…" : "保存"}
            </button>
            {project.id !== "drafts" && (
              <button type="button" className="btn ghost danger" onClick={() => void remove()}>
                <Trash2 size={14} />
                删除项目
              </button>
            )}
          </div>
        </div>
      </form>
    </>
  );
}
