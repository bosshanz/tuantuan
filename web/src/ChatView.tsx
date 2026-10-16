import {
  AlertTriangle,
  ArrowRightLeft,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  Clock3,
  History,
  PanelRight,
  Plus,
  Square,
  SquareTerminal,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { canQuoteMessage, type MessageQuote, messageQuote } from "../../shared/messageQuote";
import "./messageQuote.css";
import "./chatTasks.css";
import type { ReplayTurn, Timeline } from "../../shared/timeline";
import {
  type Agent,
  ApiError,
  api,
  type Message,
  type Project,
  type Room,
  type RoomState,
  type SessionView,
  type TerminalSnapshot,
  type WsEvent,
} from "./api";
import { agentActivity, messageExpression } from "./avatarState";
import { SessionChips } from "./ConfigChips";
import { type ChatSnapshot, chatReducer, emptyChat } from "./chatState";
import type { Opt } from "./config";
import { CtxUsage, PermissionDialog, TimelineView } from "./Harness";
import { MissingKey } from "./HarnessAuth";
import { MessageActions } from "./MessageActions";
import { reducedMotion, usePresence } from "./motion";
import { PickList } from "./PickList";
import type { TerminalFocusRequest } from "./ProjectTerminal";
import { insertSkill, matchingSkills, skillTokenAt } from "./skillCompletion";
import { AgentAvatar, formatTime, HumanAvatar, MessageMarkdown, RoomIcon, roomSubtitle, useMediaQuery } from "./ui";

const GROUP_GAP_MS = 5 * 60 * 1000;
const ProjectTerminal = lazy(() => import("./ProjectTerminal"));

function terminalWasOpen(projectId: string | null) {
  if (!projectId) return false;
  try {
    return sessionStorage.getItem(`tuantuan.terminal.${projectId}`) === "open";
  } catch {
    return false;
  }
}

interface ImageAttachment {
  mimeType: string;
  data: string;
}

function readImage(f: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ mimeType: f.type, data: String(r.result).replace(/^data:[^,]*,/, "") });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

export function ChatView(props: {
  room: Room;
  project: Project | null;
  agents: Agent[];
  userName: string;
  harnessName: (id: string) => string;
  subscribeEvents: (fn: (e: WsEvent) => void) => () => void;
  onBack: () => void;
  onRoomChange: () => Promise<void>;
  onDeleted: () => void;
}) {
  const { room, agents } = props;
  const [{ messages, state, sessions, asks, terminals }, dispatch] = useReducer(chatReducer, room.id, emptyChat);
  const [answers, setAnswers] = useState<Record<string, { pending: boolean; error: string | null }>>({});
  const pendingAnswers = useRef(new Set<string>());
  const [cancellations, setCancellations] = useState<Record<string, { pending: boolean; error: string | null }>>({});
  const pendingCancellations = useRef(new Set<string>());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [replay, setReplay] = useState<ReplayTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [quote, setQuote] = useState<MessageQuote | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const wide = useMediaQuery("(min-width: 1181px)");
  const [panel, setPanel] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(() => terminalWasOpen(room.projectId));
  const [terminalMounted, setTerminalMounted] = useState(terminalOpen);
  const [terminalHeight, setTerminalHeight] = useState(280);
  const [terminalEpoch, setTerminalEpoch] = useState(0);
  const [terminalFocusRequest, setTerminalFocusRequest] = useState<TerminalFocusRequest | null>(null);
  const terminalEnding = useRef(false);
  const terminalSlot = useRef<HTMLDivElement>(null);
  const terminalButton = useRef<HTMLButtonElement>(null);
  const showTerminal = useCallback(
    (open: boolean) => {
      const list = listRef.current;
      if (list) followBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
      setTerminalOpen(open);
      if (open) {
        if (terminalEnding.current) {
          terminalEnding.current = false;
          setTerminalEpoch((value) => value + 1);
        }
        setTerminalMounted(true);
        setTerminalFocusRequest({ origin: document.activeElement });
      } else setTerminalFocusRequest(null);
      try {
        sessionStorage.setItem(`tuantuan.terminal.${room.projectId}`, open ? "open" : "closed");
      } catch {
        /* Private browsing may disable session storage. */
      }
      if (!open && terminalSlot.current?.contains(document.activeElement)) terminalButton.current?.focus();
    },
    [room.projectId],
  );
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.code === "Backquote" && !event.isComposing && props.project) {
        event.preventDefault();
        event.stopPropagation();
        showTerminal(!terminalOpen);
      }
    };
    window.addEventListener("keydown", toggle, true);
    return () => window.removeEventListener("keydown", toggle, true);
  }, [terminalOpen, props.project, showTerminal]);
  const panelPresence = usePresence(panel, 180);
  const listRef = useRef<HTMLDivElement>(null);
  const taskDisclosure = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  const followBottom = useRef(true);
  // Content or size changes move the edges without a scroll event.
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      // Resizing a dock or disclosure changes only the viewport. Preserve reading position or follow the bottom.
      if (opened.current && followBottom.current) el.scrollTop = el.scrollHeight;
      syncFades(el);
    });
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    const mo = new MutationObserver(() => syncFades(el));
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    syncFades(el);
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
  const members = useMemo(
    () => room.agentIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a),
    [room.agentIds, agents],
  );
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const mentionNames = useMemo(() => [...agents.map((a) => a.name), "所有人", "all", "everyone"], [agents]);
  // The agent the composer talks to by default: the DM partner, or the group's main agent.
  const primary = members.find((a) => a.id === room.mainAgentId) ?? members[0];
  const primaryView = primary ? sessions[primary.id] : undefined;

  useEffect(() => {
    let alive = true;
    let requestId = 0;
    const load = async () => {
      const id = ++requestId;
      dispatch({ type: "load", roomId: room.id, id });
      try {
        const data = await api<ChatSnapshot>("GET", `/api/rooms/${room.id}/messages?limit=200`);
        if (!alive || id !== requestId) return;
        dispatch({ type: "snapshot", roomId: room.id, id, data });
        setLoadError(null);
      } catch (e) {
        if (!alive || id !== requestId) return;
        dispatch({ type: "load.failed", roomId: room.id, id });
        setLoadError((e as Error).message);
      }
    };
    void load();
    const off = props.subscribeEvents((e) => {
      if (e.type === "subscribed" && e.roomId === room.id) {
        dispatch({ type: "event", event: { ...e, type: "room.state" } });
        void load();
      } else if (
        e.type === "message" ||
        e.type === "update" ||
        e.type === "session" ||
        e.type === "permission" ||
        e.type === "terminal" ||
        e.type === "room.state"
      ) {
        dispatch({ type: "event", event: e });
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [room.id, props.subscribeEvents]);

  // Warm up every member's session so the model picker and slash commands are there before the first message.
  const warming = useRef(new Set<string>());
  useEffect(() => {
    for (const a of members) {
      const key = `${room.id}|${a.id}`;
      if (!a.harness || sessions[a.id] || warming.current.has(key)) continue;
      warming.current.add(key);
      api<SessionView>("GET", `/api/rooms/${room.id}/agents/${a.id}/session`).then(
        (view) => dispatch({ type: "event", event: { type: "session", roomId: room.id, agentId: a.id, view } }),
        () => {}, // errors (not installed / login needed) surface when a message is sent
      );
    }
  }, [room.id, members, sessions]);

  // After switching to an older harness session, show what it replayed that this room doesn't have.
  const primarySession = primaryView?.sessionId ?? null;
  const primaryId = primary?.id;
  useEffect(() => {
    setReplay([]);
    if (!primaryId || !primarySession) return;
    api<ReplayTurn[]>("GET", `/api/rooms/${room.id}/agents/${primaryId}/replay`).then(setReplay, () => {});
  }, [room.id, primaryId, primarySession]);

  // Open at the latest message; afterwards stick to the bottom only when the reader is already there.
  useEffect(() => {
    const el = listRef.current;
    if (!el || messages.length === 0) return;
    if (!opened.current || el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTop = el.scrollHeight;
    opened.current = true;
  }, [messages]);

  const send = async () => {
    const content = draft.trim();
    if (sendingRef.current || (!content && images.length === 0)) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    const imgs = images;
    try {
      const sent = await api<Message>("POST", `/api/rooms/${room.id}/messages`, {
        senderName: props.userName,
        content,
        images: imgs,
        replyToId: quote?.messageId,
      });
      setDraft("");
      setImages([]);
      setQuote(null);
      // The server's reply is authoritative: show it now even if the socket is slow, reconnecting or raced.
      dispatch({ type: "event", event: { type: "message", message: sent } });
      requestAnimationFrame(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    } catch (e) {
      setSendError(`发送失败：${(e as Error).message}`);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const cancel = async (taskId: string) => {
    if (pendingCancellations.current.has(taskId)) return;
    pendingCancellations.current.add(taskId);
    setCancellations((current) => ({ ...current, [taskId]: { pending: true, error: null } }));
    try {
      await api<{ cancelled: boolean }>("POST", `/api/rooms/${room.id}/cancel`, { taskId });
      // Task ownership stays with the room.state stream. A late HTTP acknowledgement must not restore old tasks.
      setCancellations((current) => {
        const next = { ...current };
        delete next[taskId];
        return next;
      });
    } catch (e) {
      setCancellations((current) => ({
        ...current,
        [taskId]: { pending: false, error: `停止失败：${(e as Error).message}。请重试。` },
      }));
    } finally {
      pendingCancellations.current.delete(taskId);
    }
  };

  const answer = useCallback(
    async (askId: string, optionId: string | null) => {
      if (pendingAnswers.current.has(askId)) return;
      pendingAnswers.current.add(askId);
      setAnswers((a) => ({ ...a, [askId]: { pending: true, error: null } }));
      try {
        await api("POST", `/api/permissions/${askId}`, { optionId });
        dispatch({ type: "event", event: { type: "permission", roomId: room.id, ask: null, resolvedId: askId } });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          // Another client or cancellation already resolved this request.
          dispatch({ type: "event", event: { type: "permission", roomId: room.id, ask: null, resolvedId: askId } });
        } else {
          setAnswers((a) => ({
            ...a,
            [askId]: { pending: false, error: `授权提交失败：${(e as Error).message}。请重试。` },
          }));
        }
      } finally {
        pendingAnswers.current.delete(askId);
        setAnswers((a) => ({ ...a, [askId]: { pending: false, error: a[askId]?.error ?? null } }));
      }
    },
    [room.id],
  );

  const pickOption = async (agentId: string, opt: Opt, value: string) => {
    try {
      const v =
        opt.id === "__mode"
          ? await api<SessionView>("POST", `/api/rooms/${room.id}/agents/${agentId}/mode`, { modeId: value })
          : await api<SessionView>("POST", `/api/rooms/${room.id}/agents/${agentId}/config`, {
              configId: opt.id,
              value: opt.type === "boolean" ? value === "true" : value,
            });
      dispatch({ type: "event", event: { type: "session", roomId: room.id, agentId, view: v } });
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  const openDetails = (id: string) => {
    setSelected((cur) => (cur === id && panel ? null : id));
    setPanel(true);
  };

  const groups = groupMessages(messages);
  const tasks = state.tasks;
  const stopTask = tasks.length === 1 ? tasks[0] : undefined;
  const selectedMsg = messages.find((m) => m.id === selected);
  const ask = asks[0];

  return (
    <div className="conversation-workspace">
      <div className="chat-wrap">
        <div className="chat">
          <header className="main-head chat-head">
            <button
              type="button"
              className="btn ghost icon back-btn"
              onClick={props.onBack}
              aria-label="返回会话列表"
              data-shot="open-nav"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              className="title-pill"
              title={roomSubtitle(room, agents)}
              onClick={() => setPanel(true)}
            >
              <RoomIcon room={room} agents={agents} size={22} />
              <h2>{room.name}</h2>
            </button>
            <div className="chat-head-actions">
              {props.project && (
                <button
                  ref={terminalButton}
                  type="button"
                  className="btn ghost icon"
                  aria-label={terminalOpen ? "收起项目终端" : "打开项目终端"}
                  title="终端（Ctrl+`）"
                  aria-expanded={terminalOpen}
                  onClick={() => showTerminal(!terminalOpen)}
                >
                  <SquareTerminal size={18} />
                </button>
              )}
              {!(panel && wide) && (
                <button
                  type="button"
                  className="btn ghost icon"
                  aria-pressed={panel}
                  aria-label={panel ? "收起详情面板" : "展开详情面板"}
                  title="详情面板"
                  onClick={() => {
                    setPanel((v) => !v);
                    setSelected(null);
                  }}
                >
                  <PanelRight size={18} />
                </button>
              )}
            </div>
          </header>

          {loadError && (
            <div className="form-error" role="alert" style={{ margin: 12 }}>
              <AlertTriangle size={15} /> 消息加载失败：{loadError}
            </div>
          )}

          <div className="messages-wrap">
            <div
              className="messages"
              ref={listRef}
              onWheel={() => {
                followBottom.current = false;
              }}
              onTouchMove={() => {
                followBottom.current = false;
              }}
              onScroll={(e) => {
                const el = e.currentTarget;
                // Layout-driven scroll events may arrive a frame after the dock has resized again.
                // Preserve the pre-toggle follow intent through the transition, unless the reader scrolls.
                const movingLayout = [terminalSlot.current, taskDisclosure.current].some((panel) =>
                  panel?.getAnimations().some((animation) => animation.playState === "running"),
                );
                if (!followBottom.current || !movingLayout)
                  followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                const wrap = el.parentElement;
                if (!wrap) return;
                wrap.toggleAttribute("data-scrolled", el.scrollTop > 4);
                wrap.toggleAttribute("data-more-below", el.scrollHeight - el.scrollTop - el.clientHeight > 4);
              }}
            >
              {messages.length === 0 && replay.length === 0 && !loadError && (
                <div className="empty">
                  <RoomIcon room={room} agents={agents} />
                  <h2 style={{ fontSize: 17 }}>
                    {members.length > 1 ? "开始聊天" : `和 ${members[0]?.name ?? "Agent"} 打个招呼`}
                  </h2>
                  {primary && !primary.harness && (
                    <p className="muted">
                      {primary.name} 还没有绑定 Harness，<a href={`#/a/${primary.id}`}>去设置</a>或
                      <a href="#/harness">管理 Harness</a>。
                    </p>
                  )}
                  {members.length > 1 && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
                      {members.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          className="chip-btn"
                          onClick={() => setDraft((d) => `${d}@${a.name} `)}
                        >
                          <AgentAvatar agent={a} size={16} />
                          <span>@{a.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {replay.length > 0 && primary && (
                <ReplayHistory turns={replay} agentName={primary.name} terminals={terminals} />
              )}
              {groups.map((g) =>
                g.kind === "system" ? (
                  <div key={g.messages[0]?.id} className="system-line" role="note">
                    <span>{g.messages[0]?.content}</span>
                  </div>
                ) : (
                  <div key={g.messages[0]?.id} className="msg-group" data-kind={g.kind}>
                    {g.kind === "agent" ? (
                      <LiveAvatar
                        agent={agentById.get(g.senderId ?? "")}
                        name={g.senderName}
                        last={g.messages.at(-1)}
                      />
                    ) : (
                      <HumanAvatar name={g.senderName} size={36} />
                    )}
                    <div className="msg-head">
                      <span className="name">{g.senderName}</span>
                      {g.kind === "agent" && !agentById.has(g.senderId ?? "") && <span className="badge">已删除</span>}
                      <span className="time">{formatTime(g.messages[0]?.createdAt ?? 0)}</span>
                    </div>
                    {g.messages.map((m) => (
                      <MessageItem
                        key={m.id}
                        m={m}
                        onQuote={
                          room.kind === "group" && canQuoteMessage(m) ? () => setQuote(messageQuote(m)) : undefined
                        }
                        quoteDisabled={sending}
                        terminals={terminals}
                        mentionNames={mentionNames}
                        selected={selected === m.id && panel}
                        onDetails={() => openDetails(m.id)}
                        harnessId={agentById.get(m.senderId ?? "")?.harness}
                      />
                    ))}
                  </div>
                ),
              )}
            </div>
            <div className="msg-fade msg-fade-top" aria-hidden />
            <div className="msg-fade msg-fade-bottom" aria-hidden />
          </div>

          <footer className="composer">
            {tasks.length > 0 && (
              <TaskList
                tasks={tasks}
                agents={agentById}
                cancellations={cancellations}
                onCancel={(id) => void cancel(id)}
                disclosureRef={taskDisclosure}
                onBeforeToggle={() => {
                  const list = listRef.current;
                  if (list) followBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
                }}
              />
            )}
            {sendError && (
              <div className="error-text" role="alert" style={{ marginBottom: 6 }}>
                {sendError}
              </div>
            )}
            <Composer
              value={draft}
              quote={quote}
              onCancelQuote={() => setQuote(null)}
              sending={sending}
              onChange={setDraft}
              onSubmit={() => void send()}
              members={members.length > 1 ? members : []}
              placeholder={
                primaryView?.commands.length || primaryView?.skills.length ? "发消息，/ 命令 · $ Skills…" : "发消息…"
              }
              commands={primaryView?.commands ?? []}
              skills={primaryView?.skills ?? []}
              images={images}
              onImages={setImages}
              imageNote={primaryView && !primaryView.capabilities.image ? null : ""}
              stopTask={stopTask}
              stopPending={!!stopTask && (cancellations[stopTask.id]?.pending || stopTask.status === "cancelling")}
              queued={state.queued}
              onStop={() => stopTask && void cancel(stopTask.id)}
              modelPicker={<SessionChips members={members} sessions={sessions} onPick={pickOption} />}
              usage={primaryView && members.length === 1 ? <CtxUsage view={primaryView} /> : null}
            />
          </footer>
        </div>

        {ask && (
          <PermissionDialog
            key={ask.id}
            ask={ask}
            agentName={agentById.get(ask.agentId)?.name ?? "Agent"}
            terminals={terminals}
            pending={answers[ask.id]?.pending ?? false}
            error={answers[ask.id]?.error ?? null}
            onAnswer={(optionId) => void answer(ask.id, optionId)}
          />
        )}

        {panelPresence.mounted && (
          <>
            {!wide && (
              // biome-ignore lint/a11y/noStaticElementInteractions: scrim closes the overlay panel; the close button is the keyboard path
              // biome-ignore lint/a11y/useKeyWithClickEvents: see above
              <div className="scrim" data-state={panelPresence.state} onClick={() => setPanel(false)} />
            )}
            {/* The slot reserves the panel's column and resizes in step with the slide, so the chat never jumps. */}
            <div className="details-slot" data-state={panelPresence.state}>
              <aside className="details" data-state={panelPresence.state} aria-label="详情面板">
                <div className="details-head">
                  {selectedMsg && (
                    <button
                      type="button"
                      className="btn ghost icon"
                      aria-label="返回会话信息"
                      title="返回会话信息"
                      onClick={() => setSelected(null)}
                    >
                      <ChevronLeft size={16} />
                    </button>
                  )}
                  <h3>{selectedMsg ? "回复详情" : ""}</h3>
                  <div className="details-actions">
                    <button
                      type="button"
                      className="btn ghost icon"
                      aria-label="关闭详情面板"
                      onClick={() => setPanel(false)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
                <div className="details-body">
                  {selectedMsg ? (
                    <MessageDetails
                      m={selectedMsg}
                      agent={agentById.get(selectedMsg.senderId ?? "")}
                      harnessName={props.harnessName}
                    />
                  ) : (
                    <RoomInfo
                      room={room}
                      project={props.project}
                      agents={agents}
                      members={members}
                      messages={messages}
                      sessions={sessions}
                      harnessName={props.harnessName}
                      onRoomChange={props.onRoomChange}
                      onDeleted={props.onDeleted}
                    />
                  )}
                </div>
              </aside>
            </div>
          </>
        )}
      </div>
      {props.project && (
        <div
          ref={terminalSlot}
          className="terminal-slot"
          data-open={terminalOpen || undefined}
          inert={!terminalOpen}
          aria-hidden={!terminalOpen}
          onTransitionCancel={() => {
            if (!terminalOpen && terminalEnding.current && (terminalSlot.current?.clientHeight ?? 0) === 0) {
              terminalEnding.current = false;
              setTerminalMounted(false);
            }
          }}
          onTransitionEnd={(event) => {
            if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") return;
            if (!terminalOpen && terminalEnding.current) {
              terminalEnding.current = false;
              setTerminalMounted(false);
            }
          }}
        >
          <div className="terminal-clip">
            <div className="terminal-slot-content" style={{ height: terminalHeight }}>
              {terminalMounted && (
                <Suspense
                  fallback={
                    <div className="terminal-loading" role="status">
                      正在打开终端…
                    </div>
                  }
                >
                  <ProjectTerminal
                    key={terminalEpoch}
                    project={props.project}
                    visible={terminalOpen}
                    height={terminalHeight}
                    onHeightChange={setTerminalHeight}
                    focusRequest={terminalFocusRequest}
                    onHide={() => showTerminal(false)}
                    onEnded={() => {
                      terminalEnding.current = true;
                      showTerminal(false);
                      if (reducedMotion() || (terminalSlot.current?.clientHeight ?? 0) === 0) {
                        terminalEnding.current = false;
                        setTerminalMounted(false);
                      }
                    }}
                  />
                </Suspense>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type Group = { kind: Message["senderKind"]; senderId: string | null; senderName: string; messages: Message[] };

/** Consecutive messages from the same speaker within 5 minutes share one header. */
function groupMessages(messages: Message[]): Group[] {
  const out: Group[] = [];
  for (const m of messages) {
    const last = out.at(-1);
    const prev = last?.messages.at(-1);
    if (
      last &&
      prev &&
      m.senderKind !== "system" &&
      last.kind === m.senderKind &&
      last.senderId === m.senderId &&
      last.senderName === m.senderName &&
      m.createdAt - prev.createdAt < GROUP_GAP_MS
    )
      last.messages.push(m);
    else out.push({ kind: m.senderKind, senderId: m.senderId, senderName: m.senderName, messages: [m] });
  }
  return out;
}

/** Fade edges show only when there is content hidden above / below. */
function syncFades(el: HTMLElement | null) {
  const wrap = el?.parentElement;
  if (!el || !wrap) return;
  wrap.toggleAttribute("data-scrolled", el.scrollTop > 4);
  wrap.toggleAttribute("data-more-below", el.scrollHeight - el.scrollTop - el.clientHeight > 4);
}

function MessageItem(props: {
  m: Message;
  terminals: Record<string, TerminalSnapshot>;
  mentionNames: string[];
  selected: boolean;
  onDetails: () => void;
  harnessId?: string;
  onQuote?: () => void;
  quoteDisabled?: boolean;
}) {
  const { m } = props;
  const streaming = m.status === "streaming";
  const t = withoutHandoffTools(m.timeline);
  const empty = !t || t.parts.length === 0;
  return (
    <div className="message-row" data-message-id={m.id} data-sender={m.senderKind}>
      <div
        className="msg"
        data-sender={m.senderKind}
        data-status={m.status}
        data-fresh={Date.now() - m.createdAt < 4000 ? "" : undefined}
      >
        {m.quote && <QuoteExcerpt quote={m.quote} />}
        {t?.handoffFrom && (
          <div className="handoff-from">
            <ArrowRightLeft size={12} />
            <span>
              接 <b>@{t.handoffFrom.agentName}</b> 的交接：{t.handoffFrom.task}
            </span>
          </div>
        )}
        {m.senderKind === "human" ? (
          <>
            {m.content && <MessageMarkdown text={m.content} mentionNames={props.mentionNames} />}
            {t && (
              <TimelineView t={t} streaming={false} terminals={props.terminals} mentionNames={props.mentionNames} />
            )}
          </>
        ) : t ? (
          <TimelineView t={t} streaming={streaming} terminals={props.terminals} mentionNames={props.mentionNames} />
        ) : (
          m.content && <MessageMarkdown text={m.content} mentionNames={props.mentionNames} />
        )}
        {t?.handoffs?.map((h) => (
          <div key={h.agentId} className="handoff-card" role="note">
            <div className="handoff-title">
              <ArrowRightLeft size={13} />
              交接给 <b>@{h.agentName}</b>
            </div>
            <p>{h.task}</p>
          </div>
        ))}
        {m.senderKind === "agent" && empty && !m.content && streaming && (
          <span className="typing">
            <i />
            <i />
            <i />
            正在思考
            <Waited since={m.createdAt} />
          </span>
        )}
        {m.senderKind === "agent" && empty && !m.content && m.status === "done" && (
          <span className="muted">（空回复）</span>
        )}
        {m.status === "error" && (
          <div className="msg-error" role="alert">
            <AlertTriangle size={14} />
            <span>{m.error ?? "回复失败"}</span>
          </div>
        )}
        {m.status === "error" && m.error && <MissingKey harnessId={props.harnessId} error={m.error} />}
        {m.status === "interrupted" && (
          <div className="msg-error">
            <AlertTriangle size={14} />
            <span>{m.error ?? "回复被中断"}</span>
          </div>
        )}
        {m.senderKind === "agent" && !streaming && (t?.reviewOf || m.status === "cancelled") && (
          <div className="msg-meta">
            {t?.reviewOf && <span className="muted">群主跟进 · 已收到 {t.reviewOf.length} 份成员结果</span>}
            {m.status === "cancelled" && (
              <span className="state-tag">
                <CircleSlash size={11} />
                {m.error === "被新消息打断" ? "被新消息打断" : "已停止"}
              </span>
            )}
          </div>
        )}
      </div>
      <MessageActions
        message={m}
        onQuote={props.onQuote}
        quoteDisabled={props.quoteDisabled}
        onDetails={m.senderKind === "agent" ? props.onDetails : undefined}
        selected={props.selected}
      />
    </div>
  );
}

/** Room task state is shared by the list and the single-task composer shortcut. */
function TaskList(props: {
  tasks: RoomState["tasks"];
  agents: Map<string, Agent>;
  cancellations: Record<string, { pending: boolean; error: string | null }>;
  onCancel: (id: string) => void;
  disclosureRef: React.RefObject<HTMLDivElement | null>;
  onBeforeToggle: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const summaryId = useId();
  const running = props.tasks.filter((task) => task.status === "running" && !props.cancellations[task.id]?.pending);
  const stopping = props.tasks.filter((task) => task.status === "cancelling" || props.cancellations[task.id]?.pending);
  const waiting = props.tasks.filter((task) => task.status === "waiting");
  // A waiting coordinator and queued collaborators still belong in the summary. Pick one primary state per Agent.
  const primaryTasks = new Map<string, RoomState["tasks"][number]>();
  for (const task of [...running, ...stopping, ...waiting, ...props.tasks])
    if (!primaryTasks.has(task.agentId)) primaryTasks.set(task.agentId, task);
  const participants = [...primaryTasks.values()].map((task) => {
    const queued = props.tasks.filter(
      (item) => item.agentId === task.agentId && item.status === "queued" && !props.cancellations[item.id]?.pending,
    ).length;
    const status =
      props.cancellations[task.id]?.pending || task.status === "cancelling"
        ? "正在停止"
        : task.status === "queued"
          ? queued > 1
            ? `${queued} 项排队`
            : "排队中"
          : task.status === "waiting"
            ? task.coordination === "lead" || task.coordination === "review"
              ? "等待成员结果"
              : "等待交接完成"
            : task.coordination === "review"
              ? "正在跟进"
              : task.messageId
                ? "正在回复"
                : "正在准备";
    return { task, status, queued: task.status === "queued" ? 0 : queued };
  });
  const overflow = participants.slice(3);
  const single = props.tasks.length === 1 ? props.tasks[0] : undefined;
  const singleStopping = !!single && (props.cancellations[single.id]?.pending || single.status === "cancelling");
  return (
    <section className="chat-tasks" aria-label="会话任务" data-expanded={expanded}>
      <div className="chat-activity">
        <button
          ref={toggleRef}
          type="button"
          className="chat-activity-toggle"
          aria-label={expanded ? "收起回复状态" : "展开回复状态"}
          aria-expanded={expanded}
          aria-controls={listId}
          aria-describedby={summaryId}
          onClick={() => {
            props.onBeforeToggle();
            if (expanded && props.disclosureRef.current?.contains(document.activeElement)) toggleRef.current?.focus();
            setExpanded((value) => !value);
          }}
        >
          <span className="chat-activity-participants" id={summaryId} aria-live="polite" aria-atomic="true">
            {participants.slice(0, 3).map(({ task, status, queued }) => (
              <span className="chat-activity-agent" key={task.agentId} data-agent-id={task.agentId}>
                <AgentAvatar agent={props.agents.get(task.agentId)} name={task.agentName} size={20} />
                <span className="chat-activity-label">
                  <strong title={task.agentName}>{task.agentName}</strong>
                  <span>{status}</span>
                </span>
                {queued > 0 && (
                  <span className="chat-activity-count">
                    <Clock3 size={12} aria-hidden />
                    {queued} 项排队
                  </span>
                )}
              </span>
            ))}
            {overflow.length > 0 && (
              <span
                className="chat-activity-count"
                title={overflow.map(({ task, status }) => `${task.agentName} · ${status}`).join("\n")}
              >
                <span aria-hidden>+{overflow.length}</span>
                <span className="sr-only">
                  还有 {overflow.length} 位 Agent：
                  {overflow.map(({ task, status }) => `${task.agentName} ${status}`).join("，")}
                </span>
              </span>
            )}
          </span>
          {running.length > 0 && (
            <span className="chat-activity-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          )}
          <ChevronRight size={13} className="chat-activity-chevron" aria-hidden />
        </button>
        {single && (
          <button
            type="button"
            className="chat-activity-stop"
            data-hidden={expanded || undefined}
            aria-hidden={expanded}
            inert={expanded}
            aria-label={single.status === "queued" ? "取消排队" : "停止任务"}
            title={single.status === "queued" ? "取消排队" : "停止任务"}
            aria-describedby={summaryId}
            disabled={singleStopping}
            onClick={() => props.onCancel(single.id)}
          >
            <Square size={10} fill="currentColor" aria-hidden />
          </button>
        )}
      </div>
      <div className="chat-activity-errors" aria-hidden={expanded}>
        <div className="chat-task-clip">
          {props.tasks.map((task) => {
            const error = props.cancellations[task.id]?.error;
            return error ? (
              <div key={task.id} className="chat-activity-error" role="alert">
                <AlertTriangle size={13} aria-hidden />
                <span>
                  未能停止 {task.agentName}：{error}
                </span>
              </div>
            ) : null;
          })}
        </div>
      </div>
      <div
        ref={props.disclosureRef}
        className="chat-task-disclosure"
        id={listId}
        inert={!expanded}
        aria-hidden={!expanded}
      >
        <div className="chat-task-clip">
          <ul className="chat-task-list">
            {props.tasks.map((task) => {
              const cancellation = props.cancellations[task.id];
              const status =
                task.status === "queued"
                  ? "排队中"
                  : task.status === "cancelling"
                    ? "停止中"
                    : task.status === "waiting"
                      ? task.coordination === "lead" || task.coordination === "review"
                        ? "统筹中"
                        : "交接中"
                      : task.coordination === "review"
                        ? "跟进中"
                        : task.messageId
                          ? "回复中"
                          : "准备中";
              return (
                <li className="chat-task" key={task.id} data-task-id={task.id} data-task-status={task.status}>
                  <div className="chat-task-content" id={`task-summary-${task.id}`}>
                    <div className="chat-task-title">
                      <AgentAvatar agent={props.agents.get(task.agentId)} name={task.agentName} size={18} />
                      <span className="chat-task-name">{task.agentName}</span>
                      <span className="chat-task-state">{status}</span>
                    </div>
                    <div className="chat-task-summary">{task.text || "正在准备回复…"}</div>
                    {cancellation?.error && (
                      <div className="chat-task-error" role="alert">
                        {cancellation.error}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn ghost sm chat-task-stop"
                    aria-label={task.status === "queued" ? "取消排队" : "停止任务"}
                    aria-describedby={`task-summary-${task.id}`}
                    disabled={cancellation?.pending || task.status === "cancelling"}
                    onClick={() => props.onCancel(task.id)}
                  >
                    {cancellation?.pending || task.status === "cancelling"
                      ? "停止中…"
                      : task.status === "queued"
                        ? "取消排队"
                        : "停止"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

function QuoteExcerpt({ quote }: { quote: MessageQuote }) {
  return (
    <blockquote className="message-quote" aria-label={`引用 ${quote.senderName} 的消息`}>
      <span className="message-quote-author">{quote.senderName}</span>
      <span className="message-quote-text">{quote.text}</span>
    </blockquote>
  );
}

/** After a while with no output, say so (a harness can sit silently while it retries upstream). */
function Waited({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((now - since) / 1000);
  if (s < 15) return null;
  return <span className="waited">· {s} 秒无响应，可停止后重试</span>;
}

/** The handoff tool call is shown as a hand-off card instead of a generic tool card. */
function withoutHandoffTools(t: Timeline | null): Timeline | null {
  if (!t?.handoffs?.length) return t;
  const hide = new Set(
    Object.values(t.tools)
      .filter((x) => /handoff/i.test(x.title))
      .map((x) => x.toolCallId),
  );
  if (hide.size === 0) return t;
  return { ...t, parts: t.parts.filter((p) => !(p.kind === "tool" && hide.has(p.toolCallId))) };
}

/** History a harness replayed on session/load that this room never showed (read-only). */
function ReplayHistory(props: { turns: ReplayTurn[]; agentName: string; terminals: Record<string, TerminalSnapshot> }) {
  return (
    <details className="replay" open>
      <summary>
        <History size={13} /> 载入的 Harness 历史 · {props.turns.length} 轮
      </summary>
      {props.turns.map((turn, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: replayed turns have no ids and never reorder
        <div key={i} className="replay-turn">
          {turn.user && (
            <div className="replay-user">
              <span className="name">我</span>
              <MessageMarkdown text={turn.user} mentionNames={[]} />
            </div>
          )}
          <div className="replay-agent">
            <span className="name">{props.agentName}</span>
            <TimelineView t={turn.reply} streaming={false} terminals={props.terminals} mentionNames={[]} />
          </div>
        </div>
      ))}
    </details>
  );
}

const STOP_LABEL: Record<string, string> = {
  end_turn: "正常结束",
  cancelled: "已取消",
  refusal: "拒绝",
  max_tokens: "达到 token 上限",
  max_turn_requests: "达到轮次上限",
};

function MessageDetails(props: { m: Message; agent?: Agent; harnessName: (id: string) => string }) {
  const { m, agent } = props;
  const tools = Object.values(m.timeline?.tools ?? {});
  return (
    <section className="d-section">
      <dl className="kv">
        <dt>Agent</dt>
        <dd>{m.senderName}</dd>
        <dt>Harness</dt>
        <dd>{agent?.harness ? props.harnessName(agent.harness) : "—"}</dd>
        <dt>状态</dt>
        <dd>
          {m.timeline?.stopReason ? (STOP_LABEL[m.timeline.stopReason] ?? m.timeline.stopReason) : m.status}
          {m.error && <div className="error-text">{m.error}</div>}
        </dd>
        <dt>工具</dt>
        <dd>{tools.length === 0 ? "无" : tools.map((t) => t.title).join("、")}</dd>
        <dt>时间</dt>
        <dd>{new Date(m.createdAt).toLocaleString()}</dd>
      </dl>
    </section>
  );
}

/** Harness session controls for one agent: current session, new session, sessions the harness remembers. */
function SessionSection(props: { room: Room; agent: Agent; view?: SessionView; solo: boolean }) {
  const { room, agent, view } = props;
  const [list, setList] = useState<{ sessionId: string; title?: string | null; updatedAt?: string | null }[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const base = `/api/rooms/${room.id}/agents/${agent.id}`;
  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="d-section">
      <h4 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        {props.solo ? "Harness 会话" : `${agent.name} 的会话`}
        <span style={{ display: "flex", gap: 4 }}>
          {view?.capabilities.list && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void run(async () => setList(await api("GET", `${base}/history`)))}
            >
              <History size={13} />
              历史
            </button>
          )}
          <button
            type="button"
            className="btn ghost sm"
            title="开始新的 Harness 会话（聊天记录保留）"
            onClick={() => void run(() => api("POST", `${base}/session`, { sessionId: null }))}
          >
            <Plus size={13} />
            新会话
          </button>
        </span>
      </h4>
      {view ? (
        <dl className="kv">
          <dt>会话</dt>
          <dd>
            <code style={{ fontSize: 11 }}>{view.sessionId}</code>
            {view.title && <div className="muted">{view.title}</div>}
          </dd>
          {view.usage && (
            <>
              <dt>上下文</dt>
              <dd>
                {view.usage.used.toLocaleString()} / {view.usage.size.toLocaleString()}
                {view.usage.cost && ` · ${view.usage.cost.amount.toFixed(4)} ${view.usage.cost.currency}`}
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          发第一条消息时启动。
        </p>
      )}
      {list && (
        <div className="session-list">
          {list.length === 0 && <p className="muted">没有可恢复的会话。</p>}
          {list.map((s) => (
            <button
              key={s.sessionId}
              type="button"
              className="pop-item"
              aria-current={s.sessionId === view?.sessionId}
              onClick={() =>
                void run(async () => {
                  await api("POST", `${base}/session`, { sessionId: s.sessionId });
                  setList(null);
                })
              }
            >
              <span>{s.title || s.sessionId}</span>
              {s.updatedAt && <span className="pop-hint muted">{new Date(s.updatedAt).toLocaleDateString()}</span>}
            </button>
          ))}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </section>
  );
}

function RoomInfo(props: {
  room: Room;
  project: Project | null;
  agents: Agent[];
  members: Agent[];
  messages: Message[];
  sessions: Record<string, SessionView>;
  harnessName: (id: string) => string;
  onRoomChange: () => Promise<void>;
  onDeleted: () => void;
}) {
  const { room } = props;
  const [error, setError] = useState<string | null>(null);
  const replyCount = new Map<string, number>();
  for (const m of props.messages)
    if (m.senderKind === "agent" && m.senderId) replyCount.set(m.senderId, (replyCount.get(m.senderId) ?? 0) + 1);
  const patch = async (body: { mainAgentId?: string; name?: string }) => {
    try {
      await api("PATCH", `/api/rooms/${room.id}`, body);
      await props.onRoomChange();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const toggle = async (id: string) => {
    const next = room.agentIds.includes(id) ? room.agentIds.filter((x) => x !== id) : [...room.agentIds, id];
    try {
      await api("PUT", `/api/rooms/${room.id}/agents`, { agentIds: next });
      await props.onRoomChange();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const [tab, setTab] = useState<"info" | "library" | "members">("members");
  const [adding, setAdding] = useState(false);
  const others = props.agents.filter((a) => !room.agentIds.includes(a.id));
  return (
    <>
      <div className="d-hero">
        <RoomIcon room={room} agents={props.agents} size={64} />
        <h3>{room.name}</h3>
        <div className="d-tabs" role="tablist" aria-label="会话信息">
          {(
            [
              ["info", "详情"],
              ["library", "资料库"],
              ["members", "成员"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className="d-tab"
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {tab === "members" && (
        <section className="d-section d-members">
          {props.members.length === 0 && <p className="muted">没有 Agent 成员。</p>}
          {props.members.map((a) => {
            const n = replyCount.get(a.id) ?? 0;
            const doing = agentActivity(a.id, props.messages);
            return (
              <div key={a.id} className="member-row">
                <a className="member-link" href={`#/a/${a.id}`} title="编辑这个 Agent">
                  <AgentAvatar agent={a} size={28} expression={doing} animate />
                  <span className="member-body">
                    <span className="member-name">{a.name}</span>
                    <span className="member-sub">
                      {a.harness ? props.harnessName(a.harness) : "未绑定 Harness"}
                      {room.mainAgentId === a.id && " · 主 Agent"}
                      {n > 0 && ` · ${n} 条回复`}
                    </span>
                  </span>
                </a>
                {props.members.length > 1 && (
                  <button
                    type="button"
                    className="btn ghost icon xs member-remove"
                    aria-label={`移出 ${a.name}`}
                    onClick={() => void toggle(a.id)}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            );
          })}
          <div className="add-member">
            <button type="button" className="member-row add-btn" onClick={() => setAdding((v) => !v)}>
              <span className="add-icon">
                <Plus size={15} />
              </span>
              <span className="member-name">添加成员</span>
            </button>
            {adding && (
              <div className="add-pop">
                <PickList
                  searchPlaceholder="搜索 Agent"
                  emptyText="没有可添加的 Agent"
                  groups={[
                    {
                      items: others.map((a) => ({
                        id: a.id,
                        title: a.name,
                        leading: <AgentAvatar agent={a} size={22} />,
                        plain: true,
                      })),
                    },
                  ]}
                  selected={[]}
                  onToggle={(id) => {
                    setAdding(false);
                    void toggle(id);
                  }}
                />
              </div>
            )}
          </div>
          {error && <div className="error-text">{error}</div>}
        </section>
      )}
      {tab === "library" && (
        <section className="d-section">
          <h4>项目</h4>
          <a className="project-link" href={props.project ? `#/p/${props.project.id}` : undefined}>
            <span>{props.project?.name ?? "—"}</span>
            <span className="muted mono">{room.cwd}</span>
          </a>
          <p className="muted d-note">会话里的 Agent 都在这个文件夹里读写文件。</p>
        </section>
      )}
      {tab === "info" && (
        <>
          {props.members.length > 1 && (
            <section className="d-section">
              <label className="field">
                <span className="label">主 Agent</span>
                <select
                  className="select"
                  aria-label="主 Agent"
                  value={room.mainAgentId ?? ""}
                  onChange={(e) => void patch({ mainAgentId: e.target.value })}
                >
                  {props.members.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          )}
          {props.members.map((a) =>
            a.harness ? (
              <SessionSection
                key={a.id}
                room={room}
                agent={a}
                view={props.sessions[a.id]}
                solo={props.members.length === 1}
              />
            ) : null,
          )}
          <section className="d-section" style={{ marginTop: "auto" }}>
            <button
              type="button"
              className="btn danger"
              onClick={async () => {
                if (!confirm(`删除会话「${room.name}」及其全部消息？此操作不可撤销。`)) return;
                await api("DELETE", `/api/rooms/${room.id}`).then(props.onDeleted, (e) =>
                  setError((e as Error).message),
                );
              }}
            >
              <Trash2 size={14} />
              删除会话
            </button>
          </section>
        </>
      )}
    </>
  );
}

const EVERYONE = { id: "__everyone", name: "所有人" } as const;

function Composer(props: {
  value: string;
  quote: MessageQuote | null;
  onCancelQuote: () => void;
  sending: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  members: Agent[];
  placeholder: string;
  commands: { name: string; description: string }[];
  skills: { name: string; description: string }[];
  images: ImageAttachment[];
  onImages: (imgs: ImageAttachment[]) => void;
  /** null = the harness does not take images (button hidden). */
  imageNote: string | null;
  modelPicker?: React.ReactNode;
  usage?: React.ReactNode;
  /** A shortcut is safe only when there is exactly one task to cancel. */
  stopTask?: RoomState["tasks"][number];
  stopPending?: boolean;
  queued?: number;
  onStop?: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const addFiles = async (files: Iterable<File>) => {
    if (props.sending) return;
    const next = [...props.images];
    for (const f of files) if (f.type.startsWith("image/")) next.push(await readImage(f));
    props.onImages(next.slice(0, 8));
  };
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (props.quote) ref.current?.focus();
  }, [props.quote]);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerId = useId();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const query = props.sending ? null : /(?:^|\s)@([^\s@]*)$/.exec(props.value.slice(0, caret));
  const q = (query?.[1] ?? "").toLowerCase();
  // "所有人" is offered first in groups with 2+ agents; it matches 所有人 / all / everyone.
  const everyone =
    props.members.length > 1 && ["所有人", "all", "everyone"].some((n) => n.startsWith(q) || n.includes(q));
  const options: (Agent | typeof EVERYONE)[] =
    query && !dismissed
      ? [...(everyone ? [EVERYONE] : []), ...props.members.filter((a) => a.name.toLowerCase().includes(q))]
      : [];
  // / = harness commands (available_commands_update); $ = skills (Codex and Tuantuan-managed).
  const slash = props.sending ? null : /^\/(\S*)$/.exec(props.value.slice(0, caret));
  const dollar = props.sending ? null : skillTokenAt(props.value, caret);
  const commands =
    slash && !dismissed && options.length === 0
      ? props.commands.filter((c) => c.name.toLowerCase().startsWith((slash[1] ?? "").toLowerCase())).slice(0, 12)
      : [];
  const skillHits = dollar && !dismissed && options.length === 0 ? matchingSkills(props.skills, dollar.query) : [];
  const pickCommand = (name: string, prefix: "/" | "$") => {
    if (props.sending) return;
    const next =
      prefix === "$" && dollar
        ? insertSkill(props.value, dollar, name)
        : { value: `${prefix}${name} ${props.value.slice(caret)}`, caret: name.length + 2 };
    props.onChange(next.value);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  const picker = commands.length
    ? { kind: "cmd" as const, items: commands, prefix: "/" as const, title: "命令" }
    : skillHits.length
      ? { kind: "skill" as const, items: skillHits, prefix: "$" as const, title: "Skills" }
      : null;
  const pickerCount = picker?.items.length ?? 0;
  const pickerQuery = dollar?.query ?? slash?.[1] ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: rendered selection and filtered results change the scroll target
  useEffect(() => {
    pickerRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, pickerCount, pickerQuery]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resize on value change
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [props.value]);

  const pick = (a: Pick<Agent, "name">) => {
    if (props.sending) return;
    const before = props.value.slice(0, caret).replace(/@[^\s@]*$/, `@${a.name} `);
    props.onChange(before + props.value.slice(caret));
    setCaret(before.length);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(before.length, before.length);
    });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping images is a shortcut; the image button is the accessible path
    <div
      className="composer-box"
      onDragOver={(e) => props.imageNote !== null && e.preventDefault()}
      onDrop={(e) => {
        if (props.imageNote === null) return;
        e.preventDefault();
        void addFiles(e.dataTransfer.files);
      }}
    >
      {picker && (
        <div
          ref={pickerRef}
          id={pickerId}
          className="popover mention-pop slash-pop"
          role="listbox"
          aria-label={picker.title}
          style={picker.kind === "skill" ? { maxHeight: "min(320px, 50dvh)", overflowY: "auto" } : undefined}
        >
          <div className="pop-title">{picker.title}</div>
          {picker.items.map((c, i) => (
            <button
              type="button"
              role="option"
              id={`${pickerId}-${i}`}
              aria-selected={i === active % picker.items.length}
              key={c.name}
              className="pop-item"
              onMouseDown={(e) => {
                e.preventDefault();
              }}
              onClick={() => pickCommand(c.name, picker.prefix)}
            >
              <code className="slash-name">
                {picker.prefix}
                {c.name}
              </code>
              <span className="muted">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      {props.images.length > 0 && (
        <div className="attach-row">
          {props.images.map((img, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: attachments are a short local list
            <span key={i} className="attach">
              <img src={`data:${img.mimeType};base64,${img.data}`} alt={`附件 ${i + 1}`} />
              <button
                type="button"
                disabled={props.sending}
                aria-label="移除图片"
                onClick={() => props.onImages(props.images.filter((_, j) => j !== i))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {options.length > 0 && (
        <div className="popover mention-pop" role="listbox" aria-label="选择要 @ 的 Agent">
          <div className="pop-title">提及 Agent</div>
          {options.map((a, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              key={a.id}
              className="pop-item"
              onMouseDown={(e) => {
                e.preventDefault();
                pick(a);
              }}
            >
              {a === EVERYONE ? (
                <span className="room-icon" style={{ ["--size" as string]: "22px" }}>
                  <Users size={13} />
                </span>
              ) : (
                <AgentAvatar agent={a as Agent} size={22} />
              )}
              <span>{a.name}</span>
            </button>
          ))}
        </div>
      )}
      {props.quote && (
        <div className="composer-quote" data-testid="composer-quote">
          <QuoteExcerpt quote={props.quote} />
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label="取消引用"
            disabled={props.sending}
            onClick={() => {
              props.onCancelQuote();
              ref.current?.focus();
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <textarea
        readOnly={props.sending}
        ref={ref}
        rows={1}
        value={props.value}
        aria-label="消息输入框"
        aria-autocomplete={picker ? "list" : undefined}
        aria-controls={picker ? pickerId : undefined}
        aria-activedescendant={picker ? `${pickerId}-${active % picker.items.length}` : undefined}
        placeholder={props.placeholder}
        onChange={(e) => {
          if (props.sending) return;
          props.onChange(e.target.value);
          setCaret(e.target.selectionStart);
          setActive(0);
          setDismissed(false);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
          if (files.length > 0 && props.imageNote !== null) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (props.sending) {
            if (e.key === "Enter") e.preventDefault();
            return;
          }
          if (e.nativeEvent.isComposing) return;
          if (picker && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setActive((i) => (i + (e.key === "ArrowDown" ? 1 : picker.items.length - 1)) % picker.items.length);
          } else if (picker && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
            const c = picker.items[active % picker.items.length] as { name: string };
            if (picker.prefix === "$" || props.value.trim() !== `${picker.prefix}${c.name}`) {
              e.preventDefault();
              pickCommand(c.name, picker.prefix);
            } else if (e.key === "Enter") {
              e.preventDefault();
              props.onSubmit();
            }
          } else if (picker && e.key === "Escape") {
            setDismissed(true);
          } else if (options.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setActive((i) => (i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
          } else if (options.length > 0 && (e.key === "Enter" || e.key === "Tab")) {
            e.preventDefault();
            pick(options[active] ?? (options[0] as Agent));
          } else if (options.length > 0 && e.key === "Escape") {
            setDismissed(true);
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            props.onSubmit();
          }
        }}
      />
      {props.members.length > 0 && props.value.trim() && (
        <div className="composer-recipients">
          <Recipients text={props.value} members={props.members} />
        </div>
      )}
      <div className="composer-foot">
        <div className="composer-tools">
          {props.imageNote !== null && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                hidden
                onChange={(e) => {
                  void addFiles(e.target.files ?? []);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className="btn ghost icon sm"
                disabled={props.sending}
                aria-label="添加图片"
                title={props.imageNote || "添加图片"}
                onClick={() => fileRef.current?.click()}
              >
                <Plus size={17} />
              </button>
            </>
          )}
          {props.modelPicker}
        </div>
        <div className="composer-status">
          {props.usage}
          {(() => {
            const stop = !!props.stopTask && !props.sending && !props.value.trim() && props.images.length === 0;
            const label = stop ? (props.stopTask?.status === "queued" ? "取消排队" : "停止") : "发送";
            return (
              <button
                type="button"
                className="send-btn"
                data-mode={stop ? "stop" : "send"}
                onClick={stop ? props.onStop : props.onSubmit}
                disabled={
                  stop ? props.stopPending : props.sending || (!props.value.trim() && props.images.length === 0)
                }
                aria-label={label}
                title={
                  stop
                    ? `${label} · ${props.stopTask?.agentName} · ${props.stopTask?.text || "正在准备回复"}`
                    : props.queued
                      ? `发送 · ${props.queued} 条排队中`
                      : "发送"
                }
              >
                <span className="send-ico send-ico-arrow" aria-hidden>
                  <ArrowUp size={17} />
                </span>
                <span className="send-ico send-ico-stop" aria-hidden>
                  <i />
                </span>
              </button>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

const EVERYONE_RE = /(^|[^\w.])@(所有人|all|everyone)(?![\w\u4e00-\u9fff])/i;

/** Live preview of who will answer the draft, mirroring the server's group rules. */
function Recipients(props: { text: string; members: Agent[] }) {
  const lower = props.text.toLowerCase();
  const named = props.members.filter((a) => lower.includes(`@${a.name.toLowerCase()}`));
  const everyone = EVERYONE_RE.test(props.text);
  return (
    <span className="recipients" aria-live="polite">
      {everyone ? (
        <span className="rcpt">
          <Users size={12} />
          所有人
        </span>
      ) : (
        named.map((a) => (
          <span key={a.id} className="rcpt" title={`发给 ${a.name}`}>
            <AgentAvatar agent={a} size={14} />
            {a.name}
          </span>
        ))
      )}
    </span>
  );
}

/** Message-column avatar: animated only while this group's latest reply is in flight. */
function LiveAvatar(props: { agent?: Agent; name: string; last?: Message }) {
  const state = props.last ? messageExpression(props.last) : { expression: "idle" as const, live: false };
  return (
    <AgentAvatar
      agent={props.agent}
      name={props.name}
      size={36}
      expression={state.expression}
      animate={state.live}
      pulse={state.live ? props.last?.id : undefined}
    />
  );
}
