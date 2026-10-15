import { KeyRound, Loader2, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { missingKeyVar } from "../../shared/auth";
import { api } from "./api";
import { CopyLine } from "./Setup";

export interface AuthMethodView {
  id: string;
  name: string;
  description?: string | null;
  type: "agent" | "terminal" | "env";
  command: string | null;
  vars?: string[] | null;
  missing?: string[] | null;
}

/**
 * Sign-in help that doesn't need the harness on PATH: API keys typed here (saved masked in 团团,
 * given only to this harness's processes) and terminal logins opened with the exact absolute command.
 */
export function HarnessAuth(props: {
  harnessId: string;
  methods: AuthMethodView[] | undefined;
  /** saved keys (masked) */
  secretEnv: Record<string, string> | undefined;
  /** after a key change: re-handshake */
  onChanged: () => void | Promise<void>;
}) {
  const envVars = [
    ...new Set([
      ...(props.methods ?? []).filter((m) => m.type === "env").flatMap((m) => m.vars ?? []),
      ...Object.keys(props.secretEnv ?? {}),
    ]),
  ];
  const terminals = (props.methods ?? []).filter((m) => m.type === "terminal" && m.command);
  if (!envVars.length && !terminals.length) return null;
  return (
    <div className="hauth">
      {envVars.map((v) => (
        <KeyField
          key={v}
          harnessId={props.harnessId}
          name={v}
          hint={props.secretEnv?.[v] ?? ""}
          onChanged={props.onChanged}
        />
      ))}
      {terminals.map((m) => (
        <TerminalLogin key={m.id} harnessId={props.harnessId} method={m} />
      ))}
    </div>
  );
}

export function KeyField(props: {
  harnessId: string;
  name: string;
  hint: string;
  onChanged: () => void | Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (v: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      await api("PUT", `/api/harnesses/${encodeURIComponent(props.harnessId)}/env`, { values: { [props.name]: v } });
      setValue("");
      await props.onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="hauth-key"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) void save(value);
      }}
    >
      <KeyRound size={13} className="muted" aria-hidden />
      <code className="hauth-var">{props.name}</code>
      <input
        className="input sm"
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label={props.name}
        placeholder={props.hint ? `已保存 ${props.hint}` : "粘贴 API Key"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" className="btn sm primary" disabled={busy || !value.trim()}>
        {busy && <Loader2 size={13} className="spin" />}
        保存
      </button>
      {props.hint && (
        <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void save(null)}>
          清除
        </button>
      )}
      {err && <span className="error-text">{err}</span>}
    </form>
  );
}

function TerminalLogin({ harnessId, method }: { harnessId: string; method: AuthMethodView }) {
  const [msg, setMsg] = useState<string | null>(null);
  const open = async () => {
    setMsg(null);
    try {
      const r = await api<{ ok: boolean; error: string | null }>(
        "POST",
        `/api/harnesses/${encodeURIComponent(harnessId)}/terminal`,
        { methodId: method.id },
      );
      setMsg(r.ok ? "已在终端打开，完成后回来重新检测" : r.error);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="hauth-term">
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <button type="button" className="btn sm" onClick={() => void open()}>
          <SquareTerminal size={13} />
          在终端中打开「{method.name}」
        </button>
        {msg && <span className="muted hauth-msg">{msg}</span>}
      </div>
      <CopyLine label="命令" text={method.command as string} />
    </div>
  );
}

/** A reply failed because the harness has no API key: say so and let the user fill it in right here. */
export function MissingKey({ harnessId, error }: { harnessId: string | undefined; error: string }) {
  const name = missingKeyVar(error);
  const [saved, setSaved] = useState(false);
  if (name === null || !harnessId) return null;
  return (
    <div className="need-key" role="alert">
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <KeyRound size={14} />
        <b>需要 API Key</b>
        <a className="muted" href="#/harness">
          在 Harness 页管理
        </a>
      </div>
      {name && !saved && <KeyField harnessId={harnessId} name={name} hint="" onChanged={() => setSaved(true)} />}
      {saved && <span className="ok-text">已保存，重新发送消息即可</span>}
    </div>
  );
}
