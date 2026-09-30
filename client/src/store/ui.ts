// Navigation + transient UI state. Navigation mirrors location.hash so the
// back button, deep links and "copy link" all work:
//   #/channels/@me                → friends
//   #/channels/@me/<channel>      → DM / group
//   #/channels/<guild>/<channel>  → guild channel
import { create } from "zustand";
import type { MessageDTO } from "@nova/shared";
import { settings } from "./settings";

export type Modal =
  | { kind: "createGuild" }
  | { kind: "invite"; guildId: string; channelId?: string }
  | { kind: "acceptInvite"; code: string }
  | { kind: "createChannel"; guildId: string; parentId?: string | null; type?: "text" | "voice" | "category" }
  | { kind: "channelSettings"; channelId: string }
  | { kind: "guildSettings"; guildId: string; tab?: string }
  | { kind: "userSettings"; tab?: string }
  | { kind: "profile"; userId: string; guildId?: string | null }
  | { kind: "confirm"; title: string; body: string; danger?: boolean; confirmLabel?: string; onConfirm: () => unknown; typeToConfirm?: string }
  | { kind: "poll"; channelId: string }
  | { kind: "schedule"; channelId: string; content: string }
  | { kind: "newDm" }
  | { kind: "status" }
  | { kind: "ban"; guildId: string; userId: string }
  | { kind: "timeout"; guildId: string; userId: string }
  | { kind: "nick"; guildId: string; userId: string }
  | { kind: "sound"; id?: string }
  | { kind: "screenPicker"; resolve: (r: { id: string | null; audio: boolean } | null) => void };

export type SidePanel = "members" | "pins" | "search" | "thread" | "inbox" | "bookmarks" | null;

export interface Lightbox {
  items: { url: string; name?: string; type: "image" | "video"; width?: number | null; height?: number | null }[];
  index: number;
}

interface UIState {
  guildId: string; // "@me" = home
  channelId: string | null;
  modal: Modal | null;
  modalStack: Modal[];
  panel: SidePanel;
  threadId: string | null;
  searchQuery: string;
  replyTo: Record<string, MessageDTO | undefined>;
  editing: string | null;
  lightbox: Lightbox | null;
  switcher: boolean;
  /** Phones: which pane is on screen. */
  mobilePane: "nav" | "chat";
  voiceFocus: boolean;
  /** Emoji picker opened for a message from its context menu. */
  reactPicker: { m: MessageDTO; x: number; y: number } | null;
  /** "Mark unread": divider position; pauses auto-ack until the channel is re-opened. */
  markedUnread: { channelId: string; afterId: string | null } | null;
  setModal: (m: Modal | null) => void;
  pushModal: (m: Modal) => void;
  popModal: () => void;
}

export const useUI = create<UIState>((set, get) => ({
  guildId: "@me",
  channelId: null,
  modal: null,
  modalStack: [],
  panel: null,
  threadId: null,
  searchQuery: "",
  replyTo: {},
  editing: null,
  lightbox: null,
  switcher: false,
  mobilePane: "nav",
  voiceFocus: false,
  reactPicker: null,
  markedUnread: null,
  setModal: (m) => set({ modal: m, modalStack: [] }),
  pushModal: (m) => {
    const cur = get().modal;
    set({ modal: m, modalStack: cur ? [...get().modalStack, cur] : get().modalStack });
  },
  popModal: () => {
    const stack = get().modalStack;
    set({ modal: stack[stack.length - 1] ?? null, modalStack: stack.slice(0, -1) });
  },
}));

export const ui = () => useUI.getState();

export function navigate(guildId: string, channelId?: string | null, replace = false) {
  const hash = `#/channels/${guildId}${channelId ? `/${channelId}` : ""}`;
  if (location.hash === hash) {
    applyRoute();
    return;
  }
  if (replace) history.replaceState(null, "", hash);
  else location.hash = hash;
  applyRoute();
}

export function applyRoute() {
  const m = /^#\/channels\/([^/]+)(?:\/([^/?]+))?/.exec(location.hash);
  const invite = /^#\/invite\/([\w-]+)/.exec(location.hash);
  if (invite) {
    history.replaceState(null, "", "#/channels/@me");
    useUI.setState({ modal: { kind: "acceptInvite", code: invite[1] } });
    return;
  }
  const guildId = m?.[1] ?? "@me";
  const channelId = m?.[2] ?? null;
  const cur = useUI.getState();
  if (cur.guildId === guildId && cur.channelId === channelId) {
    // Tapping the open channel on a phone still has to bring the chat back.
    if (channelId && cur.mobilePane !== "chat") useUI.setState({ mobilePane: "chat" });
    return;
  }
  useUI.setState({
    guildId,
    channelId,
    threadId: null,
    panel: cur.panel === "thread" || cur.panel === "search" ? null : cur.panel,
    editing: null,
    markedUnread: null,
    mobilePane: channelId ? "chat" : "nav",
  });
  if (channelId) settings().setLocal({ lastChannels: { ...settings().lastChannels, [guildId]: channelId } });
}

export function openPanel(p: SidePanel) {
  useUI.setState({ panel: useUI.getState().panel === p ? null : p });
}

export function confirmDialog(opts: Omit<Extract<Modal, { kind: "confirm" }>, "kind">) {
  useUI.getState().pushModal({ kind: "confirm", ...opts });
}
