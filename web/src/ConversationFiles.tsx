import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Download,
  File,
  FileCode2,
  FileDiff,
  Folder,
  FolderOpen,
  GitBranch,
  Image as ImageIcon,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Paperclip,
  RefreshCw,
  Search,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IMAGE_MIME_TYPES } from "../../shared/attachments";
import {
  CONVERSATION_FILE_DOWNLOAD_MAX_BYTES,
  type ConversationFile,
  type ConversationFilesPage,
} from "../../shared/conversationFiles";
import { getFilePreviewType } from "../../shared/filePreview";
import type { GitStatusItem, GitStatusResponse, GitStatusSection } from "../../shared/gitStatus";
import type { SessionChangesResponse, SessionFileChange } from "../../shared/sessionChanges";
import type { WorkspaceEntry, WorkspaceSearchResponse, WorkspaceTreeResponse } from "../../shared/workspaceFiles";
import { api } from "./api";
import { formatAttachmentSize } from "./composerAttachments";
import { readConversationFile, saveConversationFile } from "./conversationFileDownload";
import { FileViewerPane, selectionIdentity, type WorkbenchSelection } from "./FileViewerPane";
import { translateError, useI18n } from "./i18n";
import { useVirtualList } from "./useVirtualList";
import "./conversationFiles.css";

export type FileWorkbenchTab = "tree" | "git" | "edits" | "chat";

const DEFAULT_WIDTH = 580;
const WIDE_WIDTH = 900;
const MIN_WIDTH = 360;
const MAX_WIDTH = 1120;
const SPLIT_MIN_WIDTH = 520;
const GIT_SECTION_ORDER: GitStatusSection[] = ["unstaged", "staged", "untracked"];

interface DirNodeState {
  entries: WorkspaceEntry[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
  unavailable?: boolean;
}

interface FlatTreeRow {
  kind: "entry" | "truncated";
  key: string;
  entry?: WorkspaceEntry;
  depth: number;
  expanded?: boolean;
  loading?: boolean;
  parentDir?: string;
}

type FlatGitRow =
  | { kind: "header"; key: string; section: GitStatusSection; count: number }
  | { kind: "item"; key: string; section: GitStatusSection; item: GitStatusItem; code: string };

interface ChatFilesState extends ConversationFilesPage {
  loading: boolean;
  initialized: boolean;
  error: string | null;
  failedPage: "first" | "more" | null;
}

const emptyChatFiles: ChatFilesState = {
  items: [],
  nextCursor: null,
  loading: true,
  initialized: false,
  error: null,
  failedPage: null,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSavedWidth(): number {
  try {
    const raw = Number(localStorage.getItem("tuantuan:file-workbench-width"));
    if (Number.isFinite(raw) && raw >= MIN_WIDTH && raw <= MAX_WIDTH) return Math.round(raw);
  } catch {
    /* Optional preference */
  }
  return DEFAULT_WIDTH;
}

function gitPriorityBadge(item: GitStatusItem | undefined): { code: string; tone: string } | null {
  if (!item) return null;
  if (item.unstaged === "U" || item.staged === "U") return { code: "U", tone: "U" };
  if (item.unstaged) return { code: item.unstaged, tone: item.unstaged };
  if (item.staged) return { code: item.staged, tone: item.staged };
  if (item.untracked) return { code: "+", tone: "?" };
  return null;
}

function addAncestorDirs(target: Set<string>, filePath: string) {
  let slash = filePath.indexOf("/");
  while (slash > 0) {
    target.add(filePath.slice(0, slash));
    slash = filePath.indexOf("/", slash + 1);
  }
}

export function ConversationFiles(props: {
  open: boolean;
  state?: "open" | "closing";
  hasProject: boolean;
  roomId: string;
  roomName: string;
  revision: string;
  /** Clicked a file link in chat: open the workbench at this workspace path. */
  openPath?: { path: string; tick: number } | null;
  onClose: () => void;
  onSelectMessage: (messageId: string) => void;
  returnFocusTo?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const { roomId } = props;
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const rowButtons = useRef(new Map<string, HTMLElement>());
  const restoreFocusKey = useRef<string | null>(null);
  const downloadActions = useRef(new Map<string, AbortController>());

  const [tab, setTab] = useState<FileWorkbenchTab>(() => (props.hasProject ? "tree" : "chat"));
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [normalWidth, setNormalWidth] = useState<number>(readSavedWidth);
  const [wideMode, setWideMode] = useState(false);
  const [docked, setDocked] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia("(min-width: 1024px)").matches,
  );
  const [containerWidth, setContainerWidth] = useState(() =>
    typeof window === "undefined" ? 1168 : Math.max(680, window.innerWidth - 272),
  );
  const [measuredWidth, setMeasuredWidth] = useState(() =>
    typeof window === "undefined" ? DEFAULT_WIDTH : window.innerWidth < 1024 ? window.innerWidth : DEFAULT_WIDTH,
  );

  const [selection, setSelection] = useState<WorkbenchSelection | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [detailFocusTick, setDetailFocusTick] = useState(0);

  // Directory tree state
  const [cwdName, setCwdName] = useState("");
  const [dirMap, setDirMap] = useState<Record<string, DirNodeState>>({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const expandedDirsRef = useRef(expandedDirs);
  expandedDirsRef.current = expandedDirs;

  // Workspace search state (tree tab + non-empty query)
  const [searchResult, setSearchResult] = useState<{
    items: WorkspaceEntry[];
    truncated: boolean;
    loading: boolean;
    error: string | null;
  }>({ items: [], truncated: false, loading: false, error: null });

  // Git workspace state
  const [gitData, setGitData] = useState<GitStatusResponse | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);

  // Agent reported edits state
  const [agentEdits, setAgentEdits] = useState<SessionFileChange[]>([]);
  const [editsLoading, setEditsLoading] = useState(false);
  const [editsError, setEditsError] = useState<string | null>(null);

  // Chat attachments & referenced deliverables state
  const [chatFiles, setChatFiles] = useState<ChatFilesState>(emptyChatFiles);
  const chatGen = useRef(0);
  const chatInFlight = useRef(false);
  const [rowDownloads, setRowDownloads] = useState<Record<string, boolean>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [srNotice, setSrNotice] = useState("");

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setDocked(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const parent = element.parentElement;
    if (parent && parent.clientWidth > 0) setContainerWidth(parent.clientWidth);
    if (element.clientWidth > 0) setMeasuredWidth(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width <= 0) continue;
        if (entry.target === element) setMeasuredWidth(entry.contentRect.width);
        else if (entry.target === parent) setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(element);
    if (parent) observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  // Focus entry & restoration on open/close
  useEffect(() => {
    if (props.open) {
      closeBtnRef.current?.focus({ preventScroll: true });
    }
  }, [props.open]);

  useEffect(() => {
    const activeDownloads = downloadActions.current;
    const returnTarget = props.returnFocusTo;
    return () => {
      for (const controller of activeDownloads.values()) controller.abort();
      activeDownloads.clear();
      if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
    };
  }, [props.returnFocusTo]);

  const splitLayout = measuredWidth >= SPLIT_MIN_WIDTH;

  const fetchDirectory = useCallback(
    async (dir: string, signal?: AbortSignal) => {
      setDirMap((prev) => ({
        ...prev,
        [dir]: {
          entries: prev[dir]?.entries ?? [],
          truncated: prev[dir]?.truncated ?? false,
          loading: true,
          error: null,
          unavailable: prev[dir]?.unavailable,
        },
      }));
      try {
        const params = dir ? `?dir=${encodeURIComponent(dir)}` : "";
        const res = await api<WorkspaceTreeResponse>("GET", `/api/rooms/${encodeURIComponent(roomId)}/tree${params}`);
        if (signal?.aborted) return;
        if (dir === "" && res.cwdName) setCwdName(res.cwdName);
        setDirMap((prev) => ({
          ...prev,
          [dir]: {
            entries: res.entries,
            truncated: res.truncated,
            loading: false,
            error: res.state === "unavailable" ? (res.error ?? "工作区目录当前不可用") : null,
            unavailable: res.state === "unavailable",
          },
        }));
      } catch (err) {
        if (signal?.aborted) return;
        setDirMap((prev) => ({
          ...prev,
          [dir]: {
            entries: prev[dir]?.entries ?? [],
            truncated: prev[dir]?.truncated ?? false,
            loading: false,
            error: errorText(err),
          },
        }));
      }
    },
    [roomId],
  );

  // Load root + any expanded directories on mount, manual refresh, or settled revision change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh and revision silently sync open folders
  useEffect(() => {
    if (!props.hasProject && tab !== "tree") return;
    const controller = new AbortController();
    const dirsToRefresh = ["", ...expandedDirsRef.current];
    for (const dir of dirsToRefresh) {
      void fetchDirectory(dir, controller.signal);
    }
    return () => controller.abort();
  }, [roomId, props.hasProject, tab === "tree", refresh, props.revision, fetchDirectory]);

  const toggleDir = useCallback(
    (dir: string) => {
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        if (next.has(dir)) {
          next.delete(dir);
        } else {
          next.add(dir);
          if (!dirMap[dir]) void fetchDirectory(dir);
        }
        return next;
      });
    },
    [dirMap, fetchDirectory],
  );

  // Debounced workspace filename search when on tree tab with query
  const trimmedQuery = query.trim();
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh re-runs active workspace search
  useEffect(() => {
    if (tab !== "tree" || !trimmedQuery) {
      setSearchResult((prev) =>
        prev.items.length || prev.loading ? { items: [], truncated: false, loading: false, error: null } : prev,
      );
      return;
    }
    let live = true;
    setSearchResult((prev) => ({ ...prev, loading: true, error: null }));
    const timer = window.setTimeout(() => {
      api<WorkspaceSearchResponse>(
        "GET",
        `/api/rooms/${encodeURIComponent(roomId)}/tree/search?q=${encodeURIComponent(trimmedQuery)}`,
      )
        .then((res) => {
          if (!live) return;
          setSearchResult({
            items: res.items,
            truncated: res.truncated,
            loading: false,
            error: res.state === "unavailable" ? (res.error ?? "工作区目录当前不可用") : null,
          });
        })
        .catch((err: unknown) => {
          if (!live) return;
          setSearchResult((prev) => ({ ...prev, loading: false, error: errorText(err) }));
        });
    }, 100);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [roomId, tab, trimmedQuery, refresh]);

  // Load Git status (decorates tree + powers Git tab)
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh and revision silently update Git status
  useEffect(() => {
    if (!props.hasProject && tab !== "git") return;
    let live = true;
    setGitLoading(true);
    setGitError(null);
    api<GitStatusResponse>("GET", `/api/rooms/${encodeURIComponent(roomId)}/git-status`)
      .then((value) => {
        if (!live) return;
        if (value.state === "error") {
          setGitError(value.error || "Git 操作失败");
          setGitData((prev) => prev || value);
          return;
        }
        setGitData(value);
      })
      .catch((err: unknown) => {
        if (live) setGitError(errorText(err));
      })
      .finally(() => {
        if (live) setGitLoading(false);
      });
    return () => {
      live = false;
    };
  }, [roomId, props.hasProject, tab === "git", refresh, props.revision]);

  // Load Agent reported changes (decorates tree + powers Agent Edits tab)
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh and revision silently update Agent edits
  useEffect(() => {
    let live = true;
    setEditsLoading(true);
    setEditsError(null);
    api<SessionChangesResponse>("GET", `/api/rooms/${encodeURIComponent(roomId)}/changes`)
      .then((res) => {
        if (!live) return;
        setAgentEdits(res.items);
      })
      .catch((err: unknown) => {
        if (live) setEditsError(errorText(err));
      })
      .finally(() => {
        if (live) setEditsLoading(false);
      });
    return () => {
      live = false;
    };
  }, [roomId, refresh, props.revision]);

  // Load Chat attachments & referenced deliverables
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh and revision silently refresh first page
  useEffect(() => {
    const token = ++chatGen.current;
    chatInFlight.current = true;
    setChatFiles((prev) => ({ ...prev, loading: true, error: null, failedPage: null }));
    api<ConversationFilesPage>("GET", `/api/rooms/${encodeURIComponent(roomId)}/files?limit=40`)
      .then((page) => {
        if (chatGen.current !== token) return;
        setChatFiles((prev) => {
          // Keep any older pages already loaded so revision updates don't drop user's loaded history!
          if (prev.initialized && prev.items.length > page.items.length) {
            const freshIds = new Set(page.items.map((item) => item.id));
            const merged = [...page.items, ...prev.items.filter((item) => !freshIds.has(item.id))];
            return {
              items: merged,
              nextCursor: prev.nextCursor,
              loading: false,
              initialized: true,
              error: null,
              failedPage: null,
            };
          }
          return {
            ...page,
            loading: false,
            initialized: true,
            error: null,
            failedPage: null,
          };
        });
      })
      .catch((err: unknown) => {
        if (chatGen.current === token) {
          setChatFiles((prev) => ({
            ...prev,
            loading: false,
            initialized: true,
            error: errorText(err),
            failedPage: "first",
          }));
        }
      })
      .finally(() => {
        if (chatGen.current === token) chatInFlight.current = false;
      });
    return () => {
      ++chatGen.current;
    };
  }, [roomId, refresh, props.revision]);

  const loadMoreChatFiles = async () => {
    if (!chatFiles.nextCursor || chatInFlight.current) return;
    const token = chatGen.current;
    chatInFlight.current = true;
    setChatFiles((prev) => ({ ...prev, loading: true, error: null, failedPage: null }));
    const params = new URLSearchParams({ limit: "40", cursor: chatFiles.nextCursor });
    try {
      const page = await api<ConversationFilesPage>("GET", `/api/rooms/${encodeURIComponent(roomId)}/files?${params}`);
      if (chatGen.current !== token) return;
      setChatFiles((prev) => {
        const seen = new Set(prev.items.map((item) => item.id));
        return {
          items: [...prev.items, ...page.items.filter((item) => !seen.has(item.id))],
          nextCursor: page.nextCursor,
          loading: false,
          initialized: true,
          error: null,
          failedPage: null,
        };
      });
    } catch (err) {
      if (chatGen.current === token) {
        setChatFiles((prev) => ({ ...prev, loading: false, error: errorText(err), failedPage: "more" }));
      }
    } finally {
      if (chatGen.current === token) chatInFlight.current = false;
    }
  };

  // Git emits repository-root relative paths; the workbench works in conversation-directory
  // relative paths. Strip the repo scope so rows, badges and selections all share one form —
  // only the Git detail request re-prefixes it (FileViewerPane).
  const { gitScope, gitItems } = useMemo(() => {
    if (!gitData || (gitData.state !== "ready" && gitData.state !== "unborn"))
      return { gitScope: "", gitItems: [] as GitStatusItem[] };
    const scope = gitData.scope ?? "";
    const prefix = scope ? `${scope}/` : "";
    return {
      gitScope: scope,
      gitItems: gitData.items.map((item) =>
        prefix && item.path.startsWith(prefix) ? { ...item, path: item.path.slice(prefix.length) } : item,
      ),
    };
  }, [gitData]);

  // Fast O(N) lookup maps for Git & Agent badges on files and ancestor folders
  const { gitByPath, dirtyFolders } = useMemo(() => {
    const byPath = new Map<string, GitStatusItem>();
    const folders = new Set<string>();
    for (const item of gitItems) {
      byPath.set(item.path, item);
      addAncestorDirs(folders, item.path);
    }
    return { gitByPath: byPath, dirtyFolders: folders };
  }, [gitItems]);

  const { editsByPath, editFolders, overlapFolders } = useMemo(() => {
    const byPath = new Map<string, SessionFileChange>();
    const folders = new Set<string>();
    const overlaps = new Set<string>();
    for (const item of agentEdits) {
      byPath.set(item.path, item);
      addAncestorDirs(folders, item.path);
      if (item.overlap) addAncestorDirs(overlaps, item.path);
    }
    return { editsByPath: byPath, editFolders: folders, overlapFolders: overlaps };
  }, [agentEdits]);

  // Flatten visible directory tree
  const flatTreeRows = useMemo<FlatTreeRow[]>(() => {
    const rows: FlatTreeRow[] = [];
    const visit = (dir: string, depth: number) => {
      const node = dirMap[dir];
      if (!node) return;
      for (const entry of node.entries) {
        const expanded = entry.kind === "dir" && expandedDirs.has(entry.path);
        const childNode = entry.kind === "dir" ? dirMap[entry.path] : undefined;
        rows.push({
          kind: "entry",
          key: `tree:${entry.path}`,
          entry,
          depth,
          expanded,
          loading: Boolean(expanded && childNode?.loading && !childNode.entries.length),
          parentDir: dir,
        });
        if (expanded) visit(entry.path, depth + 1);
      }
      if (node.truncated) {
        rows.push({
          kind: "truncated",
          key: `trunc:${dir}`,
          depth,
          parentDir: dir,
        });
      }
    };
    visit("", 0);
    return rows;
  }, [dirMap, expandedDirs]);

  // Filtered Git entries & flat rows
  const queryLower = trimmedQuery.toLowerCase();
  const { flatGitRows, gitFileEntries } = useMemo(() => {
    const rows: FlatGitRow[] = [];
    const entries: Array<{ path: string; section: GitStatusSection; item: GitStatusItem; key: string }> = [];
    if (gitItems.length === 0) {
      return { flatGitRows: rows, gitFileEntries: entries };
    }
    for (const section of GIT_SECTION_ORDER) {
      const matched = gitItems.filter(
        (item) => Boolean(item[section]) && (!queryLower || item.path.toLowerCase().includes(queryLower)),
      );
      if (!matched.length) continue;
      rows.push({ kind: "header", key: `git-hdr:${section}`, section, count: matched.length });
      for (const item of matched) {
        const key = `git:${section}:${item.path}`;
        const code = section === "untracked" ? "+" : (item[section] ?? "M");
        rows.push({ kind: "item", key, section, item, code });
        entries.push({ path: item.path, section, item, key });
      }
    }
    return { flatGitRows: rows, gitFileEntries: entries };
  }, [gitItems, queryLower]);

  // Filtered Agent edit items
  const filteredEdits = useMemo(
    () =>
      queryLower
        ? agentEdits.filter(
            (item) =>
              item.path.toLowerCase().includes(queryLower) ||
              item.authors.some((a) => a.agentName.toLowerCase().includes(queryLower)),
          )
        : agentEdits,
    [agentEdits, queryLower],
  );

  // Filtered Chat attachment & deliverable items
  const filteredChatFiles = useMemo(
    () =>
      queryLower
        ? chatFiles.items.filter(
            (file) =>
              file.name.toLowerCase().includes(queryLower) ||
              (file.path?.toLowerCase().includes(queryLower) ?? false) ||
              file.senderName.toLowerCase().includes(queryLower),
          )
        : chatFiles.items,
    [chatFiles.items, queryLower],
  );

  // Keep `selection.file` fresh if chatFiles refreshes (e.g. a file was deleted or size changed)
  useEffect(() => {
    if (selection?.kind !== "chat") return;
    const updated = chatFiles.items.find((item) => item.id === selection.file.id);
    if (updated && updated !== selection.file) {
      setSelection({ kind: "chat", file: updated });
    }
  }, [chatFiles.items, selection]);

  // Auto-select sensible first item on wide split layout when switching tabs or initial data arrives
  useEffect(() => {
    if (!splitLayout) return;
    if (tab === "git") {
      const currentMatch =
        selection?.kind === "workspace" &&
        selection.initialLens === "git" &&
        gitFileEntries.some((e) => e.path === selection.path && e.section === selection.gitSection);
      if (!currentMatch && gitFileEntries[0]) {
        const first = gitFileEntries[0];
        const name = first.path.split("/").at(-1) ?? first.path;
        setSelection({
          kind: "workspace",
          path: first.path,
          name,
          size: null,
          image: /\.(png|jpe?g|gif|webp)$/i.test(name),
          previewable: true,
          initialLens: "git",
          gitSection: first.section,
        });
      }
    } else if (tab === "edits") {
      const currentMatch =
        selection?.kind === "workspace" &&
        selection.initialLens === "edits" &&
        filteredEdits.some((e) => e.path === selection.path);
      if (!currentMatch && filteredEdits[0]) {
        const first = filteredEdits[0];
        setSelection({
          kind: "workspace",
          path: first.path,
          name: first.name,
          size: null,
          image: /\.(png|jpe?g|gif|webp)$/i.test(first.name),
          previewable: true,
          initialLens: "edits",
        });
      }
    } else if (tab === "chat" && !selection && filteredChatFiles[0]) {
      setSelection({ kind: "chat", file: filteredChatFiles[0] });
    } else if (tab === "tree" && !selection && !trimmedQuery) {
      const rootEntries = dirMap[""]?.entries ?? [];
      const firstFile = rootEntries.find(
        (e) => e.kind === "file" && (/readme/i.test(e.name) || e.previewable || e.image),
      );
      if (firstFile) {
        setSelection({
          kind: "workspace",
          path: firstFile.path,
          name: firstFile.name,
          size: firstFile.size,
          image: firstFile.image,
          previewable: firstFile.previewable,
          initialLens: "content",
        });
      }
    }
  }, [splitLayout, tab, gitFileEntries, filteredEdits, filteredChatFiles, dirMap, trimmedQuery, selection]);

  // Virtual list setup for the active navigator list
  const activeCount =
    tab === "tree"
      ? trimmedQuery
        ? searchResult.items.length
        : flatTreeRows.length
      : tab === "git"
        ? flatGitRows.length
        : tab === "edits"
          ? filteredEdits.length
          : filteredChatFiles.length;

  const activeRowHeight = tab === "tree" ? (trimmedQuery ? 34 : 28) : tab === "git" ? 32 : tab === "edits" ? 38 : 48;

  const virtual = useVirtualList({
    count: activeCount,
    rowHeight: activeRowHeight,
    overscan: 12,
  });

  // Restore focus to selected row when returning from mobile detail view
  useLayoutEffect(() => {
    if (!mobileDetail && restoreFocusKey.current) {
      const key = restoreFocusKey.current;
      restoreFocusKey.current = null;
      // Ensure virtualized row is scrolled into view before focusing
      let idx = -1;
      if (tab === "git") idx = flatGitRows.findIndex((r) => r.key === key);
      else if (tab === "tree" && !trimmedQuery) idx = flatTreeRows.findIndex((r) => r.key === key);
      else if (tab === "tree" && trimmedQuery) idx = searchResult.items.findIndex((e) => `search:${e.path}` === key);
      else if (tab === "edits") idx = filteredEdits.findIndex((e) => `edit:${e.path}` === key);
      else if (tab === "chat") idx = filteredChatFiles.findIndex((f) => `chat:${f.id}` === key);
      if (idx >= 0) virtual.scrollToIndex(idx);
      rowButtons.current.get(key)?.focus({ preventScroll: true });
    }
  }, [
    mobileDetail,
    tab,
    trimmedQuery,
    flatGitRows,
    flatTreeRows,
    searchResult.items,
    filteredEdits,
    filteredChatFiles,
    virtual,
  ]);

  const selectItem = (next: WorkbenchSelection, rowKey: string) => {
    setSelection(next);
    restoreFocusKey.current = rowKey;
    if (!splitLayout) {
      setMobileDetail(true);
      setDetailFocusTick((v) => v + 1);
    }
  };

  // A file link in chat asks the workbench to open this workspace path directly.
  const openPathTick = useRef(0);
  useEffect(() => {
    const request = props.openPath;
    if (!request || request.tick === openPathTick.current) return;
    openPathTick.current = request.tick;
    setTab("tree");
    setQuery("");
    if (!request.path) return; // workspace-root link: land on the tree itself
    const ancestors = new Set<string>();
    addAncestorDirs(ancestors, request.path);
    setExpandedDirs((prev) => new Set([...prev, ...ancestors]));
    for (const dir of ancestors) if (!dirMap[dir]) void fetchDirectory(dir);
    const name = request.path.split("/").pop() ?? request.path;
    const image = /\.(png|jpe?g|gif|webp)$/i.test(name);
    setSelection({
      kind: "workspace",
      path: request.path,
      name,
      size: null,
      image,
      previewable: !image && getFilePreviewType(name, "") !== null,
      initialLens: "content",
    });
    restoreFocusKey.current = `tree:${request.path}`;
    if (!splitLayout) {
      setMobileDetail(true);
      setDetailFocusTick((v) => v + 1);
    }
  }, [props.openPath, dirMap, fetchDirectory, splitLayout]);

  const backToList = () => {
    if (selection) {
      if (selection.kind === "chat") restoreFocusKey.current = `chat:${selection.file.id}`;
      else if (tab === "git" && selection.gitSection)
        restoreFocusKey.current = `git:${selection.gitSection}:${selection.path}`;
      else if (tab === "edits") restoreFocusKey.current = `edit:${selection.path}`;
      else if (tab === "tree" && trimmedQuery) restoreFocusKey.current = `search:${selection.path}`;
      else restoreFocusKey.current = `tree:${selection.path}`;
    }
    setMobileDetail(false);
  };

  const downloadChatRow = async (file: ConversationFile) => {
    if (!file.downloadUrl || file.state !== "available" || downloadActions.current.has(file.id)) return;
    const controller = new AbortController();
    downloadActions.current.set(file.id, controller);
    setRowDownloads((prev) => ({ ...prev, [file.id]: true }));
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[file.id];
      return next;
    });
    setSrNotice("");
    try {
      const bytes = await readConversationFile(roomId, file, controller.signal);
      if (controller.signal.aborted) return;
      saveConversationFile(bytes, file.name);
      setSrNotice(t("已开始下载 {name}", { name: file.name }));
    } catch (err) {
      if (!controller.signal.aborted) {
        setRowErrors((prev) => ({ ...prev, [file.id]: errorText(err) }));
      }
    } finally {
      if (downloadActions.current.get(file.id) === controller) {
        downloadActions.current.delete(file.id);
        if (!controller.signal.aborted) {
          setRowDownloads((prev) => {
            const next = { ...prev };
            delete next[file.id];
            return next;
          });
        }
      }
    }
  };

  // Git prev/next steppers when viewing Git diff
  const selectedGitIndex =
    selection?.kind === "workspace" && selection.gitSection
      ? gitFileEntries.findIndex((e) => e.path === selection.path && e.section === selection.gitSection)
      : -1;

  const stepGit = (delta: -1 | 1) => {
    const target = gitFileEntries[selectedGitIndex + delta];
    if (!target) return;
    const name = target.path.split("/").at(-1) ?? target.path;
    setSelection({
      kind: "workspace",
      path: target.path,
      name,
      size: null,
      image: /\.(png|jpe?g|gif|webp)$/i.test(name),
      previewable: true,
      initialLens: "git",
      gitSection: target.section,
    });
  };

  // Resize drag logic
  const targetWidth = wideMode ? WIDE_WIDTH : normalWidth;
  const maxDockedWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, containerWidth - 360));
  const dockedWidth = Math.round(Math.max(MIN_WIDTH, Math.min(maxDockedWidth, targetWidth)));
  const clampWidth = (raw: number) => {
    const parentWidth = panelRef.current?.parentElement?.clientWidth ?? containerWidth;
    const maxAllowed = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parentWidth - 360));
    return Math.round(Math.max(MIN_WIDTH, Math.min(maxAllowed, raw)));
  };

  const startResize = (event: React.PointerEvent<HTMLHRElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startW = panelRef.current?.clientWidth ?? targetWidth;
    const onMove = (moveEvent: PointerEvent) => {
      const next = clampWidth(startW + (startX - moveEvent.clientX));
      setWideMode(false);
      setNormalWidth(next);
    };
    const onUp = (upEvent: PointerEvent) => {
      if (handle.hasPointerCapture(upEvent.pointerId)) handle.releasePointerCapture(upEvent.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      try {
        localStorage.setItem("tuantuan:file-workbench-width", String(panelRef.current?.clientWidth ?? normalWidth));
      } catch {
        /* Optional preference */
      }
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const gitChangeCount = gitItems.length;
  const activeSelectionId = selectionIdentity(selection);
  const selectedWorkspacePath = selection?.kind === "workspace" ? selection.path : null;

  const focusVirtualRow = (index: number, key: string) => {
    virtual.scrollToIndex(index);
    requestAnimationFrame(() => {
      rowButtons.current.get(key)?.focus({ preventScroll: true });
    });
  };

  const tabs = [
    ["tree", "全部文件", Folder, null],
    ["git", "Git 变更", GitBranch, gitChangeCount || null],
    ["edits", "Agent 改动", FileDiff, agentEdits.length || null],
    ["chat", "聊天附件", Paperclip, chatFiles.items.length || null],
  ] as const;

  const isRefreshing =
    (tab === "tree" && Boolean(dirMap[""]?.loading || searchResult.loading)) ||
    (tab === "git" && gitLoading) ||
    (tab === "edits" && editsLoading) ||
    (tab === "chat" && chatFiles.loading);

  return (
    <>
      {!docked && (
        // biome-ignore lint/a11y/noStaticElementInteractions: scrim click closes overlay; Escape and close button provide keyboard paths
        // biome-ignore lint/a11y/useKeyWithClickEvents: see above
        <div className="file-workbench-scrim" data-state={props.state} onClick={props.onClose} />
      )}
      <aside
        ref={panelRef}
        className="file-workbench"
        data-state={props.state}
        data-docked={docked || undefined}
        data-compact={!splitLayout || undefined}
        data-detail={(!splitLayout && mobileDetail) || undefined}
        aria-labelledby={titleId}
        style={
          docked
            ? {
                width: `${dockedWidth}px`,
              }
            : undefined
        }
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
          }
        }}
      >
        {docked && (
          <hr
            className="file-workbench-resizer"
            aria-orientation="vertical"
            aria-label={t("调整文件面板宽度")}
            aria-valuenow={Math.round(measuredWidth)}
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={MAX_WIDTH}
            tabIndex={0}
            onPointerDown={startResize}
            onDoubleClick={() => setWideMode((v) => !v)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const delta = event.key === "ArrowLeft" ? 32 : -32;
              const next = clampWidth((panelRef.current?.clientWidth ?? targetWidth) + delta);
              setWideMode(false);
              setNormalWidth(next);
              try {
                localStorage.setItem("tuantuan:file-workbench-width", String(next));
              } catch {
                /* Optional preference */
              }
            }}
          />
        )}

        <header className="file-workbench-head">
          <div className="file-workbench-title">
            <h2 id={titleId}>{t("会话文件与改动")}</h2>
            {(cwdName || props.roomName) && <span title={cwdName || props.roomName}>{cwdName || props.roomName}</span>}
          </div>
          <div className="file-workbench-head-actions">
            <button
              type="button"
              className="btn ghost icon"
              aria-label={tab === "git" || tab === "edits" ? t("刷新改动列表") : t("刷新文件列表")}
              title={tab === "git" || tab === "edits" ? t("刷新改动列表") : t("刷新文件列表")}
              onClick={() => setRefresh((v) => v + 1)}
            >
              <RefreshCw
                size={15}
                className={isRefreshing ? "conversation-files-spin" : undefined}
                aria-hidden="true"
              />
            </button>
            {docked && (
              <button
                type="button"
                className="btn ghost icon"
                aria-pressed={wideMode}
                aria-label={wideMode ? t("恢复默认宽度") : t("加宽工作台")}
                title={wideMode ? t("恢复默认宽度") : t("加宽工作台")}
                onClick={() => setWideMode((v) => !v)}
              >
                {wideMode ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}
              </button>
            )}
            <button
              ref={closeBtnRef}
              type="button"
              className="btn ghost icon"
              aria-label={t("关闭会话文件")}
              title={t("关闭会话文件")}
              onClick={props.onClose}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="file-workbench-controls">
          <div
            className="file-workbench-tabs"
            role="tablist"
            aria-label={t("文件筛选")}
            onKeyDown={(event) => {
              const order: FileWorkbenchTab[] = ["tree", "git", "edits", "chat"];
              const index = order.indexOf(tab);
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % order.length
                  : event.key === "ArrowLeft"
                    ? (index + order.length - 1) % order.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? order.length - 1
                        : null;
              if (next === null) return;
              event.preventDefault();
              const nextTab = order[next] as FileWorkbenchTab;
              setTab(nextTab);
              setMobileDetail(false);
              event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
            }}
          >
            {tabs.map(([value, label, Icon, count]) => (
              <button
                key={value}
                type="button"
                role="tab"
                className="file-workbench-tab"
                aria-selected={tab === value}
                tabIndex={tab === value ? 0 : -1}
                onClick={() => {
                  setTab(value);
                  setMobileDetail(false);
                }}
              >
                <Icon size={13} aria-hidden="true" />
                <span>{t(label)}</span>
                {count !== null && <em className="file-workbench-tab-count">{count}</em>}
              </button>
            ))}
          </div>

          <div className="file-workbench-search">
            <Search size={13} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder={t("筛选文件…")}
              aria-label={t("筛选文件…")}
              onChange={(event) => {
                setQuery(event.target.value);
                if (!splitLayout) setMobileDetail(false);
              }}
            />
            {query && (
              <button
                type="button"
                className="file-workbench-search-clear"
                aria-label={t("清空筛选")}
                onClick={() => setQuery("")}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        <div className="file-workbench-body">
          <nav
            ref={virtual.containerRef}
            className="file-workbench-nav"
            aria-label={
              tab === "tree"
                ? trimmedQuery
                  ? t("搜索结果")
                  : t("项目目录树")
                : tab === "git"
                  ? t("Git 工作区改动")
                  : tab === "edits"
                    ? t("会话改动列表")
                    : t("会话文件列表")
            }
            aria-busy={isRefreshing}
          >
            {/* Error banners */}
            {tab === "tree" && !trimmedQuery && dirMap[""]?.error && (
              <div className="file-workbench-notice" role="alert">
                <span>{translateError(dirMap[""].error)}</span>
              </div>
            )}
            {tab === "tree" && trimmedQuery && searchResult.error && (
              <div className="file-workbench-notice" role="alert">
                <span>{translateError(searchResult.error)}</span>
              </div>
            )}
            {tab === "git" && gitError && (
              <div className="file-workbench-notice" role="alert">
                <span>{t("工作区加载失败：{reason}", { reason: translateError(gitError) })}</span>
              </div>
            )}
            {tab === "edits" && editsError && (
              <div className="file-workbench-notice" role="alert">
                <span>{t("改动列表加载失败：{reason}", { reason: translateError(editsError) })}</span>
              </div>
            )}
            {tab === "chat" && chatFiles.error && (
              <div className="file-workbench-notice" role="alert">
                <span>{t("文件列表加载失败：{reason}", { reason: translateError(chatFiles.error) })}</span>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    chatFiles.failedPage === "more" ? void loadMoreChatFiles() : setRefresh((v) => v + 1)
                  }
                >
                  {t("重试")}
                </button>
              </div>
            )}

            {/* Empty states */}
            {tab === "tree" &&
              !trimmedQuery &&
              !dirMap[""]?.loading &&
              !dirMap[""]?.error &&
              flatTreeRows.length === 0 && (
                <div className="file-workbench-empty">
                  <FolderOpen size={24} strokeWidth={1.5} aria-hidden="true" />
                  <strong>{t("目录为空")}</strong>
                </div>
              )}
            {tab === "tree" &&
              trimmedQuery &&
              !searchResult.loading &&
              !searchResult.error &&
              searchResult.items.length === 0 && (
                <div className="file-workbench-empty">
                  <Search size={24} strokeWidth={1.5} aria-hidden="true" />
                  <strong>{t("没有匹配的文件")}</strong>
                </div>
              )}
            {tab === "git" && gitData?.state === "not-repository" && (
              <div className="file-workbench-empty">
                <GitBranch size={24} strokeWidth={1.5} aria-hidden="true" />
                <strong>{t("非 Git 目录")}</strong>
              </div>
            )}
            {tab === "git" &&
              gitData &&
              (gitData.state === "ready" || gitData.state === "unborn") &&
              flatGitRows.length === 0 && (
                <div className="file-workbench-empty">
                  <FileDiff size={24} strokeWidth={1.5} aria-hidden="true" />
                  <strong>{trimmedQuery ? t("没有匹配的文件") : t("会话目录没有 Git 改动")}</strong>
                </div>
              )}
            {tab === "edits" && !editsLoading && !editsError && filteredEdits.length === 0 && (
              <div className="file-workbench-empty">
                <FileDiff size={24} strokeWidth={1.5} aria-hidden="true" />
                <strong>{trimmedQuery ? t("没有匹配的文件") : t("还没有报告的改动")}</strong>
              </div>
            )}
            {tab === "chat" && !chatFiles.loading && !chatFiles.error && filteredChatFiles.length === 0 && (
              <div className="file-workbench-empty">
                <FolderOpen size={24} strokeWidth={1.5} aria-hidden="true" />
                <strong>
                  {trimmedQuery
                    ? t("没有匹配的文件")
                    : chatFiles.nextCursor
                      ? t("继续加载以查看更早的文件")
                      : t("还没有会话文件")}
                </strong>
              </div>
            )}

            {/* Virtualized Rows */}
            {activeCount > 0 && (
              <div className="file-virtual-spacer" style={{ height: virtual.totalHeight }}>
                <div className="file-virtual-slice" style={{ transform: `translateY(${virtual.offsetTop}px)` }}>
                  {tab === "tree" &&
                    !trimmedQuery &&
                    flatTreeRows.slice(virtual.startIndex, virtual.endIndex).map((row, sliceIdx) => {
                      const rowIndex = virtual.startIndex + sliceIdx;
                      if (row.kind === "truncated" || !row.entry) {
                        return (
                          <div
                            key={row.key}
                            className="file-tree-truncated"
                            style={{ height: activeRowHeight, paddingInlineStart: 12 + row.depth * 14 }}
                          >
                            {t("仅显示前 {count} 项", { count: 5000 })}
                          </div>
                        );
                      }
                      const entry = row.entry;
                      const isDir = entry.kind === "dir";
                      const active = !isDir && selectedWorkspacePath === entry.path;
                      const gitBadge = isDir
                        ? dirtyFolders.has(entry.path)
                          ? { code: "●", tone: "dir" }
                          : null
                        : gitPriorityBadge(gitByPath.get(entry.path));
                      const editInfo = isDir ? null : editsByPath.get(entry.path);
                      const dirHasEdit = isDir && editFolders.has(entry.path);
                      const dirHasOverlap = isDir && overlapFolders.has(entry.path);

                      return (
                        <button
                          key={row.key}
                          type="button"
                          className="file-tree-row"
                          data-kind={entry.kind}
                          data-muted={entry.muted || undefined}
                          data-selected={active || undefined}
                          aria-expanded={isDir ? Boolean(row.expanded) : undefined}
                          aria-pressed={!isDir ? active : undefined}
                          title={entry.muted ? `${entry.path} — ${t("依赖或构建产物目录（默认折叠）")}` : entry.path}
                          style={{ height: activeRowHeight, paddingInlineStart: 8 + row.depth * 14 }}
                          ref={(el) => {
                            if (el) rowButtons.current.set(row.key, el);
                            else rowButtons.current.delete(row.key);
                          }}
                          onClick={() => {
                            if (isDir) {
                              toggleDir(entry.path);
                            } else {
                              selectItem(
                                {
                                  kind: "workspace",
                                  path: entry.path,
                                  name: entry.name,
                                  size: entry.size,
                                  image: entry.image,
                                  previewable: entry.previewable,
                                  initialLens: "content",
                                },
                                row.key,
                              );
                            }
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.key === "ArrowDown" ||
                              event.key === "ArrowUp" ||
                              event.key === "Home" ||
                              event.key === "End"
                            ) {
                              event.preventDefault();
                              const nextIdx =
                                event.key === "ArrowDown"
                                  ? Math.min(rowIndex + 1, flatTreeRows.length - 1)
                                  : event.key === "ArrowUp"
                                    ? Math.max(rowIndex - 1, 0)
                                    : event.key === "Home"
                                      ? 0
                                      : flatTreeRows.length - 1;
                              const nextRow = flatTreeRows[nextIdx];
                              if (nextRow) focusVirtualRow(nextIdx, nextRow.key);
                            } else if (isDir && event.key === "ArrowRight") {
                              event.preventDefault();
                              if (!row.expanded) toggleDir(entry.path);
                              else {
                                const child = flatTreeRows[rowIndex + 1];
                                if (child) focusVirtualRow(rowIndex + 1, child.key);
                              }
                            } else if (event.key === "ArrowLeft") {
                              event.preventDefault();
                              if (isDir && row.expanded) toggleDir(entry.path);
                              else if (row.parentDir) {
                                const parentIdx = flatTreeRows.findIndex((r) => r.key === `tree:${row.parentDir}`);
                                const parentRow = flatTreeRows[parentIdx];
                                if (parentIdx >= 0 && parentRow) focusVirtualRow(parentIdx, parentRow.key);
                              }
                            }
                          }}
                        >
                          <span className="file-tree-chevron" aria-hidden="true">
                            {isDir ? (
                              row.loading ? (
                                <LoaderCircle size={12} className="conversation-files-spin" />
                              ) : row.expanded ? (
                                <ChevronDown size={13} />
                              ) : (
                                <ChevronRight size={13} />
                              )
                            ) : null}
                          </span>
                          <span className="file-tree-icon" aria-hidden="true">
                            {isDir ? (
                              row.expanded ? (
                                <FolderOpen size={14} />
                              ) : (
                                <Folder size={14} />
                              )
                            ) : entry.image ? (
                              <ImageIcon size={14} />
                            ) : (
                              <FileCode2 size={14} />
                            )}
                          </span>
                          <span className="file-tree-name">{entry.name}</span>
                          {(editInfo?.overlap || dirHasOverlap) && (
                            <span className="file-row-tag overlap" title={t("多位 Agent 改过同一文件")}>
                              {t("重叠")}
                            </span>
                          )}
                          {!editInfo?.overlap && (editInfo || dirHasEdit) && (
                            <span className="file-row-agent-dot" title={t("Agent 改动")} aria-hidden="true" />
                          )}
                          {gitBadge && (
                            <span className="file-row-git" data-code={gitBadge.tone}>
                              {gitBadge.code}
                            </span>
                          )}
                        </button>
                      );
                    })}

                  {tab === "tree" &&
                    Boolean(trimmedQuery) &&
                    searchResult.items.slice(virtual.startIndex, virtual.endIndex).map((entry, sliceIdx) => {
                      const rowIndex = virtual.startIndex + sliceIdx;
                      const rowKey = `search:${entry.path}`;
                      const active = selectedWorkspacePath === entry.path;
                      const dir = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
                      const gitBadge = gitPriorityBadge(gitByPath.get(entry.path));
                      const editInfo = editsByPath.get(entry.path);
                      return (
                        <button
                          key={rowKey}
                          type="button"
                          className="file-flat-row"
                          data-selected={active || undefined}
                          aria-pressed={active}
                          style={{ height: activeRowHeight }}
                          ref={(el) => {
                            if (el) rowButtons.current.set(rowKey, el);
                            else rowButtons.current.delete(rowKey);
                          }}
                          onClick={() =>
                            selectItem(
                              {
                                kind: "workspace",
                                path: entry.path,
                                name: entry.name,
                                size: entry.size,
                                image: entry.image,
                                previewable: entry.previewable,
                                initialLens: "content",
                              },
                              rowKey,
                            )
                          }
                          onKeyDown={(event) => {
                            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                            event.preventDefault();
                            const nextIdx =
                              event.key === "ArrowDown"
                                ? Math.min(rowIndex + 1, searchResult.items.length - 1)
                                : event.key === "ArrowUp"
                                  ? Math.max(rowIndex - 1, 0)
                                  : event.key === "Home"
                                    ? 0
                                    : searchResult.items.length - 1;
                            const nextEntry = searchResult.items[nextIdx];
                            if (nextEntry) focusVirtualRow(nextIdx, `search:${nextEntry.path}`);
                          }}
                        >
                          <FileCode2 size={14} aria-hidden="true" />
                          <span className="file-flat-main">
                            <strong>{entry.name}</strong>
                            {dir && <span>{dir}</span>}
                          </span>
                          {editInfo && <span className="file-row-agent-dot" aria-hidden="true" />}
                          {gitBadge && (
                            <span className="file-row-git" data-code={gitBadge.tone}>
                              {gitBadge.code}
                            </span>
                          )}
                        </button>
                      );
                    })}

                  {tab === "git" &&
                    flatGitRows.slice(virtual.startIndex, virtual.endIndex).map((row, sliceIdx) => {
                      const rowIndex = virtual.startIndex + sliceIdx;
                      if (row.kind === "header") {
                        return (
                          <div key={row.key} className="file-section-header" style={{ height: activeRowHeight }}>
                            <span>
                              {t(
                                row.section === "staged" ? "已暂存" : row.section === "unstaged" ? "未暂存" : "未跟踪",
                              )}
                            </span>
                            <span>{row.count}</span>
                          </div>
                        );
                      }
                      const name = row.item.path.split("/").at(-1) ?? row.item.path;
                      const dir = row.item.path.includes("/")
                        ? row.item.path.slice(0, row.item.path.lastIndexOf("/"))
                        : "";
                      const active =
                        selection?.kind === "workspace" &&
                        selection.path === row.item.path &&
                        selection.gitSection === row.section;
                      return (
                        <button
                          key={row.key}
                          type="button"
                          className="file-flat-row git-browser-file"
                          data-selected={active || undefined}
                          aria-pressed={active}
                          style={{ height: activeRowHeight }}
                          ref={(el) => {
                            if (el) rowButtons.current.set(row.key, el);
                            else rowButtons.current.delete(row.key);
                          }}
                          onClick={() =>
                            selectItem(
                              {
                                kind: "workspace",
                                path: row.item.path,
                                name,
                                size: null,
                                image: /\.(png|jpe?g|gif|webp)$/i.test(name),
                                previewable: true,
                                initialLens: "git",
                                gitSection: row.section,
                              },
                              row.key,
                            )
                          }
                          onKeyDown={(event) => {
                            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                            event.preventDefault();
                            const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                            let nextIdx =
                              event.key === "Home" ? 0 : event.key === "End" ? flatGitRows.length - 1 : rowIndex + step;
                            while (
                              nextIdx >= 0 &&
                              nextIdx < flatGitRows.length &&
                              flatGitRows[nextIdx]?.kind === "header"
                            ) {
                              nextIdx += step || (event.key === "Home" ? 1 : -1);
                            }
                            const nextRow = flatGitRows[nextIdx];
                            if (nextRow && nextRow.kind === "item") {
                              const nextName = nextRow.item.path.split("/").at(-1) ?? nextRow.item.path;
                              setSelection({
                                kind: "workspace",
                                path: nextRow.item.path,
                                name: nextName,
                                size: null,
                                image: /\.(png|jpe?g|gif|webp)$/i.test(nextName),
                                previewable: true,
                                initialLens: "git",
                                gitSection: nextRow.section,
                              });
                              focusVirtualRow(nextIdx, nextRow.key);
                            }
                          }}
                        >
                          <FileCode2 size={14} aria-hidden="true" />
                          <span className="file-flat-main">
                            <strong>{name}</strong>
                            {dir && <span>{dir}</span>}
                          </span>
                          <span className="file-row-git" data-code={row.item[row.section]}>
                            {row.code}
                          </span>
                        </button>
                      );
                    })}

                  {tab === "edits" &&
                    filteredEdits.slice(virtual.startIndex, virtual.endIndex).map((item, sliceIdx) => {
                      const rowIndex = virtual.startIndex + sliceIdx;
                      const rowKey = `edit:${item.path}`;
                      const active = selection?.kind === "workspace" && selection.path === item.path;
                      return (
                        <button
                          key={rowKey}
                          type="button"
                          className="file-flat-row session-change-row"
                          data-path={item.path}
                          data-selected={active || undefined}
                          aria-pressed={active}
                          style={{ height: activeRowHeight }}
                          ref={(el) => {
                            if (el) rowButtons.current.set(rowKey, el);
                            else rowButtons.current.delete(rowKey);
                          }}
                          onClick={() =>
                            selectItem(
                              {
                                kind: "workspace",
                                path: item.path,
                                name: item.name,
                                size: null,
                                image: /\.(png|jpe?g|gif|webp)$/i.test(item.name),
                                previewable: true,
                                initialLens: "edits",
                              },
                              rowKey,
                            )
                          }
                          onKeyDown={(event) => {
                            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                            event.preventDefault();
                            const nextIdx =
                              event.key === "ArrowDown"
                                ? Math.min(rowIndex + 1, filteredEdits.length - 1)
                                : event.key === "ArrowUp"
                                  ? Math.max(rowIndex - 1, 0)
                                  : event.key === "Home"
                                    ? 0
                                    : filteredEdits.length - 1;
                            const nextItem = filteredEdits[nextIdx];
                            if (nextItem) focusVirtualRow(nextIdx, `edit:${nextItem.path}`);
                          }}
                        >
                          <FileDiff size={14} aria-hidden="true" />
                          <span className="file-flat-main">
                            <strong>{item.name}</strong>
                            <span>
                              {t("{count} 次改动", { count: item.editCount })} ·{" "}
                              {item.authors.map((a) => a.agentName).join(", ")}
                            </span>
                          </span>
                          {item.overlap && (
                            <span className="file-row-tag overlap" title={t("多位 Agent 改过同一文件")}>
                              <Users size={11} aria-hidden="true" />
                              {t("重叠")}
                            </span>
                          )}
                        </button>
                      );
                    })}

                  {tab === "chat" &&
                    filteredChatFiles.slice(virtual.startIndex, virtual.endIndex).map((file, sliceIdx) => {
                      const rowIndex = virtual.startIndex + sliceIdx;
                      const rowKey = `chat:${file.id}`;
                      const active = activeSelectionId === rowKey;
                      const isImg = file.image && (IMAGE_MIME_TYPES as readonly string[]).includes(file.mimeType);
                      const canRead = file.state === "available" && Boolean(file.downloadUrl);
                      const downloading = Boolean(rowDownloads[file.id]);
                      const rowErr = rowErrors[file.id];
                      const statusText =
                        file.state !== "available"
                          ? file.state === "missing"
                            ? t("文件已不存在")
                            : file.size !== null && file.size > CONVERSATION_FILE_DOWNLOAD_MAX_BYTES
                              ? t("文件超过 100 MiB 下载上限")
                              : t("文件不可用")
                          : null;

                      return (
                        <div
                          key={rowKey}
                          className="file-chat-row conversation-file-row"
                          data-file-id={file.id}
                          data-selected={active || undefined}
                          style={{ height: activeRowHeight }}
                        >
                          <button
                            type="button"
                            className="file-chat-select"
                            aria-pressed={active}
                            ref={(el) => {
                              if (el) rowButtons.current.set(rowKey, el);
                              else rowButtons.current.delete(rowKey);
                            }}
                            onClick={() => selectItem({ kind: "chat", file }, rowKey)}
                            onKeyDown={(event) => {
                              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                              event.preventDefault();
                              const nextIdx =
                                event.key === "ArrowDown"
                                  ? Math.min(rowIndex + 1, filteredChatFiles.length - 1)
                                  : event.key === "ArrowUp"
                                    ? Math.max(rowIndex - 1, 0)
                                    : event.key === "Home"
                                      ? 0
                                      : filteredChatFiles.length - 1;
                              const nextFile = filteredChatFiles[nextIdx];
                              if (nextFile) focusVirtualRow(nextIdx, `chat:${nextFile.id}`);
                            }}
                          >
                            <span className="file-tree-icon" aria-hidden="true">
                              {isImg ? <ImageIcon size={15} /> : <File size={15} />}
                            </span>
                            <span className="file-chat-meta">
                              <strong title={file.name}>{file.name}</strong>
                              <span>
                                {rowErr ? (
                                  <span className="file-chat-err" role="alert">
                                    {t("下载失败：{reason}", { reason: translateError(rowErr) })}
                                  </span>
                                ) : statusText ? (
                                  <span className="file-chat-unavailable">{statusText}</span>
                                ) : (
                                  <>
                                    {file.source === "attachment" ? t("用户附件") : t("Agent 文件")} · {file.senderName}
                                    {file.size !== null ? ` · ${formatAttachmentSize(file.size)}` : ""}
                                  </>
                                )}
                              </span>
                            </span>
                          </button>
                          <div className="file-chat-actions">
                            <button
                              type="button"
                              className="btn ghost icon sm"
                              disabled={!canRead || downloading}
                              aria-label={t("下载文件 {name}", { name: file.name })}
                              title={t("下载")}
                              onClick={() => void downloadChatRow(file)}
                            >
                              {downloading ? (
                                <LoaderCircle size={13} className="conversation-files-spin" aria-hidden="true" />
                              ) : (
                                <Download size={13} aria-hidden="true" />
                              )}
                            </button>
                            <button
                              type="button"
                              className="btn ghost icon sm conversation-file-origin"
                              aria-label={t("查看来源消息")}
                              title={t("查看来源消息")}
                              onClick={() => props.onSelectMessage(file.messageId)}
                            >
                              <ArrowUpRight size={13} aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {tab === "chat" && chatFiles.nextCursor && !chatFiles.error && (
              <button
                type="button"
                className="btn sm conversation-files-more"
                disabled={chatFiles.loading}
                onClick={() => void loadMoreChatFiles()}
              >
                {chatFiles.loading ? (
                  <LoaderCircle size={13} className="conversation-files-spin" aria-hidden="true" />
                ) : null}
                {t("加载更早的文件")}
              </button>
            )}
          </nav>

          <FileViewerPane
            roomId={roomId}
            selection={selection}
            gitItem={selectedWorkspacePath ? (gitByPath.get(selectedWorkspacePath) ?? null) : null}
            gitScope={gitScope}
            gitUnborn={gitData?.state === "unborn"}
            gitStepPrev={selectedGitIndex > 0 ? () => stepGit(-1) : null}
            gitStepNext={
              selectedGitIndex >= 0 && selectedGitIndex < gitFileEntries.length - 1 ? () => stepGit(1) : null
            }
            agentChange={selectedWorkspacePath ? (editsByPath.get(selectedWorkspacePath) ?? null) : null}
            revision={props.revision}
            refreshToken={refresh}
            compact={!splitLayout}
            detailFocusTick={detailFocusTick}
            onBack={backToList}
            onSelectMessage={props.onSelectMessage}
            onSelectGitSection={(section) => {
              if (selection?.kind === "workspace") {
                setSelection({ ...selection, gitSection: section, initialLens: "git" });
              }
            }}
          />
        </div>

        <div className="sr-only" role="status">
          {srNotice}
        </div>
      </aside>
    </>
  );
}
