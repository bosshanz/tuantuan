import { AlertTriangle, Keyboard, MessageSquareText, Mic, MicOff, Send, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionState } from "../../../server/device-protocol";
import { type Agent, api, type Message } from "../api";
import { AgentAvatar } from "../ui";
import { type Command, DeviceClient, deviceId } from "./device-client";
import { ACTION_LABEL, ACTION_MS, FACE_LABEL, type Face, RobotFace } from "./RobotFace";
import { type Recognition, recognitionCtor, speak, stopSpeaking, ttsAvailable } from "./speech";

interface Turn {
  id: string;
  role: "user" | "agent";
  text: string;
  status: Message["status"];
  error?: string | null;
}

export function RobotPage(props: {
  agents: Agent[];
  userName: string;
  onOpenConversation: (roomId: string) => void;
  onConversationCreated: () => Promise<void>;
  goCreateAgent: () => void;
}) {
  const { agents } = props;
  const [agentId, setAgentId] = useState(() => {
    const saved = localStorage.getItem("agent-hub:robot-agent");
    return agents.some((a) => a.id === saved) ? (saved as string) : (agents[0]?.id ?? "");
  });
  const agent = agents.find((a) => a.id === agentId);

  if (!agent)
    return (
      <div className="empty">
        <div className="empty-icon">
          <MessageSquareText size={24} />
        </div>
        <h2>先创建一个 Agent</h2>
        <button type="button" className="btn primary" onClick={props.goCreateAgent}>
          创建 Agent
        </button>
      </div>
    );
  return (
    <RobotSession
      key="session"
      agent={agent}
      agents={agents}
      userName={props.userName}
      onAgentChange={(id) => {
        localStorage.setItem("agent-hub:robot-agent", id);
        setAgentId(id);
      }}
      onOpenConversation={props.onOpenConversation}
      onConversationCreated={props.onConversationCreated}
    />
  );
}

function RobotSession(props: {
  agent: Agent;
  agents: Agent[];
  userName: string;
  onAgentChange: (id: string) => void;
  onOpenConversation: (roomId: string) => void;
  onConversationCreated: () => Promise<void>;
}) {
  const { agent } = props;
  const [connected, setConnected] = useState(false);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [expression, setExpression] = useState<{ face: Face; until: number } | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [errorUntil, setErrorUntil] = useState(0);
  const [protocolError, setProtocolError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [ttsOn, setTtsOn] = useState(ttsAvailable());
  const [handsFree, setHandsFree] = useState(false);
  const [text, setText] = useState("");
  const [lastCue, setLastCue] = useState<string | null>(null);
  const [, tick] = useState(0);
  const client = useRef<DeviceClient | null>(null);
  const rec = useRef<Recognition | null>(null);
  const heard = useRef("");
  const ttsOnRef = useRef(ttsOn);
  ttsOnRef.current = ttsOn;
  const handsFreeRef = useRef(handsFree);
  handsFreeRef.current = handsFree;
  const speakingRef = useRef(false);
  const sessionRef = useRef<SessionState>("idle");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const RecognitionImpl = useMemo(() => recognitionCtor(), []);

  const loadHistory = useCallback(async (rid: string) => {
    try {
      const { messages } = await api<{ messages: Message[] }>("GET", `/api/rooms/${rid}/messages?limit=30`);
      setTurns(
        messages
          .filter((m) => m.senderKind !== "system")
          .map((m) => ({
            id: m.id,
            role: m.senderKind === "human" ? "user" : "agent",
            text: m.content,
            status: m.status,
            error: m.error,
          })),
      );
    } catch {
      // History is a convenience; live turns still work. The header shows connection state.
    }
  }, []);

  // One device connection for the lifetime of the page; agent changes are a `bind`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connect once
  useEffect(() => {
    const c = new DeviceClient(
      deviceId(),
      agent.id,
      props.userName,
      {
        onConnection: setConnected,
        onWelcome: (w) => {
          setRoomId(w.roomId);
          setProtocolError(null);
          void loadHistory(w.roomId);
          void props.onConversationCreated();
        },
        onSessionState: (s) => {
          sessionRef.current = s;
          setSession(s);
        },
        onReplyStart: (id) => setTurns((t) => [...t, { id, role: "agent", text: "", status: "streaming" }]),
        onReplyDelta: (id, d) => setTurns((t) => t.map((x) => (x.id === id ? { ...x, text: x.text + d } : x))),
        onReplyEnd: (e) => {
          setTurns((t) => {
            const exists = t.some((x) => x.id === e.messageId);
            const turn = { id: e.messageId, role: "agent" as const, text: e.text, status: e.status, error: e.error };
            return exists ? t.map((x) => (x.id === e.messageId ? turn : x)) : [...t, turn];
          });
          if (e.status === "error") setErrorUntil(Date.now() + 3000);
          if (e.status === "done" && e.text && ttsOnRef.current && ttsAvailable())
            speak(
              e.text,
              () => {
                speakingRef.current = true;
                setSpeaking(true);
              },
              () => {
                speakingRef.current = false;
                setSpeaking(false);
              },
            );
        },
        onCommand: (cmd: Command) => {
          if (cmd.type === "expression") {
            setExpression({ face: cmd.name, until: Date.now() + cmd.durationMs });
            setLastCue(`表情：${FACE_LABEL[cmd.name]}`);
          } else {
            setAction(null);
            requestAnimationFrame(() => setAction(cmd.name));
            setTimeout(() => setAction((a) => (a === cmd.name ? null : a)), ACTION_MS[cmd.name] ?? 1500);
            setLastCue(`动作：${ACTION_LABEL[cmd.name] ?? cmd.name}`);
          }
          return { ok: true };
        },
        onError: (e) => setProtocolError(`${e.code}：${e.message}`),
      },
      { asr: RecognitionImpl !== null, tts: ttsAvailable() },
    );
    client.current = c;
    return () => {
      c.close();
      stopSpeaking();
      rec.current?.abort();
    };
  }, []);

  const firstBind = useRef(true);
  useEffect(() => {
    if (firstBind.current) {
      firstBind.current = false;
      return;
    }
    stopSpeaking();
    setTurns([]);
    client.current?.bind(agent.id);
  }, [agent.id]);

  useEffect(() => {
    client.current?.reportState(listening, speaking);
  }, [listening, speaking]);

  // Re-render when a timed expression/error expires.
  useEffect(() => {
    const until = Math.max(expression?.until ?? 0, errorUntil);
    if (until <= Date.now()) return;
    const t = setTimeout(() => tick((n) => n + 1), until - Date.now() + 20);
    return () => clearTimeout(t);
  }, [expression, errorUntil]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, interim]);

  /** Barge-in: the user takes the floor — stop speech and any reply still in progress. */
  const bargeIn = useCallback(() => {
    if (speakingRef.current) {
      stopSpeaking();
      speakingRef.current = false;
      setSpeaking(false);
    }
    if (sessionRef.current !== "idle") client.current?.interrupt();
  }, []);

  const sendText = (t: string) => {
    const s = t.trim();
    if (!s) return;
    bargeIn();
    if (client.current?.utter(s))
      setTurns((ts) => [...ts, { id: `local-${Date.now()}`, role: "user", text: s, status: "done" }]);
    else setProtocolError("未连接到服务器，消息没有发出");
  };

  const startListening = (continuous: boolean) => {
    if (!RecognitionImpl || rec.current) return;
    bargeIn();
    const r = new RecognitionImpl();
    r.lang = "zh-CN";
    r.continuous = continuous;
    r.interimResults = true;
    heard.current = "";
    r.onspeechstart = bargeIn;
    r.onresult = (e) => {
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!res) continue;
        if (res.isFinal) {
          if (continuous) sendText(res[0].transcript);
          else heard.current += res[0].transcript;
        } else interimText += res[0].transcript;
      }
      if (interimText && speakingRef.current) bargeIn();
      setInterim(interimText);
    };
    r.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") setProtocolError(`语音识别出错：${e.error}`);
    };
    r.onend = () => {
      rec.current = null;
      setInterim("");
      setListening(false);
      if (!continuous && heard.current) sendText(heard.current);
      else if (continuous && handsFreeRef.current) startListening(true);
    };
    rec.current = r;
    setListening(true);
    r.start();
  };
  const stopListening = () => rec.current?.stop();

  // biome-ignore lint/correctness/useExhaustiveDependencies: toggled only by the switch
  useEffect(() => {
    if (handsFree) startListening(true);
    else rec.current?.stop();
  }, [handsFree]);

  // Hold Space to talk (outside text fields).
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable handlers
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || handsFree || !RecognitionImpl) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, button")) return;
      e.preventDefault();
      startListening(false);
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && !handsFree && stopListening();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [handsFree]);

  const now = Date.now();
  const face: Face =
    expression && expression.until > now
      ? expression.face
      : errorUntil > now
        ? "error"
        : listening
          ? "listening"
          : session === "thinking"
            ? "thinking"
            : "idle";
  const talking = speaking || (session === "replying" && !ttsOn);
  const statusLabel = !connected
    ? "未连接"
    : listening
      ? FACE_LABEL.listening
      : talking
        ? FACE_LABEL.speaking
        : session === "thinking"
          ? FACE_LABEL.thinking
          : session === "replying"
            ? "回复中"
            : "待机";

  return (
    <>
      <header className="main-head">
        <AgentAvatar agent={agent} size={32} />
        <div className="title">
          <h2>桌面机器人</h2>
          <div className="sub">
            <span className={`dot ${connected ? "ok" : "bad"}`} />
            {connected ? "设备已连接" : "正在连接…"} · 云端 Agent
          </div>
        </div>
        <label className="sr-only" htmlFor="robot-agent">
          绑定的 Agent
        </label>
        <select
          id="robot-agent"
          className="select"
          style={{ width: "auto", maxWidth: 200 }}
          value={agent.id}
          onChange={(e) => props.onAgentChange(e.target.value)}
        >
          {props.agents.map((a) => (
            <option key={a.id} value={a.id}>
              绑定：{a.name}
            </option>
          ))}
        </select>
        {roomId && (
          <button type="button" className="btn ghost hide-sm" onClick={() => props.onOpenConversation(roomId)}>
            <MessageSquareText size={15} />
            查看会话
          </button>
        )}
      </header>
      <div className="robot-page">
        <div className="robot-stage">
          <div className="robot-status" aria-live="polite">
            <span
              className={`badge ${talking || listening ? "accent" : face === "error" ? "danger" : ""}`}
              data-testid="robot-status"
            >
              {statusLabel}
            </span>
            {lastCue && <span className="badge">{lastCue}</span>}
          </div>
          <RobotFace
            face={face}
            talking={talking}
            action={action}
            tint={agent.color}
            label={`${agent.name} 的机器人，当前${statusLabel}。点击可打断`}
            onClick={bargeIn}
          />
          <div className="robot-controls">
            <label className="switch" title={ttsAvailable() ? "" : "当前浏览器不支持语音合成"}>
              <input
                type="checkbox"
                checked={ttsOn}
                disabled={!ttsAvailable()}
                onChange={(e) => {
                  setTtsOn(e.target.checked);
                  if (!e.target.checked) stopSpeaking();
                }}
              />
              <Volume2 size={15} />
              朗读
            </label>
            <button
              type="button"
              className="ptt"
              aria-pressed={listening}
              disabled={!RecognitionImpl || !connected || handsFree}
              aria-label={RecognitionImpl ? "按住说话" : "当前浏览器不支持语音识别"}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                startListening(false);
              }}
              onPointerUp={stopListening}
              onPointerCancel={stopListening}
            >
              {RecognitionImpl ? <Mic size={28} /> : <MicOff size={26} />}
            </button>
            <label className="switch" title={RecognitionImpl ? "持续聆听，说完自动发送" : "当前浏览器不支持语音识别"}>
              <input
                type="checkbox"
                checked={handsFree}
                disabled={!RecognitionImpl || !connected}
                onChange={(e) => setHandsFree(e.target.checked)}
              />
              免按键
            </label>
          </div>
          <p className="robot-hint">
            {RecognitionImpl ? (handsFree ? "直接说话即可" : "按住说话") : "此浏览器不支持语音，可用文字对话"}
          </p>
          {protocolError && (
            <div className="form-error" role="alert">
              <AlertTriangle size={15} />
              {protocolError}
            </div>
          )}
        </div>
        <aside className="robot-side" aria-label="对话记录">
          <div className="transcript" ref={transcriptRef} aria-live="polite">
            {turns.length === 0 && !interim && <div className="list-empty">说一句「你好」试试</div>}
            {turns.map((t) => (
              <div key={t.id} className={`turn ${t.role} ${t.status === "error" ? "error" : ""}`}>
                {t.text || (t.status === "streaming" ? "…" : "")}
                {t.status === "error" && <div className="turn-meta">{t.error ?? "回复失败"}</div>}
                {t.status === "cancelled" && <div className="turn-meta">已打断</div>}
              </div>
            ))}
            {interim && (
              <div className="turn user" style={{ opacity: 0.6 }}>
                {interim}
              </div>
            )}
          </div>
          <form
            className="robot-input"
            onSubmit={(e) => {
              e.preventDefault();
              sendText(text);
              setText("");
            }}
          >
            <Keyboard size={16} className="muted" style={{ alignSelf: "center", flexShrink: 0 }} />
            <input
              className="input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="输入文字和机器人对话"
              aria-label="文字输入"
              disabled={!connected}
            />
            <button type="submit" className="btn primary icon" disabled={!text.trim() || !connected} aria-label="发送">
              <Send size={15} />
            </button>
          </form>
        </aside>
      </div>
    </>
  );
}
