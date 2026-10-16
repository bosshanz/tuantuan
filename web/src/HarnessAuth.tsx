import { KeyRound, Loader2, LogIn, SquareTerminal } from "lucide-react";
import { useRef, useState } from "react";
import { missingKeyVar } from "../../shared/auth";
import { api } from "./api";
import { translateError, useI18n } from "./i18n";
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
  /** A missing variable explicitly named by a harness error, even without an env auth method. */
  requiredEnv?: string;
  /** after a key change: re-handshake */
  onChanged: () => void | Promise<void>;
  /** Callers with an ACP login flow can offer the agent's own methods here. */
  onAuthenticate?: (methodId: string) => void | Promise<void>;
  authenticating?: string | null;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const busyChanged = (value: boolean) => {
    setBusy(value);
    props.onBusyChange?.(value);
  };
  const envVars = [
    ...new Set([
      ...(props.methods ?? []).filter((m) => m.type === "env").flatMap((m) => m.vars ?? []),
      ...(props.requiredEnv ? [props.requiredEnv] : []),
      ...Object.keys(props.secretEnv ?? {}),
    ]),
  ];
  const terminals = (props.methods ?? []).filter((m) => m.type === "terminal" && m.command);
  const agents = props.onAuthenticate ? (props.methods ?? []).filter((m) => m.type === "agent") : [];
  const disabled = !!props.disabled || busy;
  if (!envVars.length && !terminals.length && !agents.length) return null;
  return (
    <div className="hauth">
      {envVars.map((v) => (
        <KeyField
          key={v}
          harnessId={props.harnessId}
          name={v}
          hint={props.secretEnv?.[v] ?? ""}
          onChanged={props.onChanged}
          disabled={disabled}
          onBusyChange={busyChanged}
        />
      ))}
      {terminals.map((m) => (
        <TerminalLogin
          key={m.id}
          harnessId={props.harnessId}
          method={m}
          disabled={disabled}
          onBusyChange={busyChanged}
        />
      ))}
      {agents.length > 0 && (
        <div className="auth-actions">
          {agents.map((m) => (
            <button
              key={m.id}
              type="button"
              className="btn sm primary"
              title={m.description ? t(m.description) : undefined}
              disabled={disabled}
              onClick={() => void props.onAuthenticate?.(m.id)}
            >
              {props.authenticating === m.id ? <Loader2 size={13} className="spin" /> : <LogIn size={13} />}
              {t("用「{name}」登录", { name: t(m.name) })}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function KeyField(props: {
  harnessId: string;
  name: string;
  hint: string;
  onChanged: () => void | Promise<void>;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pending = useRef(false);
  const save = async (v: string | null) => {
    if (pending.current || props.disabled) return;
    pending.current = true;
    setBusy(true);
    props.onBusyChange?.(true);
    setErr(null);
    try {
      await api("PUT", `/api/harnesses/${encodeURIComponent(props.harnessId)}/env`, { values: { [props.name]: v } });
      setValue("");
      await props.onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
      props.onBusyChange?.(false);
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
        placeholder={props.hint ? t("已保存 {hint}", { hint: props.hint }) : t("粘贴 API Key")}
        value={value}
        disabled={busy || props.disabled}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" className="btn sm primary" disabled={busy || props.disabled || !value.trim()}>
        {busy && <Loader2 size={13} className="spin" />}
        {t("保存")}
      </button>
      {props.hint && (
        <button
          type="button"
          className="btn ghost sm"
          disabled={busy || props.disabled}
          onClick={() => void save(null)}
        >
          {t("清除")}
        </button>
      )}
      {err && <span className="error-text">{translateError(err)}</span>}
    </form>
  );
}

function TerminalLogin({
  harnessId,
  method,
  disabled,
  onBusyChange,
}: {
  harnessId: string;
  method: AuthMethodView;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const open = async () => {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true);
    onBusyChange(true);
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
    } finally {
      pending.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  };
  return (
    <div className="hauth-term">
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <button type="button" className="btn sm" disabled={disabled || busy} onClick={() => void open()}>
          {busy ? <Loader2 size={13} className="spin" /> : <SquareTerminal size={13} />}
          {t("在终端中打开「{name}」", { name: t(method.name) })}
        </button>
        {msg && <span className="muted hauth-msg">{t(translateError(msg))}</span>}
      </div>
      <CopyLine label={t("命令")} text={method.command as string} />
    </div>
  );
}

/** A reply failed because the harness has no API key: say so and let the user fill it in right here. */
export function MissingKey({ harnessId, error }: { harnessId: string | undefined; error: string }) {
  const { t } = useI18n();
  const name = missingKeyVar(error);
  const [saved, setSaved] = useState(false);
  if (name === null || !harnessId) return null;
  return (
    <div className="need-key" role="alert">
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <KeyRound size={14} />
        <b>{t("需要 API Key")}</b>
        <a className="muted" href="#/harness">
          {t("在 Harness 页管理")}
        </a>
      </div>
      {name && !saved && <KeyField harnessId={harnessId} name={name} hint="" onChanged={() => setSaved(true)} />}
      {saved && <span className="ok-text">{t("已保存，重新发送消息即可")}</span>}
    </div>
  );
}
