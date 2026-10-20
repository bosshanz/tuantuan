import { Plus } from "lucide-react";
import { useMemo } from "react";
import type { Agent, Room } from "./api";
import { useI18n } from "./i18n";
import { MessageSearch, type MessageSearchProps, type MessageSearchQuickItem } from "./MessageSearch";
import { AgentAvatar, RoomIcon } from "./ui";

export function CommandPalette(
  props: {
    agents: Agent[];
    rooms: Room[];
    onGo: (path: string) => void;
  } & Omit<MessageSearchProps, "quickItems" | "onGo">,
) {
  const { t } = useI18n();
  const items = useMemo<MessageSearchQuickItem[]>(
    () => [
      ...props.rooms.map((room) => ({
        key: `r${room.id}`,
        label: room.name,
        hint: t("会话"),
        icon: <RoomIcon room={room} agents={props.agents} size={24} />,
        path: `c/${room.id}`,
      })),
      ...props.agents.map((agent) => ({
        key: `a${agent.id}`,
        label: agent.name,
        hint: "Agent",
        icon: <AgentAvatar agent={agent} size={24} />,
        path: `a/${agent.id}`,
      })),
      { key: "new-agent", label: t("新建 Agent"), hint: t("操作"), icon: <Plus size={16} />, path: "a/new" },
      { key: "new-room", label: t("新建会话"), hint: t("操作"), icon: <Plus size={16} />, path: "c/new" },
    ],
    [props.agents, props.rooms, t],
  );
  return <MessageSearch {...props} quickItems={items} />;
}
