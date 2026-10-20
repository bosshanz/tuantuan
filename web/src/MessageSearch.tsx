import { CircleX, LoaderCircle, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  MESSAGE_SEARCH_QUERY_MAX,
  type MessageSearchPage,
  type MessageSearchResult,
  type MessageSearchScope,
} from "../../shared/messageSearch";
import { api } from "./api";
import { intlLocale, translateError, useI18n } from "./i18n";
import "./messageSearch.css";

export interface MessageSearchQuickItem {
  key: string;
  label: string;
  hint: string;
  icon: ReactNode;
  path: string;
}

export interface MessageSearchProps {
  currentRoom?: { id: string; name: string };
  initialScope?: MessageSearchScope;
  onSelectMessage?: (result: MessageSearchResult) => void;
  onClose: () => void;
  state?: "open" | "closing";
  /** Optional navigation entries preserve Cmd+K's existing quick-switch behavior. */
  quickItems?: MessageSearchQuickItem[];
  onGo?: (path: string) => void;
}

interface SearchState {
  items: MessageSearchResult[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
}

const emptyState: SearchState = { items: [], nextCursor: null, loading: false, error: null };

/** Match SQLite lower(): ASCII letters fold, while all other body characters remain literal. */
function highlightedSnippet(text: string, query: string) {
  const fold = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const at = fold(text).indexOf(fold(query));
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

export function MessageSearch(props: MessageSearchProps) {
  const { t, locale } = useI18n();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<MessageSearchScope>(
    props.initialScope === "current" && props.currentRoom ? "current" : "all",
  );
  const [active, setActive] = useState(0);
  const [search, setSearch] = useState<SearchState>(emptyState);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const requestInFlight = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(document.activeElement);
  const listId = useId();
  const query = q.trim();
  const roomId = scope === "current" ? props.currentRoom?.id : undefined;
  const quickItems = useMemo(() => {
    if (scope === "current") return [];
    const keyword = query.toLowerCase();
    return (props.quickItems ?? []).filter((item) => !keyword || item.label.toLowerCase().includes(keyword));
  }, [props.quickItems, query, scope]);
  const count = quickItems.length + search.items.length;

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      generation.current++;
      const target = returnFocus.current as HTMLElement | null;
      if (target?.isConnected) target.focus?.();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly restarts the same search
  useEffect(() => {
    const query = q.trim();
    const token = ++generation.current;
    requestInFlight.current = false;
    setSearch(query ? { ...emptyState, loading: true } : emptyState);
    setActive(0);
    if (!query) return;
    if (scope === "current" && !roomId) {
      setSearch({ ...emptyState, error: "会话不存在" });
      return;
    }
    const timer = setTimeout(() => {
      requestInFlight.current = true;
      const params = new URLSearchParams({ q: query });
      if (roomId) params.set("roomId", roomId);
      api<MessageSearchPage>("GET", `/api/messages/search?${params}`)
        .then((page) => {
          if (generation.current === token) setSearch({ ...page, loading: false, error: null });
        })
        .catch((error: unknown) => {
          if (generation.current === token)
            setSearch({ ...emptyState, error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          if (generation.current === token) requestInFlight.current = false;
        });
    }, 220);
    return () => clearTimeout(timer);
  }, [q, roomId, scope, retry]);

  useEffect(() => {
    setActive((index) => Math.min(index, Math.max(0, count - 1)));
  }, [count]);

  useEffect(() => {
    if (count)
      dialogRef.current?.querySelector(`#${CSS.escape(`${listId}-${active}`)}`)?.scrollIntoView({ block: "nearest" });
  }, [active, count, listId]);

  const invalidate = () => {
    // Invalidate immediately: an old response arriving before the next effect must stay discarded.
    generation.current++;
    requestInFlight.current = false;
    setSearch(emptyState);
    setActive(0);
  };

  const loadMore = async () => {
    if (!search.nextCursor || requestInFlight.current) return;
    const token = generation.current;
    requestInFlight.current = true;
    setSearch((previous) => ({ ...previous, loading: true, error: null }));
    const params = new URLSearchParams({ q: query, cursor: search.nextCursor });
    if (roomId) params.set("roomId", roomId);
    try {
      const page = await api<MessageSearchPage>("GET", `/api/messages/search?${params}`);
      if (generation.current !== token) return;
      setSearch((previous) => {
        const seen = new Set(previous.items.map((item) => item.messageId));
        return {
          items: [...previous.items, ...page.items.filter((item) => !seen.has(item.messageId))],
          nextCursor: page.nextCursor,
          loading: false,
          error: null,
        };
      });
    } catch (error) {
      if (generation.current === token)
        setSearch((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
    } finally {
      if (generation.current === token) requestInFlight.current = false;
    }
  };

  const pick = (index: number) => {
    const quick = quickItems[index];
    if (quick) props.onGo?.(quick.path);
    else {
      const result = search.items[index - quickItems.length];
      if (result) props.onSelectMessage?.(result);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop closes on pointer input; dialog handles keyboard input
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the dialog
    <div
      className="overlay message-search-overlay"
      data-state={props.state ?? "open"}
      onClick={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <div
        ref={dialogRef}
        className="palette message-search"
        role="dialog"
        aria-modal="true"
        aria-label={t("搜索聊天记录")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
          } else if (event.key === "Tab") {
            const focusable = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
              ),
            );
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          } else if (
            !event.nativeEvent.isComposing &&
            (event.target === inputRef.current || (event.target as HTMLElement).getAttribute("role") === "option")
          ) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive(
                (index) => (index + (event.key === "ArrowDown" ? 1 : Math.max(1, count) - 1)) % Math.max(1, count),
              );
              inputRef.current?.focus();
            } else if (event.key === "Enter" && event.target === inputRef.current) {
              event.preventDefault();
              pick(active);
            }
          }
        }}
      >
        <div className="palette-input">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label={t("搜索聊天记录")}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={count ? `${listId}-${active}` : undefined}
            placeholder={props.quickItems ? t("搜索会话、Agent 或聊天正文…") : t("输入关键词搜索聊天正文…")}
            value={q}
            maxLength={MESSAGE_SEARCH_QUERY_MAX}
            onChange={(event) => {
              invalidate();
              setQ(event.target.value);
            }}
          />
          {q && (
            <button
              type="button"
              className="btn ghost icon message-search-clear"
              aria-label={t("清空搜索")}
              onClick={() => {
                invalidate();
                setQ("");
                inputRef.current?.focus();
              }}
            >
              <CircleX size={16} />
            </button>
          )}
          <button type="button" className="btn ghost icon" aria-label={t("关闭搜索")} onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>
        <fieldset className="message-search-scopes" aria-label={t("搜索范围")}>
          {(["all", "current"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={scope === value}
              disabled={value === "current" && !props.currentRoom}
              title={value === "current" ? props.currentRoom?.name : undefined}
              onClick={() => {
                if (scope !== value) {
                  invalidate();
                  setScope(value);
                }
                inputRef.current?.focus();
              }}
            >
              {value === "all" ? t("全部会话") : t("当前会话")}
            </button>
          ))}
          {scope === "current" && <span className="message-search-room">{props.currentRoom?.name}</span>}
        </fieldset>
        <div className="palette-list message-search-list" role="listbox" id={listId} aria-label={t("搜索结果")}>
          {quickItems.length > 0 && (
            <>
              <div className="message-search-heading">{t("快速切换")}</div>
              {quickItems.map((item, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  id={`${listId}-${index}`}
                  key={item.key}
                  className="pop-item message-search-quick"
                  onMouseMove={() => setActive(index)}
                  onClick={() => pick(index)}
                >
                  <span className="pop-icon">{item.icon}</span>
                  <span className="message-search-label">{item.label}</span>
                  <span className="message-search-hint">{item.hint}</span>
                </button>
              ))}
            </>
          )}
          {query && (
            <>
              <div className="message-search-heading">{t("聊天正文")}</div>
              {search.items.map((result, index) => {
                const itemIndex = index + quickItems.length;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={itemIndex === active}
                    id={`${listId}-${itemIndex}`}
                    key={result.messageId}
                    className="message-search-result"
                    onMouseMove={() => setActive(itemIndex)}
                    onClick={() => pick(itemIndex)}
                  >
                    <span className="message-search-location">
                      {result.projectName && <span>{result.projectName} / </span>}
                      {result.roomName}
                    </span>
                    <span className="message-search-meta">
                      <span>{result.senderName}</span>
                      <time dateTime={new Date(result.createdAt).toISOString()}>
                        {new Date(result.createdAt).toLocaleString(intlLocale(locale), {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </span>
                    <span className="message-search-snippet">{highlightedSnippet(result.snippet, query)}</span>
                  </button>
                );
              })}
            </>
          )}
          {!query && <div className="message-search-status">{t("输入关键词，搜索已保存的聊天正文。")}</div>}
          {query && !search.loading && !search.error && search.items.length === 0 && (
            <div className="message-search-status">{t("没有匹配的聊天正文")}</div>
          )}
        </div>
        <div className="message-search-feedback" aria-live="polite">
          {search.loading && (
            <span className="message-search-loading">
              <LoaderCircle size={14} aria-hidden="true" />
              {t("搜索中…")}
            </span>
          )}
          {search.error && (
            <div className="message-search-error" role="alert">
              <span>{t("搜索失败：{reason}", { reason: translateError(search.error) })}</span>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  if (search.nextCursor) void loadMore();
                  else setRetry((value) => value + 1);
                }}
              >
                {t("重试搜索")}
              </button>
            </div>
          )}
          {search.nextCursor && !search.loading && !search.error && (
            <button type="button" className="btn sm message-search-more" onClick={() => void loadMore()}>
              {t("加载更多结果")}
            </button>
          )}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> {t("选择")}
          </span>
          <span>
            <kbd>Enter</kbd> {t("打开")}
          </span>
          <span>
            <kbd>Esc</kbd> {t("关闭")}
          </span>
        </div>
      </div>
    </div>
  );
}
