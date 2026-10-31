import {
  Bell,
  Blocks,
  Bot,
  ChevronLeft,
  ChevronRight,
  Command,
  Folder,
  FolderOpen,
  Gauge,
  Inbox,
  Info,
  MessagesSquare,
  PlugZap,
  Plus,
  Search,
  Settings2,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { createPortal, flushSync } from "react-dom";
import type { DesktopCheckpointRequest } from "../../shared/desktopUpdate";
import { previewText } from "../../shared/roomPreview";
import { AboutUpdates } from "./AboutUpdates";
import { AgentEditor } from "./AgentEditor";
import { AttentionCenter, useAttention } from "./AttentionCenter";
import { AvatarShowcase } from "./AvatarShowcase";
import { type Agent, api, connectWs, type McpServer, type Meta, type Project, type Room, type WsEvent } from "./api";
import { BrandMark } from "./BrandMark";
import { type ChatNavigationTarget, ChatView } from "./ChatView";
import { CommandPalette } from "./CommandPalette";
import { chatWorkspace } from "./chatWorkspace";
import { agentSubtitle, defaultsSummary } from "./config";
import { setLocale, translateError, useI18n } from "./i18n";
import { LibraryPage } from "./Library";
import { usePresence } from "./motion";
import { NewRoom } from "./NewRoom";
import { NotificationsPage, useNotifications } from "./NotifyCenter";
import { updateBridge } from "./notifications";
import { Onboarding } from "./Onboarding";
import { applyAppearance, EMPTY_PROFILE, type Profile, ProfilePage } from "./Profile";
import { NewProject, ProjectSettings } from "./Projects";
import { ProvidersPage } from "./Providers";
import { roomListReducer } from "./roomListState";
import { SetupPage } from "./Setup";
import { AgentAvatar, RoomIcon, roomSubtitle, useHashRoute } from "./ui";

export function App() {
  const { t } = useI18n();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [{ rooms, loading: roomsLoading }, dispatchRooms] = useReducer(roomListReducer, { rooms: [], loading: null });
  const reloadId = useRef(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("tuantuan:collapsed") ?? "[]");
    } catch {
      return [];
    }
  });
  useEffect(() => localStorage.setItem("tuantuan:collapsed", JSON.stringify(collapsed)), [collapsed]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteScope, setPaletteScope] = useState<"all" | "current">("all");
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [chatTarget, setChatTarget] = useState<(ChatNavigationTarget & { roomId: string }) | null>(null);
  const navigationSequence = useRef(0);
  const consumeNavigation = useCallback((nonce: number) => {
    setChatTarget((target) => (target?.nonce === nonce ? null : target));
  }, []);
  const openSearch = useCallback((scope: "all" | "current") => {
    setPaletteScope(scope);
    setPaletteOpen(true);
  }, []);
  const palette = usePresence(paletteOpen, 140);
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const profileRevision = useRef(0);
  const applyProfile = useCallback((p: Profile) => {
    ++profileRevision.current;
    setProfile(p);
    applyAppearance(p);
    setLocale(p.language);
  }, []);
  const reloadProfile = useCallback(async () => {
    const revision = ++profileRevision.current;
    try {
      const p = await api<Profile>("GET", "/api/profile");
      if (revision === profileRevision.current) applyProfile(p);
    } catch {
      // Keep the last confirmed profile while the server is unavailable.
    } finally {
      setProfileLoaded(true);
    }
  }, [applyProfile]);
  // Display name: 个人资料 (server-side); the old per-browser name is the fallback until one is set.
  const userName = profile.name.trim() || localStorage.getItem("agent-hub:user") || t("我");
  useEffect(() => {
    void reloadProfile();
  }, [reloadProfile]);
  const [route, go] = useHashRoute();
  const workspaceError = useSyncExternalStore(chatWorkspace.subscribe, chatWorkspace.error);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [preparingCheckpoint, setPreparingCheckpoint] = useState<DesktopCheckpointRequest | null>(null);
  const checkpointRequest = useRef<DesktopCheckpointRequest | null>(null);
  const preparingUpdate = installingUpdate || !!preparingCheckpoint;
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateVersion, setUpdateVersion] = useState<string>();
  const desktopUpdates = updateBridge();
  const [restoringUpdate, setRestoringUpdate] = useState(!!desktopUpdates);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  useEffect(() => {
    if (!desktopUpdates) return;
    let alive = true;
    let receivedEvent = false;
    const show = (status: { phase: string; availableVersion?: string }) => {
      setInstallingUpdate(status.phase === "installing");
      setUpdateAvailable(status.phase === "available" || status.phase === "ready");
      setUpdateVersion(status.availableVersion);
    };
    const off = desktopUpdates.onUpdateState((status) => {
      receivedEvent = true;
      if (alive) show(status);
    });
    void desktopUpdates.updateStatus().then(
      (status) => {
        if (alive && !receivedEvent) show(status);
      },
      () => {},
    );
    return () => {
      alive = false;
      off();
    };
  }, [desktopUpdates]);
  useEffect(
    () =>
      desktopUpdates?.onCheckpointState?.((state) => {
        if (state.phase === "preparing") {
          checkpointRequest.current = state;
          flushSync(() => setPreparingCheckpoint(state));
        } else if (checkpointRequest.current?.id === state.id && state.phase === "error") {
          checkpointRequest.current = null;
          setPreparingCheckpoint(null);
          setCheckpointError(state.error ?? t("无法保存当前工作"));
        }
      }),
    [desktopUpdates, t],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: restoreAttempt explicitly retries a failed import or acknowledgement
  useEffect(() => {
    if (!desktopUpdates) return;
    let alive = true;
    setRestoreError(null);
    void chatWorkspace
      .restoreCheckpoint(desktopUpdates)
      .then(
        async (saved) => {
          if (!alive) return;
          if (saved) {
            if (location.hash !== saved.route)
              await new Promise<void>((resolve) => {
                window.addEventListener("hashchange", () => resolve(), { once: true });
                location.hash = saved.route;
              });
            if (!alive) return;
            await desktopUpdates.clearUpdateCheckpoint(saved.id);
          }
          if (alive) setRestoringUpdate(false);
        },
        (error) => {
          if (alive) setRestoreError((error as Error).message);
        },
      )
      .catch((error) => {
        if (alive) setRestoreError((error as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [desktopUpdates, restoreAttempt]);
  useEffect(
    () =>
      desktopUpdates?.onPrepareUpdate(async (request) => {
        const current = request ?? { id: crypto.randomUUID(), reason: "update" as const };
        checkpointRequest.current = current;
        // Commit the interaction lock before capturing state, even if IPC events share a React batch.
        flushSync(() => setPreparingCheckpoint(current));
        setCheckpointError(null);
        try {
          // Do not replace the only host copy while startup import/acknowledgement is incomplete.
          if (restoringUpdate) throw new Error(t("正在恢复聊天草稿…"));
          await chatWorkspace.prepareUpdate(location.hash || "#/c", desktopUpdates, request?.id);
        } catch (error) {
          if (checkpointRequest.current?.id === current.id) setCheckpointError((error as Error).message);
          throw current.reason === "update" ? new Error(t("保存工作失败，未重启更新。请重试。")) : error;
        } finally {
          // A timed-out callback must not unlock a newer request. Quit stays locked until main exits.
          if (checkpointRequest.current?.id === current.id && current.reason === "update") {
            checkpointRequest.current = null;
            setPreparingCheckpoint(null);
          }
        }
      }),
    [desktopUpdates, restoringUpdate, t],
  );
  const listeners = useRef(new Set<(e: WsEvent) => void>());
  const ws = useRef<ReturnType<typeof connectWs> | null>(null);

  const reload = useCallback(async () => {
    const id = ++reloadId.current;
    dispatchRooms({ type: "load", id });
    try {
      const [m, a, r, s, p] = await Promise.all([
        api<Meta>("GET", "/api/meta"),
        api<Agent[]>("GET", "/api/agents"),
        api<Room[]>("GET", "/api/rooms"),
        api<McpServer[]>("GET", "/api/mcp-servers"),
        api<Project[]>("GET", "/api/projects"),
      ]);
      if (id !== reloadId.current) return;
      setProjects(p);
      setMeta(m);
      setAgents(a);
      dispatchRooms({ type: "snapshot", id, rooms: r });
      setMcpServers(s);
      setLoadError(null);
    } catch (e) {
      if (id !== reloadId.current) return;
      dispatchRooms({ type: "load.failed", id });
      setLoadError((e as Error).message);
    } finally {
      if (id === reloadId.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    ws.current = connectWs(
      (e) => {
        if (e.type === "activity" || e.type === "room.preview") dispatchRooms({ type: "event", event: e });
        if (e.type === "profile.updated") applyProfile(e.profile);
        for (const l of listeners.current) l(e);
      },
      (online) => {
        setConnected(online);
        // Catch events missed before the first socket opened or while it was disconnected.
        if (online) {
          void reload();
          void reloadProfile();
        }
      },
    );
    return () => ws.current?.close();
  }, [reload, reloadProfile, applyProfile]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (preparingUpdate) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
      if (e.key.toLowerCase() === "k" && paletteOpen) {
        e.preventDefault();
        setPaletteOpen(false);
        return;
      }
      if (document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"]')) return;
      if (e.target instanceof Element && e.target.closest(".xterm")) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        openSearch("all");
      } else if (e.key.toLowerCase() === "f" && route[0] === "c" && route[1] && route[1] !== "new") {
        e.preventDefault();
        openSearch("current");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preparingUpdate, paletteOpen, openSearch, route]);

  const section =
    route[0] === "a"
      ? "agents"
      : route[0] === "setup"
        ? "setup"
        : route[0] === "harness"
          ? "harness"
          : route[0] === "providers"
            ? "providers"
            : route[0] === "library"
              ? "library"
              : route[0] === "profile"
                ? "profile"
                : route[0] === "notify"
                  ? "notify"
                  : route[0] === "about"
                    ? "about"
                    : "rooms";
  // 新手引导 opens by itself on first launch only; once finished or skipped it is gone for good.
  const onboarded = meta?.onboarded;
  const finishing = useRef(false);
  useEffect(() => {
    if (onboarded === false && route[0] !== "setup" && !finishing.current) go("setup");
    // While onboarding finishes, its own go(...) wins: the hash change lands a tick after
    // onboarded flips (POST → WS/meta reload), and redirecting then raced it to Harness 管理.
    if (onboarded && route[0] === "setup" && !finishing.current) go("harness");
    // Finished and landed elsewhere: from now on #/setup redirects as usual.
    if (onboarded && route[0] !== "setup") finishing.current = false;
  }, [onboarded, route, go]);
  const detailId = route[1] ?? null;
  const roomId = route[0] !== "p" && section === "rooms" && detailId && detailId !== "new" ? detailId : null;
  const projectPage = route[0] === "p" ? detailId : null;
  const editingProject = projectPage && projectPage !== "new" ? projects.find((p) => p.id === projectPage) : undefined;

  useEffect(() => {
    ws.current?.subscribe(roomId);
  }, [roomId]);

  const subscribeEvents = useCallback((fn: (e: WsEvent) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);
  const unread = useNotifications({
    subscribe: subscribeEvents,
    agents,
    openRoomId: roomId,
    open: (id) => go(`c/${id}`),
  });
  const attention = useAttention({ subscribeEvents, connected });
  const navigateToChat = (target: Omit<ChatNavigationTarget, "nonce"> & { roomId: string }) => {
    setPaletteOpen(false);
    setAttentionOpen(false);
    // Search/attention can refer to a room created in another window after this sidebar loaded.
    if (!rooms.some((item) => item.id === target.roomId)) void reload();
    setChatTarget({ ...target, nonce: ++navigationSequence.current });
    go(`c/${target.roomId}`);
  };

  const room = roomId ? rooms.find((r) => r.id === roomId) : undefined;
  const fullPage =
    section === "setup" ||
    section === "harness" ||
    section === "providers" ||
    section === "library" ||
    section === "notify" ||
    section === "about" ||
    section === "profile";
  const mobileView = fullPage || detailId ? "main" : "list";
  const harnessName = (id: string) => t(meta?.harnesses.find((h) => h.id === id)?.name ?? id);

  if (restoringUpdate)
    return (
      <div className="update-preparing" role="status">
        <p>{t("正在恢复上次的工作…")}</p>
        {restoreError && (
          <>
            <p className="error-text" role="alert">
              {t("无法恢复上次的工作：{error}", { error: translateError(restoreError) })}
            </p>
            <button type="button" className="btn" onClick={() => setRestoreAttempt((value) => value + 1)}>
              {t("重试")}
            </button>
          </>
        )}
      </div>
    );
  if (route[0] === "dev" && route[1] === "avatars") return <AvatarShowcase />;
  return (
    <div className={`shell ${fullPage ? "no-list" : ""}`} data-mobile={mobileView} inert={preparingUpdate}>
      <aside className="side" aria-label={t("侧栏")}>
        <div className="side-top">
          <span className="side-brand" title={t("团团 Tuantuan")}>
            <BrandMark size={26} />
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="side-icon side-attention"
            aria-label={t("需要我处理")}
            aria-describedby="attention-pending-description"
            title={t("需要我处理")}
            onClick={() => setAttentionOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={attentionOpen}
          >
            <Inbox size={18} aria-hidden="true" />
            <span id="attention-pending-description" className="sr-only">
              {attention.stale
                ? t("待确认")
                : attention.pendingCount === null
                  ? t("加载中…")
                  : t("{count} 项待处理", { count: attention.pendingCount })}
            </span>
            {((attention.pendingCount ?? 0) > 0 || attention.stale || attention.pendingCount === null) && (
              <span
                aria-hidden="true"
                className="side-attention-count"
                data-active={(attention.pendingCount ?? 0) > 0 || undefined}
              >
                {attention.stale && !attention.loading
                  ? "!"
                  : attention.pendingCount === null
                    ? "…"
                    : attention.pendingCount > 99
                      ? "99+"
                      : attention.pendingCount}
              </span>
            )}
          </button>
          <button
            type="button"
            className="side-icon"
            aria-label={t("搜索")}
            title={t("搜索（⌘K / Ctrl+K）")}
            onClick={() => openSearch("all")}
          >
            <Search size={17} />
          </button>
          <button
            type="button"
            className="side-icon"
            aria-label={t("新建会话")}
            title={agents.length ? t("新建会话") : t("先创建一个 Agent")}
            onClick={() => go(agents.length ? "c/new" : "a/new")}
          >
            <Plus size={18} />
          </button>
        </div>
        <div className="side-scroll">
          {section === "rooms" ? (
            <>
              {loaded && agents.length === 0 && (
                <div className="list-empty first-run">
                  <b>{t("还没有 Agent")}</b>
                  <button type="button" className="btn primary sm" onClick={() => go("a/new")}>
                    {t("创建 Agent")}
                  </button>
                </div>
              )}
              {[...rooms]
                .filter((r) => r.projectId === "drafts" || !projects.some((p) => p.id === r.projectId))
                .sort((x, y) => (y.last?.at ?? y.createdAt) - (x.last?.at ?? x.createdAt))
                .map((r) => (
                  <RoomRow
                    key={r.id}
                    r={r}
                    agents={agents}
                    current={roomId === r.id}
                    unread={unread[r.id] ?? 0}
                    onOpen={() => go(`c/${r.id}`)}
                  />
                ))}
              <div className="side-section-head">
                <span>{t("项目")}</span>
                <button
                  type="button"
                  className="side-section-add"
                  aria-label={t("新建项目")}
                  title={t("新建项目")}
                  onClick={() => go("p/new")}
                >
                  <Plus size={14} />
                </button>
              </div>
              {projects
                .filter((p) => p.id !== "drafts")
                .map((p) => {
                  const list = rooms
                    .filter((r) => r.projectId === p.id)
                    .sort((x, y) => (y.last?.at ?? y.createdAt) - (x.last?.at ?? x.createdAt));
                  const active = list.some((r) => r.id === roomId) || projectPage === p.id;
                  const open = active || !collapsed.includes(p.id);
                  return (
                    <div key={p.id} className="side-group" data-open={open || undefined}>
                      <div className="side-group-head" aria-current={projectPage === p.id ? "page" : undefined}>
                        <button
                          type="button"
                          className="side-group-toggle"
                          aria-expanded={open}
                          title={p.cwd}
                          onClick={() => setCollapsed((c) => (open ? [...c, p.id] : c.filter((x) => x !== p.id)))}
                        >
                          <Folder size={15} className="side-group-icon" />
                          <span className="side-group-name">{p.name}</span>
                          <ChevronRight size={13} className="side-group-chev" />
                        </button>
                        <span className="side-group-count">{list.length || ""}</span>
                        <span className="side-group-actions">
                          <button
                            type="button"
                            className="btn ghost icon xs"
                            aria-label={t("{name} 设置", { name: p.name })}
                            onClick={() => go(`p/${p.id}`)}
                          >
                            <Settings2 size={13} />
                          </button>
                          <button
                            type="button"
                            className="btn ghost icon xs"
                            aria-label={t("在 {name} 新建会话", { name: p.name })}
                            disabled={agents.length === 0}
                            onClick={() => go(`c/new/${p.id}`)}
                          >
                            <Plus size={13} />
                          </button>
                        </span>
                      </div>
                      <div className="collapse">
                        <div className="side-group-rooms">
                          {list.length === 0 && <div className="side-group-empty">{t("还没有会话")}</div>}
                          {list.map((r) => (
                            <RoomRow
                              key={r.id}
                              r={r}
                              agents={agents}
                              current={roomId === r.id}
                              unread={unread[r.id] ?? 0}
                              onOpen={() => go(`c/${r.id}`)}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
            </>
          ) : (
            <>
              <button type="button" className="side-back" onClick={() => go("c")}>
                <ChevronLeft size={15} />
                {t("会话")}
              </button>
              <div className="side-section-title">{t("设置")}</div>
              <SideNav
                icon={<UserRound size={17} />}
                label={t("个人资料")}
                current={section === "profile"}
                onClick={() => go("profile")}
              />
              <SideNav icon={<Bot size={17} />} label="Agents" current={section === "agents"} onClick={() => go("a")} />
              <div
                className="side-collapse"
                data-open={section === "agents" ? "" : undefined}
                inert={section !== "agents"}
              >
                <div className="side-collapse-inner">
                  <div className="side-sub">
                    {agents.map((a) => {
                      const full = a.harness
                        ? [harnessName(a.harness), ...defaultsSummary(a.configDefaults)].join(" · ")
                        : t("未绑定 Harness");
                      return (
                        <button
                          type="button"
                          key={a.id}
                          className="list-item side-agent"
                          aria-current={detailId === a.id ? "page" : undefined}
                          title={`${a.name}\n${full}`}
                          onClick={() => go(`a/${a.id}`)}
                        >
                          <AgentAvatar agent={a} size={24} />
                          <span className="li-body">
                            <span className="li-title">{a.name}</span>
                            <span className="li-sub">
                              {a.harness ? (
                                agentSubtitle(harnessName(a.harness), a.configDefaults)
                              ) : (
                                <span className="warn-text">{t("未绑定 Harness")}</span>
                              )}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className="side-agent side-agent-add"
                      aria-current={detailId === "new" ? "page" : undefined}
                      onClick={() => go("a/new")}
                    >
                      <span className="side-agent-plus">
                        <Plus size={14} />
                      </span>
                      {t("新建 Agent")}
                    </button>
                  </div>
                </div>
              </div>
              <SideNav
                icon={<PlugZap size={17} />}
                label="Harness"
                current={section === "harness" || section === "setup"}
                onClick={() => go("harness")}
              />
              <SideNav
                icon={<Blocks size={17} />}
                label={t("Skills 与插件")}
                current={section === "library"}
                onClick={() => go("library")}
              />
              <SideNav
                icon={<Gauge size={17} />}
                label={t("服务商与用量")}
                current={section === "providers"}
                onClick={() => go("providers")}
              />
              <SideNav
                icon={<Bell size={17} />}
                label={t("通知")}
                current={section === "notify"}
                onClick={() => go("notify")}
              />
              <SideNav
                icon={<Info size={17} />}
                label={t("关于与更新")}
                badge={updateAvailable ? t("有可用更新") : undefined}
                current={section === "about"}
                onClick={() => go("about")}
              />
            </>
          )}
        </div>
        <div className="side-foot">
          <button
            type="button"
            className="side-me"
            title={t("{name} · 个人资料", { name: userName })}
            aria-label={t("个人资料")}
            onClick={() => go("profile")}
          >
            <UserRound size={17} />
          </button>
          <button
            type="button"
            className="side-settings"
            aria-current={section !== "rooms" ? "page" : undefined}
            onClick={() => go(section === "rooms" ? "a" : "c")}
          >
            <Settings2 size={15} />
            {t("设置")}
          </button>
          <span
            className={`dot ${connected ? "ok" : "bad"}`}
            title={connected ? t("实时连接正常") : t("实时连接已断开，正在重连…")}
          >
            <span className="sr-only">{connected ? t("已连接") : t("重连中")}</span>
          </span>
        </div>
      </aside>

      <main className="main">
        {(workspaceError || checkpointError) && (
          <div className="form-error workspace-save-error" role="alert">
            <span>
              {t("聊天工作尚未保存：{error}", {
                error: translateError(workspaceError ?? checkpointError ?? ""),
              })}
            </span>
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                void chatWorkspace.flush().then(
                  () => setCheckpointError(null),
                  (error) => setCheckpointError((error as Error).message),
                )
              }
            >
              {t("重试")}
            </button>
          </div>
        )}
        <div className="pane" key={`${section}/${projectPage ?? ""}/${detailId ?? ""}`}>
          {loadError && (
            <div className="form-error" role="alert" style={{ margin: 12 }}>
              {t("加载失败：{error}", { error: translateError(loadError) })}
              <button type="button" className="btn sm" onClick={() => void reload()}>
                {t("重试")}
              </button>
            </div>
          )}
          {projectPage === "new" && (
            <NewProject
              workspacesRoot={meta?.workspacesRoot ?? ""}
              onBack={() => go("c")}
              onCreated={async (p) => {
                await reload();
                go(`p/${p.id}`);
              }}
            />
          )}
          {editingProject && (
            <ProjectSettings
              key={editingProject.id}
              project={editingProject}
              conversations={rooms.filter((r) => r.projectId === editingProject.id).length}
              onChange={reload}
              onBack={() => go("c")}
              onDeleted={async () => {
                await reload();
                go("c");
              }}
            />
          )}
          {projectPage && projectPage !== "new" && loaded && !editingProject && (
            <NotFound what={t("项目")} onBack={() => go("c")} />
          )}
          {section === "rooms" && !detailId && loaded && <Welcome agents={agents} go={go} />}
          {route[0] === "c" && detailId === "new" && (
            <NewRoom
              key={route[2] ?? "drafts"}
              agents={agents}
              projects={projects}
              projectId={route[2] && projects.some((p) => p.id === route[2]) ? route[2] : "drafts"}
              onBack={() => go("c")}
              onCreated={async (r) => {
                await reload();
                go(`c/${r.id}`);
              }}
            />
          )}
          {section === "rooms" &&
            roomId &&
            loaded &&
            !room &&
            !loadError &&
            (roomsLoading ? (
              <div className="empty" role="status">
                {t("正在加载会话…")}
              </div>
            ) : (
              <NotFound what={t("会话")} onBack={() => go("c")} />
            ))}
          {room && (
            <ChatView
              key={room.id}
              room={room}
              project={projects.find((p) => p.id === room.projectId) ?? null}
              agents={agents}
              userName={userName}
              harnessName={harnessName}
              subscribeEvents={subscribeEvents}
              onSearch={() => openSearch("current")}
              onNavigateMessage={(id) => navigateToChat({ roomId: room.id, kind: "message", id })}
              navigationTarget={chatTarget?.roomId === room.id ? chatTarget : null}
              onNavigationHandled={consumeNavigation}
              onBack={() => go("c")}
              onRoomChange={reload}
              onDeleted={async () => {
                await reload();
                go("c");
              }}
            />
          )}
          {section === "setup" && meta && !meta.onboarded && (
            <Onboarding
              agents={agents}
              onDone={async (roomId) => {
                finishing.current = true;
                await api("POST", "/api/onboarding");
                // leave #/setup first, or the "already onboarded" redirect sends us to Harness 管理
                go(roomId ? `c/${roomId}` : "c");
                await reload();
              }}
            />
          )}
          {section === "harness" && meta && <SetupPage meta={meta} agents={agents} onAgentsChange={reload} go={go} />}
          {section === "library" && meta && <LibraryPage meta={meta} />}
          {section === "notify" && <NotificationsPage />}
          {section === "about" && <AboutUpdates />}
          {section === "profile" && profileLoaded && <ProfilePage profile={profile} onChange={applyProfile} />}
          {section === "providers" && meta && <ProvidersPage meta={meta} agents={agents} onAgentsChange={reload} />}
          {section === "agents" && !detailId && loaded && (
            <div className="empty">
              <div className="empty-icon">
                <Bot size={24} />
              </div>
              <h2>{agents.length ? t("选择一个 Agent 进行编辑") : t("创建你的第一个 Agent")}</h2>
              <button type="button" className="btn primary" onClick={() => go("a/new")}>
                <Plus size={16} />
                {t("新建 Agent")}
              </button>
            </div>
          )}
          {section === "agents" &&
            detailId &&
            meta &&
            (detailId === "new" || agents.some((a) => a.id === detailId)) && (
              <AgentEditor
                key={detailId}
                meta={meta}
                agent={detailId === "new" ? null : (agents.find((a) => a.id === detailId) ?? null)}
                mcpServers={mcpServers}
                onBack={() => go("a")}
                onMcpChange={reload}
                onSaved={async (a) => {
                  await reload();
                  go(`a/${a.id}`);
                }}
                onDeleted={async () => {
                  await reload();
                  go("a");
                }}
                onStartChat={(a) => {
                  const solo = rooms.find(
                    (r) => r.projectId === "drafts" && r.agentIds.length === 1 && r.agentIds[0] === a.id,
                  );
                  if (solo) go(`c/${solo.id}`);
                  else
                    void api<Room>("POST", "/api/rooms", { name: a.name, agentIds: [a.id] }).then(async (r) => {
                      await reload();
                      go(`c/${r.id}`);
                    });
                }}
              />
            )}
          {section === "agents" &&
            detailId &&
            detailId !== "new" &&
            loaded &&
            !agents.some((a) => a.id === detailId) && <NotFound what="Agent" onBack={() => go("a")} />}
        </div>
      </main>

      {palette.mounted && (
        <CommandPalette
          key={paletteScope}
          state={palette.state}
          agents={agents}
          rooms={rooms}
          currentRoom={room ? { id: room.id, name: room.name } : undefined}
          initialScope={paletteScope}
          onSelectMessage={(result) => navigateToChat({ roomId: result.roomId, kind: "message", id: result.messageId })}
          onClose={() => setPaletteOpen(false)}
          onGo={(path) => {
            setPaletteOpen(false);
            go(path);
          }}
        />
      )}
      <AttentionCenter
        open={attentionOpen}
        onClose={() => setAttentionOpen(false)}
        controller={attention}
        onNavigate={(target) =>
          navigateToChat({
            roomId: target.roomId,
            kind: "askId" in target ? target.kind : "message",
            id: "askId" in target ? target.askId : target.messageId,
          })
        }
      />
      {preparingUpdate &&
        createPortal(
          <div className="update-preparing" role="status" aria-live="polite">
            <p>{t(preparingCheckpoint?.reason === "quit" ? "正在保存工作并退出…" : "正在保存工作并重启…")}</p>
            {updateVersion && preparingCheckpoint?.reason !== "quit" && (
              <p className="muted">{t("新版本 {version} 可用", { version: updateVersion })}</p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

function SideNav(props: {
  icon: React.ReactNode;
  label: string;
  current: boolean;
  onClick: () => void;
  badge?: string;
}) {
  return (
    <button
      type="button"
      className="side-nav"
      aria-current={props.current ? "page" : undefined}
      aria-description={props.badge}
      onClick={props.onClick}
    >
      {props.icon}
      {props.label}
      {props.badge && <span className="side-update-dot" title={props.badge} aria-hidden />}
    </button>
  );
}

/** Conversation row: big avatar, title, last message. */
function RoomRow(props: { r: Room; agents: Agent[]; current: boolean; unread: number; onOpen: () => void }) {
  const { t, locale } = useI18n();
  const { r } = props;
  const preview = r.last
    ? `${r.last.sender && r.agentIds.length > 1 ? `${r.last.sender}：` : ""}${previewText(r.last, locale)}`
    : roomSubtitle(r, props.agents);
  return (
    <button
      type="button"
      className="side-room"
      aria-current={props.current ? "page" : undefined}
      data-busy={r.busy ? "" : undefined}
      onClick={props.onOpen}
    >
      <span className="side-room-icon">
        <RoomIcon room={r} agents={props.agents} size={40} busy={!!r.busy} />
        {r.busy && <span className="busy-dot" title={t("正在回复")} />}
      </span>
      <span className="li-body">
        <span className="li-title">{r.name}</span>
        <span className="li-sub">{preview}</span>
      </span>
      {props.unread > 0 && !props.current && (
        <span className="unread" title={t("{count} 条未读", { count: props.unread })}>
          {props.unread > 99 ? "99+" : props.unread}
        </span>
      )}
    </button>
  );
}

function ListPane(props: { title: string; action: React.ReactNode; onSearch: () => void; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <aside className="list-pane">
      <div className="pane-head">
        <h1>{props.title}</h1>
        {props.action}
      </div>
      <div className="pane-search">
        <Search size={15} />
        <button type="button" className="input search-trigger" onClick={props.onSearch}>
          {t("搜索会话与 Agent")}
          <kbd className="combo">
            {IS_MAC ? <Command size={10} /> : <span>Ctrl</span>}
            <span>K</span>
          </kbd>
        </button>
      </div>
      <div className="pane-scroll">{props.children}</div>
    </aside>
  );
}

function Welcome({ agents, go }: { agents: Agent[]; go: (p: string) => void }) {
  const { t } = useI18n();
  return (
    <>
      <header className="main-head chat-head">
        <div className="title-pill static">
          <h2>{agents.length === 0 ? t("开始") : t("团团")}</h2>
        </div>
      </header>
      <div className="welcome-body">
        <div className="empty" style={{ maxWidth: 560 }}>
          <div className="empty-icon">
            <Sparkles size={24} />
          </div>
          <h2>{agents.length === 0 ? t("欢迎使用团团") : t("选择一个会话")}</h2>
          <div className="welcome-actions">
            <button type="button" className="btn primary" onClick={() => go(agents.length ? "c/new" : "a/new")}>
              <Plus size={16} />
              {agents.length ? t("新建会话") : t("创建 Agent")}
            </button>
            {!agents.length && (
              <button type="button" className="btn" onClick={() => go("harness")}>
                {t("Harness 管理")}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function NotFound({ what, onBack }: { what: string; onBack: () => void }) {
  const { t } = useI18n();
  return (
    <div className="empty">
      <h2>{t("找不到{what}", { what })}</h2>
      <button type="button" className="btn" onClick={onBack}>
        {t("返回列表")}
      </button>
    </div>
  );
}
