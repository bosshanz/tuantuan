import type { Element } from "hast";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { User, Users } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { type AvatarShape, defaultAvatar } from "../../server/avatars";
import type { Agent, Room } from "./api";
import type { Expression } from "./avatarState";
import { BotAvatar } from "./BotAvatar";
import { PreviewImage } from "./ImagePreview";
import { getLocale, intlLocale, type Locale, translate, useI18n } from "./i18n";
import { MermaidBlock } from "./MermaidBlock";
import { withViewTransition } from "./motion";

for (const [name, lang] of Object.entries({ bash, css, go, javascript, json, python, sql, typescript, xml, yaml }))
  hljs.registerLanguage(name, lang);
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["js", "jsx"], { languageName: "javascript" });
hljs.registerAliases(["sh", "shell"], { languageName: "bash" });
hljs.registerAliases(["py"], { languageName: "python" });

/** Callers own rendering budgets; highlight.js escapes source before adding its token spans. */
export function highlightCode(source: string, language?: string): string | null {
  return language && hljs.getLanguage(language) ? hljs.highlight(source, { language }).value : null;
}

const _EMOJI = /\p{Extended_Pictographic}/u;

export function AgentAvatar({
  agent,
  size = 32,
  name,
  expression,
  animate,
  pulse,
}: {
  agent?: Pick<Agent, "color" | "name"> & { avatarShape?: AvatarShape };
  size?: number;
  name?: string;
  expression?: Expression;
  animate?: boolean;
  pulse?: unknown;
}) {
  if (!agent) {
    return (
      <span className="avatar human" style={{ ["--size" as string]: `${size}px` }} aria-hidden>
        {(name ?? "?").slice(0, 1)}
      </span>
    );
  }
  const fallback = defaultAvatar(agent.name);
  return (
    <span className="avatar bot" style={{ ["--size" as string]: `${size}px` }} aria-hidden>
      <BotAvatar
        shape={agent.avatarShape ?? fallback.shape}
        color={agent.color || fallback.color}
        size={size}
        expression={expression}
        animate={animate}
        pulse={pulse}
      />
    </span>
  );
}

export function HumanAvatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span className="avatar human" style={{ ["--size" as string]: `${size}px` }} aria-hidden>
      {name ? name.slice(0, 1) : <User size={size * 0.5} />}
    </span>
  );
}

export function RoomIcon({
  room,
  agents,
  size = 32,
  busy = false,
}: {
  room: Room;
  agents: Agent[];
  size?: number;
  busy?: boolean;
}) {
  const members = room.agentIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
  if (members.length === 1 && members[0])
    return <AgentAvatar agent={members[0]} size={size} expression={busy ? "thinking" : "idle"} animate={busy} />;
  if (members.length === 0)
    return (
      <span className="room-icon" style={{ ["--size" as string]: `${size}px` }} aria-hidden>
        <Users size={size * 0.5} />
      </span>
    );
  const mini = Math.round(size * 0.64);
  return (
    <span className="room-stack" style={{ ["--size" as string]: `${size}px` }} aria-hidden>
      {members.slice(0, 2).map((a) => (
        <AgentAvatar key={a.id} agent={a} size={mini} expression={busy ? "thinking" : "idle"} animate={busy} />
      ))}
      {members.length > 2 && <span className="room-stack-more">+{members.length - 2}</span>}
    </span>
  );
}

export function roomSubtitle(room: Room, agents: Agent[]): string {
  const names = room.agentIds.map((id) => agents.find((a) => a.id === id)?.name).filter(Boolean);
  return names.length ? names.join(getLocale() === "en" ? ", " : "、") : translate("Agent 已删除");
}

/** Splits plain text so known @names render as mention chips. */
function withMentions(children: ReactNode, names: string[]): ReactNode {
  if (names.length === 0) return children;
  const sorted = [...names].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`@(${sorted.join("|")})`, "gi");
  const map = (node: ReactNode, k: number): ReactNode => {
    if (typeof node !== "string") return node;
    const out: ReactNode[] = [];
    let last = 0;
    for (const m of node.matchAll(re)) {
      out.push(node.slice(last, m.index));
      out.push(
        <span className="mention" key={`${k}-${m.index}`}>
          {m[0]}
        </span>,
      );
      last = (m.index ?? 0) + m[0].length;
    }
    out.push(node.slice(last));
    return out;
  };
  return Array.isArray(children) ? children.map(map) : map(children, 0);
}

const MentionNames = createContext<string[]>([]);
const markdownPlugins = [remarkGfm];

function containsImage(node: Element): boolean {
  return node.tagName === "img" || node.children.some((child) => child.type === "element" && containsImage(child));
}

// Stable renderer identities preserve open previews and in-flight diagrams during streaming updates.
const markdownComponents: Components = {
  p: function MentionParagraph({ children }) {
    return <p>{withMentions(children, useContext(MentionNames))}</p>;
  },
  li: function MentionItem({ children }) {
    return <li>{withMentions(children, useContext(MentionNames))}</li>;
  },
  a: function MarkdownLink({ href, children, node }) {
    const { t } = useI18n();
    return node && containsImage(node) ? (
      <span className="md-linked-image">
        {children}
        {href && (
          <a className="md-image-link" href={href} target="_blank" rel="noreferrer noopener">
            {t("打开链接")}
          </a>
        )}
      </span>
    ) : (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  img: ({ src, alt, title }) => (src ? <PreviewImage src={src} alt={alt} title={title} /> : <span>{alt}</span>),
  pre: ({ children, node }) => {
    const code = node?.children[0];
    if (
      code?.type === "element" &&
      code.tagName === "code" &&
      Array.isArray(code.properties.className) &&
      code.properties.className.includes("language-mermaid")
    ) {
      const source = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
      return <MermaidBlock source={source} />;
    }
    return <pre>{children}</pre>;
  },
  code: ({ className, children }) => {
    const lang = /language-(\w+)/.exec(className ?? "")?.[1];
    const src = String(children ?? "");
    if (lang && hljs.getLanguage(lang)) {
      return (
        <code
          className={className}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js escapes its input
          dangerouslySetInnerHTML={{ __html: hljs.highlight(src, { language: lang }).value }}
        />
      );
    }
    return <code className={className}>{children}</code>;
  },
};

/** Markdown without raw HTML, code highlighted, explicit Mermaid fences and accessible image previews. */
export function MessageMarkdown({ text, mentionNames }: { text: string; mentionNames: string[] }) {
  return (
    <div className="md">
      <MentionNames.Provider value={mentionNames}>
        <Markdown remarkPlugins={markdownPlugins} components={markdownComponents}>
          {text}
        </Markdown>
      </MentionNames.Provider>
    </div>
  );
}

export function formatTime(ts: number, locale: Locale = getLocale()): string {
  return new Date(ts).toLocaleTimeString(intlLocale(locale), { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Hash routes keep the current screen on refresh/back without a router dependency. */
const readHash = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);

export function useHashRoute(): [string[], (path: string) => void] {
  const [parts, setParts] = useState(readHash);
  useEffect(() => {
    const on = () => withViewTransition(() => setParts(readHash()));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [
    parts,
    (path: string) => {
      location.hash = `#/${path}`;
    },
  ];
}

export function useMediaQuery(q: string): boolean {
  const [match, setMatch] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [q]);
  return match;
}
