import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import { Bot, Hash, User } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Agent, Room } from "./api";

for (const [name, lang] of Object.entries({ bash, go, javascript, json, python, sql, typescript }))
  hljs.registerLanguage(name, lang);
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["js", "jsx"], { languageName: "javascript" });
hljs.registerAliases(["sh", "shell"], { languageName: "bash" });
hljs.registerAliases(["py"], { languageName: "python" });

export function AgentAvatar({
  agent,
  size = 32,
  name,
}: {
  agent?: Pick<Agent, "avatar" | "color" | "name">;
  size?: number;
  name?: string;
}) {
  if (!agent) {
    return (
      <span className="avatar human" style={{ ["--size" as string]: `${size}px` }} aria-hidden>
        {(name ?? "?").slice(0, 1)}
      </span>
    );
  }
  return (
    <span className="avatar" style={{ background: agent.color, ["--size" as string]: `${size}px` }} aria-hidden>
      {agent.avatar}
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

export function RoomIcon({ room, agents }: { room: Room; agents: Agent[] }) {
  const members = room.agentIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
  if (room.deviceId)
    return (
      <span className="room-icon" aria-hidden>
        <Bot size={17} />
      </span>
    );
  if (room.kind === "dm" && members[0]) return <AgentAvatar agent={members[0]} />;
  return (
    <span className="room-icon" aria-hidden>
      <Hash size={16} />
    </span>
  );
}

export function roomSubtitle(room: Room, agents: Agent[]): string {
  const names = room.agentIds.map((id) => agents.find((a) => a.id === id)?.name).filter(Boolean);
  if (room.deviceId) return names[0] ? `语音对话 · 设备 ${room.deviceId}` : "Agent 已删除";
  if (room.kind === "dm") return names[0] ? "私聊" : "Agent 已删除";
  return names.length ? `${names.length} 个 Agent · ${names.join("、")}` : "还没有 Agent 成员";
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

/** Markdown without raw HTML (react-markdown escapes it), code highlighted, @mentions as chips. */
export function MessageMarkdown({ text, mentionNames }: { text: string; mentionNames: string[] }) {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{withMentions(children, mentionNames)}</p>,
          li: ({ children }) => <li>{withMentions(children, mentionNames)}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
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
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Hash routes keep the current screen on refresh/back without a router dependency. */
const readHash = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);

export function useHashRoute(): [string[], (path: string) => void] {
  const [parts, setParts] = useState(readHash);
  useEffect(() => {
    const on = () => setParts(readHash());
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
