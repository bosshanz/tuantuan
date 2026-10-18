import {
  AlertTriangle,
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  Clock3,
  History,
  Loader2,
  PanelRight,
  Pin,
  Plus,
  RotateCcw,
  Square,
  SquareTerminal,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { canQuoteMessage, type MessageQuote, messageQuote } from "../../shared/messageQuote";
import { intlLocale, translateError, useI18n } from "./i18n";
import "./messageQuote.css";
import "./chatTasks.css";
import "./chatScroll.css";
import type { ElicitationValue } from "../../shared/elicitation";
import type { ReplayTurn, RoomConclusion, TaskContext } from "../../shared/timeline";
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
import { type ChatSnapshot, chatReducer, emptyChat, historyCursor, type MessagePage } from "./chatState";
import type { Opt } from "./config";
import { ElicitationDialog } from "./ElicitationDialog";
import { CtxUsage, PermissionDialog, TimelineView } from "./Harness";
import { MissingKey } from "./HarnessAuth";
import { MessageActions } from "./MessageActions";
import { reducedMotion, usePresence } from "./motion";
import { PickList } from "./PickList";
import type { TerminalFocusRequest } from "./ProjectTerminal";
import { insertSkill, matchingSkills, skillTokenAt } from "./skillCompletion";
import { AgentAvatar, formatTime, HumanAvatar, MessageMarkdown, RoomIcon, roomSubtitle, useMediaQuery } from "./ui";
import { useChatScroll } from "./useChatScroll";

const GROUP_GAP_MS = 5 * 60 * 1000;
const HISTORY_PAGE_SIZE = 200;
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
  const { t: tr, locale } = useI18n();
  const { room, agents } = props;
  const [{ messages, state, sessions, asks, elicitations, conclusion, terminals, history }, dispatch] = useReducer(
    chatReducer,
    room.id,
    emptyChat,
  );
  const historyRequest = useRef(0);
  const historyPending = useRef(false);
  const nextBeforeSeq = history.initialized ? historyCursor(messages, history.nextBeforeSeq) : null;
  const [answers, setAnswers] = useState<Record<string, { pending: boolean; error: string | null }>>({});
  const pendingAnswers = useRef(new Set<string>());
  const pendingQuestions = useRef(elicitations);
  pendingQuestions.current = elicitations;
  const [retries, setRetries] = useState<Record<string, { pending: boolean; error: string | null }>>({});
  const pendingRetries = useRef(new Set<string>());
  const [cancellations, setCancellations] = useState<Record<string, { pending: boolean; error: string | null }>>({});
  const pendingCancellations = useRef(new Set<string>());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [jumpError, setJumpError] = useState<{ source: string; reason?: string } | null>(null);
  const [replay, setReplay] = useState<ReplayTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [quote, setQuote] = useState<MessageQuote | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<{ source: string; reason: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Compact replies keep the agent's words in separate bubbles; raw activity stays in details.
  const [compact, setCompact] = useState(() => localStorage.getItem("tuantuan:compact") !== "0");
  const densityAnimation = useRef<Animation | null>(null);
  useEffect(() => {
    localStorage.setItem("tuantuan:compact", compact ? "1" : "0");
  }, [compact]);
  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const stopMotion = () => {
      if (preference.matches) densityAnimation.current?.cancel();
    };
    preference.addEventListener("change", stopMotion);
    return () => {
      preference.removeEventListener("change", stopMotion);
      densityAnimation.current?.cancel();
    };
  }, []);
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
  const {
    listRef,
    following,
    followLatest,
    captureReadingPosition,
    restoreReadingPosition,
    preserveReadingPosition,
    onScroll,
    onWheel,
    onTouchMove,
    pause,
  } = useChatScroll();
  const [returnPosition, setReturnPosition] = useState<ReturnType<typeof captureReadingPosition>>(null);
  const densityAnchor = useRef<ReturnType<typeof preserveReadingPosition>>(null);
  useEffect(() => {
    const wrap = listRef.current?.parentElement;
    if (!wrap) return;
    const syncDisclosure = (event: Event) => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement)) return;
      // Closing content stays painted during its height transition but must leave the Tab order.
      for (const child of details.children)
        if (child instanceof HTMLElement && child.tagName !== "SUMMARY") child.inert = !details.open;
    };
    wrap.addEventListener("toggle", syncDisclosure, true);
    return () => wrap.removeEventListener("toggle", syncDisclosure, true);
  }, [listRef]);
  const showTerminal = useCallback(
    (open: boolean) => {
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
    return () => {
      // Route changes unmount this room. A page reload does not run React cleanup, so its
      // questions remain available in the next snapshot. Cancel only this room's known asks.
      for (const question of pendingQuestions.current) {
        if (question.roomId !== room.id) continue;
        void api("POST", `/api/elicitations/${question.id}`, { action: "cancel" }).catch((error) => {
          if (!(error instanceof ApiError && error.status === 404))
            console.warn("Unable to cancel question when leaving the conversation", error);
        });
      }
    };
  }, [room.id]);

  useEffect(() => {
    let alive = true;
    let requestId = 0;
    const load = async () => {
      const id = ++requestId;
      dispatch({ type: "load", roomId: room.id, id });
      try {
        const data = await api<ChatSnapshot>("GET", `/api/rooms/${room.id}/messages?limit=${HISTORY_PAGE_SIZE}`);
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
        e.type === "elicitation" ||
        e.type === "terminal" ||
        e.type === "room.state"
      ) {
        dispatch({ type: "event", event: e });
      }
    });
    return () => {
      alive = false;
      historyRequest.current++;
      off();
    };
  }, [room.id, props.subscribeEvents]);

  const loadHistory = async () => {
    const beforeSeq = nextBeforeSeq;
    if (beforeSeq === null || history.loading || historyPending.current) return;
    historyPending.current = true;
    const id = ++historyRequest.current;
    dispatch({ type: "history.load", roomId: room.id, id, beforeSeq });
    try {
      const data = await api<MessagePage>(
        "GET",
        `/api/rooms/${room.id}/messages?limit=${HISTORY_PAGE_SIZE}&beforeSeq=${beforeSeq}`,
      );
      if (id !== historyRequest.current) return;
      preserveReadingPosition();
      dispatch({ type: "history.page", roomId: room.id, id, data });
    } catch (e) {
      if (id !== historyRequest.current) return;
      preserveReadingPosition();
      dispatch({ type: "history.failed", roomId: room.id, id, error: (e as Error).message });
    } finally {
      if (id === historyRequest.current) historyPending.current = false;
    }
  };

  // Quotes and conclusion sources share history paging, but an invalid loaded phase must not page further.
  const jumpTarget = useRef<MessageTarget | null>(null);
  const loadHistoryRef = useRef(loadHistory);
  loadHistoryRef.current = loadHistory;
  const jumpToMessage = (messageId: string, partIndex?: number) => {
    const origin = captureReadingPosition();
    pause();
    setJumpError(null);
    jumpTarget.current = null;
    const target = { messageId, partIndex };
    const result = flashMessage(target);
    if (result === "found") {
      setReturnPosition((previous) => previous ?? origin);
      return;
    }
    if (result === "missing-phase" || nextBeforeSeq === null) {
      setJumpError({ source: "无法定位来源内容" });
      return;
    }
    setReturnPosition((previous) => previous ?? origin);
    jumpTarget.current = target;
    void loadHistoryRef.current();
  };
  useEffect(() => {
    const target = jumpTarget.current;
    if (!target) return;
    const result = flashMessage(target);
    if (result !== "missing-message") {
      jumpTarget.current = null;
      if (result === "missing-phase") setJumpError({ source: "无法定位来源内容" });
      return;
    }
    if (history.error || nextBeforeSeq === null) {
      jumpTarget.current = null;
      setJumpError(
        history.error
          ? { source: "加载失败：{reason}。请重试。", reason: history.error }
          : { source: "无法定位来源内容" },
      );
      return;
    }
    if (history.loading) return;
    void loadHistoryRef.current();
  }, [nextBeforeSeq, history.loading, history.error]);
  const clearJump = () => {
    jumpTarget.current = null;
    setJumpError(null);
    if (activeMessageHighlight) clearMessageHighlight(activeMessageHighlight);
  };
  const returnToReading = () => {
    clearJump();
    if (!returnPosition) return;
    listRef.current?.focus({ preventScroll: true });
    if (restoreReadingPosition(returnPosition)) setReturnPosition(null);
    else setJumpError({ source: "无法定位来源内容" });
  };
  const goToLatest = () => {
    clearJump();
    setReturnPosition(null);
    listRef.current?.focus({ preventScroll: true });
    followLatest();
  };

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

  const send = async () => {
    const content = draft.trim();
    if (sendingRef.current || (!content && images.length === 0)) return;
    // Sending resumes the tail now; a later upward gesture can revoke it before the HTTP reply arrives.
    followLatest();
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
        replyToPartIndex: quote?.partIndex,
      });
      setDraft("");
      setImages([]);
      setQuote(null);
      // The server's reply is authoritative: show it now even if the socket is slow, reconnecting or raced.
      dispatch({ type: "event", event: { type: "message", message: sent } });
    } catch (e) {
      setSendError({ source: "发送失败：{reason}", reason: (e as Error).message });
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
        [taskId]: { pending: false, error: (e as Error).message },
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
            [askId]: { pending: false, error: (e as Error).message },
          }));
        }
      } finally {
        pendingAnswers.current.delete(askId);
        setAnswers((a) => ({ ...a, [askId]: { pending: false, error: a[askId]?.error ?? null } }));
      }
    },
    [room.id],
  );

  const answerElicitation = useCallback(
    async (askId: string, action: "accept" | "cancel", content?: Record<string, ElicitationValue>) => {
      if (pendingAnswers.current.has(askId)) return;
      pendingAnswers.current.add(askId);
      setAnswers((a) => ({ ...a, [askId]: { pending: true, error: null } }));
      try {
        await api("POST", `/api/elicitations/${askId}`, { action, content });
        dispatch({ type: "event", event: { type: "elicitation", roomId: room.id, ask: null, resolvedId: askId } });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          // Another client, cancellation or a duplicate submit already resolved this question.
          dispatch({ type: "event", event: { type: "elicitation", roomId: room.id, ask: null, resolvedId: askId } });
        } else {
          setAnswers((a) => ({ ...a, [askId]: { pending: false, error: (e as Error).message } }));
        }
      } finally {
        pendingAnswers.current.delete(askId);
        setAnswers((a) => ({ ...a, [askId]: { pending: false, error: a[askId]?.error ?? null } }));
      }
    },
    [room.id],
  );

  const retryRequest = useCallback(
    async (messageId: string) => {
      if (pendingRetries.current.has(messageId)) return;
      pendingRetries.current.add(messageId);
      setRetries((current) => ({ ...current, [messageId]: { pending: true, error: null } }));
      try {
        followLatest();
        const sent = await api<Message>("POST", `/api/rooms/${room.id}/messages/${messageId}/retry`);
        dispatch({ type: "event", event: { type: "message", message: sent } });
        setRetries((current) => {
          const next = { ...current };
          delete next[messageId];
          return next;
        });
      } catch (e) {
        setRetries((current) => ({
          ...current,
          [messageId]: { pending: false, error: (e as Error).message },
        }));
      } finally {
        pendingRetries.current.delete(messageId);
      }
    },
    [room.id, followLatest],
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
      setSendError({ source: "{reason}", reason: (e as Error).message });
    }
  };

  const openDetails = (id: string) => {
    preserveReadingPosition();
    setSelected((cur) => (cur === id && panel ? null : id));
    setPanel(true);
  };

  const changeCompact = (value: boolean) => {
    const list = listRef.current;
    const reversing = densityAnimation.current?.playState === "running";
    const opacity = list && reversing ? getComputedStyle(list).opacity : "0.55";
    const anchor = reversing ? densityAnchor.current : null;
    densityAnimation.current?.cancel();
    densityAnchor.current = preserveReadingPosition(anchor);
    flushSync(() => setCompact(value));
    // Animate the transcript itself: document snapshots briefly intercept rapid clicks on the switch.
    if (!list || reducedMotion() || document.hidden) return;
    const animation = list.animate([{ opacity }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
    densityAnimation.current = animation;
    animation.onfinish = animation.oncancel = () => {
      if (densityAnimation.current === animation) {
        densityAnimation.current = null;
        densityAnchor.current = null;
      }
    };
  };

  const groups = groupMessages(messages);
  const tasks = state.tasks;
  const stopTask = tasks.length === 1 ? tasks[0] : undefined;
  const selectedMsg = messages.find((m) => m.id === selected);
  const ask = asks[0];
  // Inline questions stay mounted while another agent asks for permission, preserving draft answers.
  const elicitation = elicitations[0];

  return (
    <div className="conversation-workspace">
      <div className="chat-wrap">
        <div className="chat">
          <header className="main-head chat-head">
            <button
              type="button"
              className="btn ghost icon back-btn"
              onClick={props.onBack}
              aria-label={tr("返回会话列表")}
              data-shot="open-nav"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              className="title-pill"
              title={roomSubtitle(room, agents)}
              onClick={() => {
                preserveReadingPosition();
                setPanel(true);
              }}
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
                  aria-label={terminalOpen ? tr("收起项目终端") : tr("打开项目终端")}
                  title={tr("终端（Ctrl+`）")}
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
                  aria-label={panel ? tr("收起详情面板") : tr("展开详情面板")}
                  title={tr("详情面板")}
                  onClick={() => {
                    preserveReadingPosition();
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
              <AlertTriangle size={15} /> {tr("消息加载失败：{reason}", { reason: translateError(loadError) })}
            </div>
          )}

          <div className="messages-wrap">
            <section
              className="messages"
              ref={listRef}
              tabIndex={-1}
              aria-label={tr("会话消息")}
              onWheel={onWheel}
              onTouchMove={onTouchMove}
              onScroll={onScroll}
            >
              {nextBeforeSeq !== null && (
                <div className="chat-history">
                  <button
                    type="button"
                    className="btn ghost sm"
                    aria-disabled={!!history.loading}
                    onClick={() => void loadHistory()}
                  >
                    <History size={14} />
                    {history.loading ? tr("加载中…") : tr("加载更早消息")}
                  </button>
                  <span className="chat-history-status" role={history.error ? "alert" : "status"}>
                    {history.error ? tr("加载失败：{reason}。请重试。", { reason: translateError(history.error) }) : ""}
                  </span>
                </div>
              )}
              {messages.length === 0 && replay.length === 0 && !loadError && (
                <div className="empty">
                  <RoomIcon room={room} agents={agents} />
                  <h2 style={{ fontSize: 17 }}>
                    {members.length > 1
                      ? tr("开始聊天")
                      : tr("和 {name} 打个招呼", { name: members[0]?.name ?? "Agent" })}
                  </h2>
                  {primary && !primary.harness && (
                    <p className="muted">
                      {tr("{name} 还没有绑定 Harness，", { name: primary.name })}
                      <a href={`#/a/${primary.id}`}>{tr("去设置")}</a>
                      {tr("或")}
                      <a href="#/harness">{tr("管理 Harness")}</a>
                      {tr("。")}
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
                  <div key={g.messages[0]?.id} className="system-line" role="note" data-message-id={g.messages[0]?.id}>
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
                      {g.kind === "agent" && !agentById.has(g.senderId ?? "") && (
                        <span className="badge">{tr("已删除")}</span>
                      )}
                      <span className="time">{formatTime(g.messages[0]?.createdAt ?? 0, locale)}</span>
                    </div>
                    {g.messages.map((m) => (
                      <MessageItem
                        key={m.id}
                        m={m}
                        onQuote={
                          room.kind === "group" && canQuoteMessage(m)
                            ? (partIndex) => setQuote(messageQuote(m, partIndex))
                            : undefined
                        }
                        quoteDisabled={sending}
                        terminals={terminals}
                        mentionNames={mentionNames}
                        compact={compact}
                        selected={selected === m.id && panel}
                        onDetails={() => openDetails(m.id)}
                        onJumpToQuote={jumpToMessage}
                        harnessId={agentById.get(m.senderId ?? "")?.harness}
                        retry={m.senderKind === "agent" && m.status === "interrupted" ? retries[m.id] : undefined}
                        onRetry={
                          m.senderKind === "agent" && m.status === "interrupted"
                            ? () => void retryRequest(m.id)
                            : undefined
                        }
                      />
                    ))}
                  </div>
                ),
              )}
            </section>
            <div className="msg-fade msg-fade-top" aria-hidden />
            <div className="msg-fade msg-fade-bottom" aria-hidden />
            {(returnPosition || !following) && (
              <div className="chat-scroll-actions">
                {returnPosition && (
                  <button type="button" className="btn sm chat-return" onClick={returnToReading}>
                    <ChevronLeft size={14} />
                    {tr("返回刚才位置")}
                  </button>
                )}
                {!following && (
                  <button
                    type="button"
                    className="btn sm chat-latest"
                    onClick={goToLatest}
                    aria-label={tr("回到最新消息")}
                  >
                    <ArrowDown size={14} />
                    {tr("回到最新")}
                  </button>
                )}
              </div>
            )}
          </div>

          <footer className="composer">
            {jumpError && (
              <p className="quote-navigation-feedback" role="status">
                {tr(jumpError.source, { reason: translateError(jumpError.reason ?? "") })}
              </p>
            )}
            {elicitation && (
              <ElicitationDialog
                key={elicitation.id}
                ask={elicitation}
                agentName={agentById.get(elicitation.agentId)?.name ?? "Agent"}
                pending={answers[elicitation.id]?.pending ?? false}
                error={answers[elicitation.id]?.error ?? null}
                onAccept={(content) => void answerElicitation(elicitation.id, "accept", content)}
                onCancel={() => void answerElicitation(elicitation.id, "cancel")}
              />
            )}
            {(tasks.length > 0 || conclusion) && (
              <ReplyStatus
                tasks={tasks}
                agents={agentById}
                cancellations={cancellations}
                onCancel={(id) => void cancel(id)}
                conclusion={conclusion}
                onJump={() => {
                  if (conclusion) void jumpToMessage(conclusion.messageId);
                }}
              />
            )}
            {sendError && (
              <div className="error-text" role="alert" style={{ marginBottom: 6 }}>
                {tr(sendError.source, { reason: translateError(sendError.reason) })}
              </div>
            )}
            <Composer
              value={draft}
              quote={quote}
              onCancelQuote={() => setQuote(null)}
              onJumpToQuote={jumpToMessage}
              sending={sending}
              onChange={setDraft}
              onSubmit={() => void send()}
              members={members.length > 1 ? members : []}
              placeholder={
                primaryView?.commands.length || primaryView?.skills.length
                  ? tr("发消息，/ 命令 · $ Skills…")
                  : tr("发消息…")
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
            error={
              answers[ask.id]?.error
                ? tr("授权提交失败：{reason}。请重试。", { reason: translateError(answers[ask.id]?.error ?? "") })
                : null
            }
            onAnswer={(optionId) => void answer(ask.id, optionId)}
          />
        )}

        {panelPresence.mounted && (
          <>
            {!wide && (
              // biome-ignore lint/a11y/noStaticElementInteractions: scrim closes the overlay panel; the close button is the keyboard path
              // biome-ignore lint/a11y/useKeyWithClickEvents: see above
              <div
                className="scrim"
                data-state={panelPresence.state}
                onClick={() => {
                  preserveReadingPosition();
                  setPanel(false);
                }}
              />
            )}
            {/* The slot reserves the panel's column and resizes in step with the slide, so the chat never jumps. */}
            <div className="details-slot" data-state={panelPresence.state}>
              <aside className="details" data-state={panelPresence.state} aria-label={tr("详情面板")}>
                <div className="details-head">
                  {selectedMsg && (
                    <button
                      type="button"
                      className="btn ghost icon"
                      aria-label={tr("返回会话信息")}
                      title={tr("返回会话信息")}
                      onClick={() => setSelected(null)}
                    >
                      <ChevronLeft size={16} />
                    </button>
                  )}
                  <h3>{selectedMsg ? tr("回复详情") : tr("会话信息")}</h3>
                  <div className="details-actions">
                    <button
                      type="button"
                      className="btn ghost icon"
                      aria-label={tr("关闭详情面板")}
                      onClick={() => {
                        preserveReadingPosition();
                        setPanel(false);
                      }}
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
                      terminals={terminals}
                      mentionNames={mentionNames}
                    />
                  ) : (
                    <RoomInfo
                      room={room}
                      project={props.project}
                      agents={agents}
                      members={members}
                      messages={messages}
                      sessions={sessions}
                      compact={compact}
                      onCompactChange={changeCompact}
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
                      {tr("正在打开终端…")}
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

const messageHighlights = new WeakMap<HTMLElement, { timer: number; animations: Animation[]; bodies: HTMLElement[] }>();
let activeMessageHighlight: HTMLElement | null = null;
type MessageTarget = { messageId: string; partIndex?: number };

function clearMessageHighlight(element: HTMLElement) {
  const highlight = messageHighlights.get(element);
  if (highlight) {
    window.clearTimeout(highlight.timer);
    for (const animation of highlight.animations) animation.cancel();
    for (const body of highlight.bodies) delete body.dataset.sourceHighlight;
    messageHighlights.delete(element);
  }
  delete element.dataset.flash;
  if (activeMessageHighlight === element) activeMessageHighlight = null;
}

/** Reveal a rendered source; only the agent's original words/images receive the brief highlight. */
function flashMessage({ messageId, partIndex }: MessageTarget): "found" | "missing-message" | "missing-phase" {
  if (activeMessageHighlight) clearMessageHighlight(activeMessageHighlight);
  const element = document.querySelector<HTMLElement>(`.message-row[data-message-id="${CSS.escape(messageId)}"]`);
  if (!element) return "missing-message";
  const bodies = [
    ...element.querySelectorAll<HTMLElement>(
      partIndex === undefined ? "[data-message-body]" : `[data-message-body][data-body-phase="${partIndex}"]`,
    ),
  ];
  if (partIndex !== undefined && bodies.length === 0) return "missing-phase";
  const destination =
    partIndex === undefined ? element : (bodies[0]?.closest<HTMLElement>(".compact-bubble") ?? bodies[0]);
  // Newly paged bubbles may still be translated by their entrance. Center their final geometry.
  if (destination?.classList.contains("compact-bubble")) {
    for (const animation of destination.getAnimations())
      if (animation instanceof CSSAnimation && animation.animationName === "t-rise-in") animation.finish();
  }
  destination?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  const animations: Animation[] = [];
  element.dataset.flash = "";
  for (const body of bodies) {
    body.dataset.sourceHighlight = "";
    if (!reducedMotion()) {
      const backgroundColor = getComputedStyle(body).backgroundColor;
      animations.push(
        body.animate([{ backgroundColor }, { backgroundColor, offset: 0.3 }, { backgroundColor: "transparent" }], {
          duration: 1400,
          easing: "ease-out",
          fill: "forwards",
        }),
      );
    }
  }
  const timer = window.setTimeout(() => clearMessageHighlight(element), 1400);
  messageHighlights.set(element, { timer, animations, bodies });
  activeMessageHighlight = element;
  return "found";
}

function MessageItem(props: {
  m: Message;
  terminals: Record<string, TerminalSnapshot>;
  mentionNames: string[];
  compact: boolean;
  selected: boolean;
  onDetails: () => void;
  onJumpToQuote: (messageId: string, partIndex?: number) => void;
  harnessId?: string;
  onQuote?: (partIndex?: number) => void;
  quoteDisabled?: boolean;
  retry?: { pending: boolean; error: string | null };
  onRetry?: () => void;
}) {
  const { t: tr } = useI18n();
  const { m } = props;
  const streaming = m.status === "streaming";
  const compact = props.compact && m.senderKind === "agent";
  const t = m.timeline;
  const empty = !t || t.parts.length === 0;
  const compactHasBody =
    compact &&
    (m.content.trim() || t?.parts.some((part) => part.kind === "image" || (part.kind === "text" && part.text.trim())));
  const renderActions = (copyText?: string, partIndex?: number) => (
    <MessageActions
      message={m}
      copyText={copyText}
      onQuote={props.onQuote ? () => props.onQuote?.(partIndex) : undefined}
      quoteDisabled={props.quoteDisabled}
      onDetails={m.senderKind === "agent" ? props.onDetails : undefined}
      selected={props.selected}
    />
  );
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = row.current;
    return () => {
      if (element) clearMessageHighlight(element);
    };
  }, []);
  return (
    <div
      ref={row}
      className="message-row"
      data-message-id={m.id}
      data-sender={m.senderKind}
      data-compact={compact ? "" : undefined}
    >
      <div
        className="msg"
        data-sender={m.senderKind}
        data-status={m.status}
        data-fresh={Date.now() - m.createdAt < 4000 ? "" : undefined}
      >
        {m.quote && <QuoteExcerpt quote={m.quote} onJump={props.onJumpToQuote} />}
        {!compact && t?.handoffFrom && (
          <div className="handoff-from">
            <div className="handoff-title">
              <ArrowRightLeft size={12} />
              <span>{tr("接 {name} 的交接：{task}", { name: `@${t.handoffFrom.agentName}`, task: "" })}</span>
            </div>
            <HandoffTask task={t.handoffFrom.task} />
            {t.handoffFrom.context && <TaskContextNote context={t.handoffFrom.context} />}
          </div>
        )}
        {m.senderKind === "human" ? (
          <>
            {m.content && (
              <div data-message-body="">
                <MessageMarkdown text={m.content} mentionNames={props.mentionNames} />
              </div>
            )}
            {t && (
              <TimelineView t={t} streaming={false} terminals={props.terminals} mentionNames={props.mentionNames} />
            )}
          </>
        ) : compact ? (
          <CompactReply
            m={m}
            terminals={props.terminals}
            mentionNames={props.mentionNames}
            onDetails={props.onDetails}
            renderActions={renderActions}
          />
        ) : t ? (
          <TimelineView
            t={t}
            streaming={streaming}
            terminals={props.terminals}
            mentionNames={props.mentionNames}
            hideHandoffTools
          />
        ) : (
          m.content && (
            <div data-message-body="">
              <MessageMarkdown text={m.content} mentionNames={props.mentionNames} />
            </div>
          )
        )}
        {!compact &&
          t?.handoffs?.map((h) => (
            <div key={h.agentId} className="handoff-card" role="note">
              <div className="handoff-title">
                <ArrowRightLeft size={13} />
                {tr("交接给 {name}", { name: `@${h.agentName}` })}
              </div>
              <HandoffTask task={h.task} />
              {h.context && <TaskContextNote context={h.context} />}
            </div>
          ))}
        {!compact && m.senderKind === "agent" && m.status === "done" && t?.taskContext && (
          <TaskContextNote context={t.taskContext} saved />
        )}
        {!compact && m.senderKind === "agent" && empty && !m.content && streaming && (
          <span className="typing">
            <i />
            <i />
            <i />
            {tr("正在思考")}
            <Waited since={m.createdAt} />
          </span>
        )}
        {!compact && m.senderKind === "agent" && empty && !m.content && m.status === "done" && (
          <span className="muted">{tr("（空回复）")}</span>
        )}
        {m.status === "error" && (
          <div className="msg-error" role="alert">
            <AlertTriangle size={14} />
            <span>{m.error ? translateError(m.error) : tr("回复失败")}</span>
          </div>
        )}
        {m.status === "error" && m.error && <MissingKey harnessId={props.harnessId} error={m.error} />}
        {m.status === "interrupted" && (
          <div className="msg-interrupted">
            <div className="msg-error">
              <AlertTriangle size={14} />
              <span>{m.error ? translateError(m.error) : tr("回复被中断")}</span>
            </div>
            {props.onRetry && (
              <button
                type="button"
                className="btn sm"
                disabled={props.retry?.pending}
                aria-busy={props.retry?.pending}
                onClick={props.onRetry}
              >
                <RotateCcw size={13} />
                {props.retry?.pending ? tr("正在重试…") : tr("重试此请求")}
              </button>
            )}
            {props.retry?.error && (
              <div className="error-text" role="alert">
                {tr("重试失败：{reason}。请重试。", { reason: translateError(props.retry.error) })}
              </div>
            )}
          </div>
        )}
        {m.senderKind === "agent" && !streaming && ((!compact && t?.reviewOf) || m.status === "cancelled") && (
          <div className="msg-meta">
            {!compact && t?.reviewOf && (
              <span className="muted">{tr("群主跟进 · 已收到 {count} 份成员结果", { count: t.reviewOf.length })}</span>
            )}
            {m.status === "cancelled" && (
              <span className="state-tag">
                <CircleSlash size={11} />
                {m.error === "被新消息打断" ? tr("被新消息打断") : tr("已停止")}
              </span>
            )}
          </div>
        )}
      </div>
      {(!compact || !compactHasBody) && renderActions(compact ? "" : undefined)}
    </div>
  );
}

/** Keep the agent's original reply in the transcript; raw activity stays in message details. */
function CompactReply(props: {
  m: Message;
  terminals: Record<string, TerminalSnapshot>;
  mentionNames: string[];
  onDetails: () => void;
  renderActions: (text: string, partIndex?: number) => ReactNode;
}) {
  const { t: tr } = useI18n();
  const { m } = props;
  const t = m.timeline;
  const streaming = m.status === "streaming";
  const timelineBody = t?.parts.some((p) => p.kind === "image" || (p.kind === "text" && p.text.trim()));
  const hasBody = timelineBody || Boolean(m.content.trim());
  const hasFailedTool = m.status === "done" && Object.values(t?.tools ?? {}).some((tool) => tool.status === "failed");
  return (
    <div className="compact-reply">
      {streaming && !hasBody && (
        <div className="compact-live compact-bubble" role="status">
          <Loader2 size={13} className="spin" />
          <span>{tr("正在处理")}</span>
        </div>
      )}
      {hasBody && (
        <div className="compact-body">
          {timelineBody && t ? (
            <TimelineView
              t={t}
              view="body"
              streaming={streaming}
              terminals={props.terminals}
              mentionNames={props.mentionNames}
              renderBodyActions={(phase) => props.renderActions(phase.text, phase.start)}
            />
          ) : (
            <div className="compact-phase-row">
              <div className="compact-bubble" data-reply-phase={-1}>
                <div data-message-body="">
                  <MessageMarkdown text={m.content} mentionNames={props.mentionNames} />
                </div>
              </div>
              {props.renderActions(m.content)}
            </div>
          )}
        </div>
      )}
      {m.status === "done" && (!hasBody || hasFailedTool) && (
        <div className="compact-notice">
          {!hasBody && <span>{tr("未提供文字结果")}</span>}
          {hasFailedTool && <span>{tr("过程中有异常记录")}</span>}
          <button type="button" onClick={props.onDetails}>
            {tr("查看详情")}
          </button>
        </div>
      )}
    </div>
  );
}

function HandoffTask({ task }: { task: string }) {
  const { t: tr } = useI18n();
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded task region needs keyboard scrolling
    <section className="handoff-task" tabIndex={0} aria-label={tr("交接任务")}>
      {task}
    </section>
  );
}

/** The latest successful note remains available independently of the current reply state. */
function RoomConclusionCard(props: {
  conclusion: RoomConclusion;
  open: boolean;
  id: string;
  panelRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onJump: () => void;
}) {
  const { t: tr } = useI18n();
  const titleId = useId();
  const { context } = props.conclusion;
  return (
    <section
      ref={props.panelRef}
      id={props.id}
      className="room-conclusion"
      aria-labelledby={titleId}
      aria-hidden={!props.open}
      inert={!props.open}
      data-open={props.open || undefined}
    >
      <div className="room-conclusion-head">
        <h3 id={titleId}>{tr("当前结论")}</h3>
        <span className="room-conclusion-counts">
          {tr("{decisions} 项决策 · {pending} 项未完成", {
            decisions: context.decisions.length,
            pending: context.pending.length,
          })}
        </span>
        <button type="button" className="btn ghost icon sm" aria-label={tr("收起结论")} onClick={props.onClose}>
          <X size={15} aria-hidden />
        </button>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: long conclusions need a keyboard-scrollable region */}
      <div className="room-conclusion-grid" tabIndex={0}>
        <div className="room-conclusion-goal">
          <span className="room-conclusion-label">{tr("任务目标")}</span>
          <p>{context.goal || tr("暂无记录")}</p>
        </div>
        <div>
          <span className="room-conclusion-label">{tr("关键决策")}</span>
          {context.decisions.length ? (
            <ul>
              {context.decisions.map((decision, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: snapshot entries have no ids and are replaced wholesale
                <li key={index}>{decision}</li>
              ))}
            </ul>
          ) : (
            <span className="muted">{tr("暂无记录")}</span>
          )}
        </div>
        <div>
          <span className="room-conclusion-label">{tr("未完成事项")}</span>
          {context.pending.length ? (
            <ul>
              {context.pending.map((pending, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: snapshot entries have no ids and are replaced wholesale
                <li key={index}>{pending}</li>
              ))}
            </ul>
          ) : (
            <span className="muted">{tr("无未完成事项")}</span>
          )}
        </div>
      </div>
      <div className="room-conclusion-foot">
        <button type="button" className="room-conclusion-source" aria-label={tr("查看来源消息")} onClick={props.onJump}>
          <ArrowUpRight size={14} aria-hidden />
          {tr("查看来源消息")}
        </button>
      </div>
    </section>
  );
}

function TaskContextNote({ context, saved = false }: { context: TaskContext; saved?: boolean }) {
  const { t: tr } = useI18n();
  const summaryId = useId();
  return (
    <details className="task-context" data-kind={saved ? "saved" : "handoff"}>
      <summary id={summaryId}>
        <ChevronRight size={13} aria-hidden="true" />
        {tr(saved ? "已保存任务笔记" : "交接笔记")}
      </summary>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded notes region needs keyboard scrolling */}
      <section className="task-context-content" aria-labelledby={summaryId} tabIndex={0}>
        <dl>
          <div>
            <dt>{tr("任务目标")}</dt>
            <dd>{context.goal || tr("暂无记录")}</dd>
          </div>
          <div>
            <dt>{tr("关键决策")}</dt>
            <dd>
              {context.decisions.length ? (
                <ul>
                  {context.decisions.map((decision, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: snapshot entries have no ids and are replaced wholesale
                    <li key={index}>{decision}</li>
                  ))}
                </ul>
              ) : (
                <span className="muted">{tr("暂无记录")}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>{tr("未完成事项")}</dt>
            <dd>
              {context.pending.length ? (
                <ul>
                  {context.pending.map((pending, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: snapshot entries have no ids and are replaced wholesale
                    <li key={index}>{pending}</li>
                  ))}
                </ul>
              ) : (
                <span className="muted">{tr("无未完成事项")}</span>
              )}
            </dd>
          </div>
        </dl>
      </section>
    </details>
  );
}

/** One disclosure owner for live reply details and the latest accepted conclusion. */
function ReplyStatus(props: {
  tasks: RoomState["tasks"];
  agents: Map<string, Agent>;
  cancellations: Record<string, { pending: boolean; error: string | null }>;
  onCancel: (id: string) => void;
  conclusion: RoomConclusion | null;
  onJump: () => void;
}) {
  const { t: tr } = useI18n();
  const [disclosure, setDisclosure] = useState<"tasks" | "conclusion" | null>(null);
  const root = useRef<HTMLElement>(null);
  const taskDisclosure = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const conclusionToggle = useRef<HTMLButtonElement>(null);
  const conclusionPanel = useRef<HTMLElement>(null);
  const listId = useId();
  const summaryId = useId();
  const conclusionId = useId();
  const hasTasks = props.tasks.length > 0;
  const hasConclusion = !!props.conclusion;
  const expanded = disclosure === "tasks" && hasTasks;
  const conclusionOpen = disclosure === "conclusion" && hasConclusion;
  const closeConclusion = useCallback(() => {
    if (conclusionPanel.current?.contains(document.activeElement))
      conclusionToggle.current?.focus({ preventScroll: true });
    setDisclosure((current) => (current === "conclusion" ? null : current));
  }, []);
  useEffect(() => {
    setDisclosure((current) => {
      if ((current === "tasks" && !hasTasks) || (current === "conclusion" && !hasConclusion)) return null;
      return current;
    });
  }, [hasTasks, hasConclusion]);
  useEffect(() => {
    if (!conclusionOpen) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!conclusionPanel.current?.contains(event.target) && !conclusionToggle.current?.contains(event.target))
        closeConclusion();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      closeConclusion();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [conclusionOpen, closeConclusion]);
  useLayoutEffect(() => {
    if (!conclusionOpen) return;
    const element = root.current;
    if (!element) return;
    const viewport = window.visualViewport;
    const update = () => {
      const top = viewport?.offsetTop ?? 0;
      element.style.setProperty(
        "--conclusion-space",
        `${Math.max(0, element.getBoundingClientRect().top - top - 20)}px`,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const composer = element.closest(".composer");
    if (composer) observer.observe(composer);
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [conclusionOpen]);
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
        ? tr("正在停止")
        : task.status === "queued"
          ? queued > 1
            ? tr("{count} 项排队", { count: queued })
            : tr("排队中")
          : task.status === "waiting"
            ? task.coordination === "lead" || task.coordination === "review"
              ? tr("等待成员结果")
              : tr("等待交接完成")
            : task.coordination === "review"
              ? tr("正在跟进")
              : task.messageId
                ? tr("正在回复")
                : tr("正在准备");
    return { task, status, queued: task.status === "queued" ? 0 : queued };
  });
  const overflow = participants.slice(3);
  const single = props.tasks.length === 1 ? props.tasks[0] : undefined;
  const singleStopping = !!single && (props.cancellations[single.id]?.pending || single.status === "cancelling");
  return (
    <section ref={root} className="chat-tasks" aria-label={tr("会话任务")} data-expanded={expanded}>
      <div className="chat-activity">
        {hasTasks && (
          <button
            ref={toggleRef}
            type="button"
            className="chat-activity-toggle"
            aria-label={expanded ? tr("收起回复状态") : tr("展开回复状态")}
            aria-expanded={expanded}
            aria-controls={listId}
            aria-describedby={summaryId}
            onClick={() => {
              closeConclusion();
              if (expanded && taskDisclosure.current?.contains(document.activeElement)) toggleRef.current?.focus();
              setDisclosure((current) => (current === "tasks" ? null : "tasks"));
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
                      {tr("{count} 项排队", { count: queued })}
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
                    {tr("还有 {count} 位 Agent：{agents}", {
                      count: overflow.length,
                      agents: overflow.map(({ task, status }) => `${task.agentName} ${status}`).join("; "),
                    })}
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
        )}
        {single && (
          <button
            type="button"
            className="chat-activity-stop"
            data-hidden={expanded || undefined}
            aria-hidden={expanded}
            inert={expanded}
            aria-label={single.status === "queued" ? tr("取消排队") : tr("停止任务")}
            title={single.status === "queued" ? tr("取消排队") : tr("停止任务")}
            aria-describedby={summaryId}
            disabled={singleStopping}
            onClick={() => props.onCancel(single.id)}
          >
            <Square size={10} fill="currentColor" aria-hidden />
          </button>
        )}
        {props.conclusion && (
          <button
            ref={conclusionToggle}
            type="button"
            className={`room-conclusion-toggle${hasTasks ? "" : " is-idle"}`}
            aria-label={conclusionOpen ? tr("收起结论") : tr("展开结论")}
            aria-expanded={conclusionOpen}
            aria-controls={conclusionId}
            onClick={() => {
              if (conclusionOpen) closeConclusion();
              else {
                if (taskDisclosure.current?.contains(document.activeElement)) toggleRef.current?.focus();
                setDisclosure("conclusion");
              }
            }}
          >
            <Pin size={13} aria-hidden />
            <span>{tr("当前结论")}</span>
            {!hasTasks && (
              <span className="room-conclusion-goal-line">{props.conclusion.context.goal || tr("暂无记录")}</span>
            )}
            <ChevronRight size={13} className="chev" aria-hidden />
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
                  {tr("未能停止 {name}：{reason}。请重试。", { name: task.agentName, reason: translateError(error) })}
                </span>
              </div>
            ) : null;
          })}
        </div>
      </div>
      <div ref={taskDisclosure} className="chat-task-disclosure" id={listId} inert={!expanded} aria-hidden={!expanded}>
        <div className="chat-task-clip">
          <ul className="chat-task-list">
            {props.tasks.map((task) => {
              const cancellation = props.cancellations[task.id];
              const status =
                task.status === "queued"
                  ? tr("排队中")
                  : task.status === "cancelling"
                    ? tr("停止中")
                    : task.status === "waiting"
                      ? task.coordination === "lead" || task.coordination === "review"
                        ? tr("统筹中")
                        : tr("交接中")
                      : task.coordination === "review"
                        ? tr("跟进中")
                        : task.messageId
                          ? tr("回复中")
                          : tr("准备中");
              return (
                <li className="chat-task" key={task.id} data-task-id={task.id} data-task-status={task.status}>
                  <div className="chat-task-content" id={`task-summary-${task.id}`}>
                    <div className="chat-task-title">
                      <AgentAvatar agent={props.agents.get(task.agentId)} name={task.agentName} size={18} />
                      <span className="chat-task-name">{task.agentName}</span>
                      <span className="chat-task-state">{status}</span>
                    </div>
                    <div className="chat-task-summary">{task.text || tr("正在准备回复…")}</div>
                    {cancellation?.error && (
                      <div className="chat-task-error" role="alert">
                        {tr("停止失败：{reason}。请重试。", { reason: translateError(cancellation.error) })}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn ghost sm chat-task-stop"
                    aria-label={task.status === "queued" ? tr("取消排队") : tr("停止任务")}
                    aria-describedby={`task-summary-${task.id}`}
                    disabled={cancellation?.pending || task.status === "cancelling"}
                    onClick={() => props.onCancel(task.id)}
                  >
                    {cancellation?.pending || task.status === "cancelling"
                      ? tr("停止中…")
                      : task.status === "queued"
                        ? tr("取消排队")
                        : tr("停止")}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      {props.conclusion && (
        <RoomConclusionCard
          conclusion={props.conclusion}
          open={conclusionOpen}
          id={conclusionId}
          panelRef={conclusionPanel}
          onClose={closeConclusion}
          onJump={() => {
            flushSync(closeConclusion);
            props.onJump();
          }}
        />
      )}
    </section>
  );
}

function QuoteExcerpt({
  quote,
  onJump,
}: {
  quote: MessageQuote;
  onJump: (messageId: string, partIndex?: number) => void;
}) {
  const { t: tr } = useI18n();
  return (
    <blockquote className="message-quote" aria-label={tr("引用 {name} 的消息", { name: quote.senderName })}>
      <button
        type="button"
        className="message-quote-link"
        aria-label={tr("查看 {name} 的原消息", { name: quote.senderName })}
        onClick={() => onJump(quote.messageId, quote.partIndex)}
      >
        <span className="message-quote-author">{quote.senderName}</span>
        <span className="message-quote-text">{quote.text}</span>
      </button>
    </blockquote>
  );
}

/** After a while with no output, say so (a harness can sit silently while it retries upstream). */
function Waited({ since }: { since: number }) {
  const { t: tr } = useI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((now - since) / 1000);
  if (s < 15) return null;
  return <span className="waited">{tr("· {count} 秒无响应，可停止后重试", { count: s })}</span>;
}

/** History a harness replayed on session/load that this room never showed (read-only). */
function ReplayHistory(props: { turns: ReplayTurn[]; agentName: string; terminals: Record<string, TerminalSnapshot> }) {
  const { t: tr } = useI18n();
  return (
    <details className="replay" open>
      <summary>
        <History size={13} /> {tr("载入的 Harness 历史 · {count} 轮", { count: props.turns.length })}
      </summary>
      {props.turns.map((turn, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: replayed turns have no ids and never reorder
        <div key={i} className="replay-turn">
          {turn.user && (
            <div className="replay-user">
              <span className="name">{tr("我")}</span>
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

function MessageDetails(props: {
  m: Message;
  agent?: Agent;
  harnessName: (id: string) => string;
  terminals: Record<string, TerminalSnapshot>;
  mentionNames: string[];
}) {
  const { t: tr, locale } = useI18n();
  const { m, agent } = props;
  const tools = Object.values(m.timeline?.tools ?? {});
  const status: Record<Message["status"], string> = {
    streaming: "回复中",
    done: "正常结束",
    error: "回复失败",
    cancelled: "已取消",
    interrupted: "回复被中断",
  };
  return (
    <>
      <section className="d-section">
        <dl className="kv">
          <dt>Agent</dt>
          <dd>{m.senderName}</dd>
          <dt>Harness</dt>
          <dd>{agent?.harness ? props.harnessName(agent.harness) : "—"}</dd>
          <dt>{tr("状态")}</dt>
          <dd>
            {m.timeline?.stopReason
              ? tr(STOP_LABEL[m.timeline.stopReason] ?? m.timeline.stopReason)
              : tr(status[m.status])}
            {m.error && <div className="error-text">{translateError(m.error)}</div>}
          </dd>
          <dt>{tr("工具")}</dt>
          <dd>{tools.length === 0 ? tr("无") : tools.map((t) => t.title).join(locale === "en" ? ", " : "、")}</dd>
          <dt>{tr("时间")}</dt>
          <dd>{new Date(m.createdAt).toLocaleString(intlLocale(locale))}</dd>
        </dl>
      </section>
      {m.timeline?.handoffFrom && (
        <section className="d-section">
          <div className="handoff-from">
            <div className="handoff-title">
              <ArrowRightLeft size={12} />
              <span>{tr("接 {name} 的交接：{task}", { name: `@${m.timeline.handoffFrom.agentName}`, task: "" })}</span>
            </div>
            <HandoffTask task={m.timeline.handoffFrom.task} />
            {m.timeline.handoffFrom.context && <TaskContextNote context={m.timeline.handoffFrom.context} />}
          </div>
        </section>
      )}
      {m.timeline?.handoffs?.map((handoff) => (
        <section key={handoff.agentId} className="d-section">
          <div className="handoff-card" role="note">
            <div className="handoff-title">
              <ArrowRightLeft size={13} />
              {tr("交接给 {name}", { name: `@${handoff.agentName}` })}
            </div>
            <HandoffTask task={handoff.task} />
            {handoff.context && <TaskContextNote context={handoff.context} />}
          </div>
        </section>
      ))}
      {((m.status === "done" && m.timeline?.taskContext) || m.timeline?.reviewOf) && (
        <section className="d-section">
          {m.timeline.reviewOf && (
            <p className="muted">{tr("群主跟进 · 已收到 {count} 份成员结果", { count: m.timeline.reviewOf.length })}</p>
          )}
          {m.status === "done" && m.timeline.taskContext && <TaskContextNote context={m.timeline.taskContext} saved />}
        </section>
      )}
      {m.timeline && (m.timeline.parts.length > 0 || (m.timeline.plan?.length ?? 0) > 0) && (
        <section className="d-section">
          <h4>{tr("完整时间线")}</h4>
          <TimelineView
            t={m.timeline}
            streaming={false}
            terminals={props.terminals}
            mentionNames={props.mentionNames}
          />
        </section>
      )}
    </>
  );
}

/** Harness session controls for one agent: current session, new session, sessions the harness remembers. */
function SessionSection(props: { room: Room; agent: Agent; view?: SessionView; solo: boolean }) {
  const { t: tr, locale } = useI18n();
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
        {props.solo ? tr("Harness 会话") : tr("{name} 的会话", { name: agent.name })}
        <span style={{ display: "flex", gap: 4 }}>
          {view?.capabilities.list && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void run(async () => setList(await api("GET", `${base}/history`)))}
            >
              <History size={13} />
              {tr("历史")}
            </button>
          )}
          <button
            type="button"
            className="btn ghost sm"
            title={tr("开始新的 Harness 会话（聊天记录保留）")}
            onClick={() => void run(() => api("POST", `${base}/session`, { sessionId: null }))}
          >
            <Plus size={13} />
            {tr("新会话")}
          </button>
        </span>
      </h4>
      {view ? (
        <dl className="kv">
          <dt>{tr("会话")}</dt>
          <dd>
            <code style={{ fontSize: 11 }}>{view.sessionId}</code>
            {view.title && <div className="muted">{view.title}</div>}
          </dd>
          {view.usage && (
            <>
              <dt>{tr("上下文")}</dt>
              <dd>
                {view.usage.used.toLocaleString(intlLocale(locale))} /{" "}
                {view.usage.size.toLocaleString(intlLocale(locale))}
                {view.usage.cost &&
                  ` · ${view.usage.cost.amount.toLocaleString(intlLocale(locale), { minimumFractionDigits: 4, maximumFractionDigits: 4 })} ${view.usage.cost.currency}`}
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {tr("发第一条消息时启动。")}
        </p>
      )}
      {list && (
        <div className="session-list">
          {list.length === 0 && <p className="muted">{tr("没有可恢复的会话。")}</p>}
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
              {s.updatedAt && (
                <span className="pop-hint muted">{new Date(s.updatedAt).toLocaleDateString(intlLocale(locale))}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {error && <div className="error-text">{translateError(error)}</div>}
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
  compact: boolean;
  onCompactChange: (compact: boolean) => void;
  harnessName: (id: string) => string;
  onRoomChange: () => Promise<void>;
  onDeleted: () => void;
}) {
  const { t: tr } = useI18n();
  const { room } = props;
  const displayHelpId = useId();
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
        <div className="d-tabs" role="tablist" aria-label={tr("会话信息")}>
          {(
            [
              ["info", tr("详情")],
              ["library", tr("资料库")],
              ["members", tr("成员")],
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
          {props.members.length === 0 && <p className="muted">{tr("没有 Agent 成员。")}</p>}
          {props.members.map((a) => {
            const n = replyCount.get(a.id) ?? 0;
            const doing = agentActivity(a.id, props.messages);
            return (
              <div key={a.id} className="member-row">
                <a className="member-link" href={`#/a/${a.id}`} title={tr("编辑这个 Agent")}>
                  <AgentAvatar agent={a} size={28} expression={doing} animate />
                  <span className="member-body">
                    <span className="member-name">{a.name}</span>
                    <span className="member-sub">
                      {a.harness ? props.harnessName(a.harness) : tr("未绑定 Harness")}
                      {room.mainAgentId === a.id && tr(" · 主 Agent")}
                      {n > 0 && tr(" · {count} 条回复", { count: n })}
                    </span>
                  </span>
                </a>
                {props.members.length > 1 && (
                  <button
                    type="button"
                    className="btn ghost icon xs member-remove"
                    aria-label={tr("移出 {name}", { name: a.name })}
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
              <span className="member-name">{tr("添加成员")}</span>
            </button>
            {adding && (
              <div className="add-pop">
                <PickList
                  searchPlaceholder={tr("搜索 Agent")}
                  emptyText={tr("没有可添加的 Agent")}
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
          {error && <div className="error-text">{translateError(error)}</div>}
        </section>
      )}
      {tab === "library" && (
        <section className="d-section">
          <h4>{tr("项目")}</h4>
          <a className="project-link" href={props.project ? `#/p/${props.project.id}` : undefined}>
            <span>{props.project?.name ?? "—"}</span>
            <span className="muted mono">{room.cwd}</span>
          </a>
          <p className="muted d-note">{tr("会话里的 Agent 都在这个文件夹里读写文件。")}</p>
        </section>
      )}
      {tab === "info" && (
        <>
          <section className="d-section">
            <label className="chat-display-setting">
              <span>{tr("精简视图")}</span>
              <input
                type="checkbox"
                role="switch"
                className="tg"
                checked={props.compact}
                aria-checked={props.compact}
                aria-describedby={displayHelpId}
                onChange={(event) => props.onCompactChange(event.target.checked)}
              />
            </label>
            <p className="muted d-note" id={displayHelpId}>
              {tr("折叠思考、工具和计划，保留回复正文。应用于本机所有会话。")}
            </p>
          </section>
          {props.members.length > 1 && (
            <section className="d-section">
              <label className="field">
                <span className="label">{tr("主 Agent")}</span>
                <select
                  className="select"
                  aria-label={tr("主 Agent")}
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
                if (!confirm(tr("删除会话「{name}」及其全部消息？此操作不可撤销。", { name: room.name }))) return;
                await api("DELETE", `/api/rooms/${room.id}`).then(props.onDeleted, (e) =>
                  setError((e as Error).message),
                );
              }}
            >
              <Trash2 size={14} />
              {tr("删除会话")}
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
  onJumpToQuote: (messageId: string, partIndex?: number) => void;
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
  const { t: tr } = useI18n();
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
    props.members.length > 1 &&
    [tr("所有人").toLowerCase(), "所有人", "all", "everyone"].some((n) => n.startsWith(q) || n.includes(q));
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
    // Read the live caret: React's select event can lag the last arrow key, and a stale token would splice the wrong text.
    const liveCaret = ref.current?.selectionStart ?? caret;
    const token = prefix === "$" ? (skillTokenAt(props.value, liveCaret) ?? dollar) : null;
    const next =
      prefix === "$" && token
        ? insertSkill(props.value, token, name)
        : { value: `${prefix}${name} ${props.value.slice(caret)}`, caret: name.length + 2 };
    props.onChange(next.value);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      const el = ref.current;
      // The user may have typed or replaced the draft before this frame; never move their caret then.
      if (!el || el.value !== next.value) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };
  const picker = commands.length
    ? { kind: "cmd" as const, items: commands, prefix: "/" as const, title: tr("命令") }
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
              <img src={`data:${img.mimeType};base64,${img.data}`} alt={tr("附件 {count}", { count: i + 1 })} />
              <button
                type="button"
                disabled={props.sending}
                aria-label={tr("移除图片")}
                onClick={() => props.onImages(props.images.filter((_, j) => j !== i))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {options.length > 0 && (
        <div className="popover mention-pop" role="listbox" aria-label={tr("选择要 @ 的 Agent")}>
          <div className="pop-title">{tr("提及 Agent")}</div>
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
              <span>{a === EVERYONE ? tr("所有人") : a.name}</span>
            </button>
          ))}
        </div>
      )}
      {props.quote && (
        <div className="composer-quote" data-testid="composer-quote">
          <QuoteExcerpt quote={props.quote} onJump={props.onJumpToQuote} />
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={tr("取消引用")}
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
        aria-label={tr("消息输入框")}
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
                aria-label={tr("添加图片")}
                title={props.imageNote || tr("添加图片")}
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
            const label = stop ? (props.stopTask?.status === "queued" ? tr("取消排队") : tr("停止")) : tr("发送");
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
                    ? `${label} · ${props.stopTask?.agentName} · ${props.stopTask?.text || tr("正在准备回复")}`
                    : props.queued
                      ? tr("发送 · {count} 条排队中", { count: props.queued })
                      : tr("发送")
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
  const { t: tr } = useI18n();
  const lower = props.text.toLowerCase();
  const named = props.members.filter((a) => lower.includes(`@${a.name.toLowerCase()}`));
  const everyone = EVERYONE_RE.test(props.text);
  return (
    <span className="recipients" aria-live="polite">
      {everyone ? (
        <span className="rcpt">
          <Users size={12} />
          {tr("所有人")}
        </span>
      ) : (
        named.map((a) => (
          <span key={a.id} className="rcpt" title={tr("发给 {name}", { name: a.name })}>
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
