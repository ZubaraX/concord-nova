// Context-menu builders shared by the rail, sidebars, member list and chat.
import {
  Bell,
  BellOff,
  Check,
  Copy,
  FolderPlus,
  Hash,
  LogOut,
  MessageSquare,
  Pencil,
  Phone,
  Settings,
  ShieldBan,
  Trash2,
  UserMinus,
  UserPlus,
  UserX,
  Timer,
  Volume2,
  VolumeX,
  MicOff,
  PhoneOff,
} from "lucide-react";
import { Permission, RelationshipType } from "@nova/shared";
import { api } from "../../lib/api";
import { webLink } from "../../lib/server";
import { errorText, t } from "../../lib/i18n";
import { toast } from "../../lib/bus";
import type { MenuEntry } from "../../components/ui/overlay";
import { can, channelPerms, data, guildPerms, isMuted } from "../../store/data";
import { confirmDialog, navigate, useUI } from "../../store/ui";
import { settings } from "../../store/settings";
import { joinVoice, useVoice } from "../voice/voice";

const ui = () => useUI.getState();
const copy = (text: string) => {
  void navigator.clipboard?.writeText(text);
  toast(t("common.copied"), "success");
};
const run = (p: Promise<unknown>) => p.catch((e) => toast(errorText(e), "error"));

export function setMute(targetId: string, muted: boolean) {
  return run(api("/api/users/@me/notification-settings", { method: "PUT", body: { targetId, muted, muteUntil: null } }));
}

/**
 * Server actions. `header` is the dropdown under the server name (creation
 * first, like Discord); otherwise the right-click menu of the server icon.
 * Every entry is permission-gated, so members only see what they can do.
 */
export function guildMenu(guildId: string, opts: { header?: boolean } = {}): MenuEntry[] {
  const s = data();
  const g = s.guilds[guildId];
  if (!g) return [];
  const bits = guildPerms(s, guildId);
  const muted = isMuted(s, "", guildId);
  const owner = g.ownerId === s.me?.id;
  const manage = can(bits, Permission.MANAGE_GUILD) || can(bits, Permission.MANAGE_ROLES) || can(bits, Permission.MANAGE_CHANNELS) || can(bits, Permission.BAN_MEMBERS);
  const channels = can(bits, Permission.MANAGE_CHANNELS);
  const markRead: MenuEntry = { label: t("guild.markRead"), icon: <Check size={16} />, onSelect: () => void run(api(`/api/guilds/${guildId}/ack`, { method: "POST" })) };
  const invite: MenuEntry = can(bits, Permission.CREATE_INSTANT_INVITE) && { label: t("guild.invitePeople"), icon: <UserPlus size={16} />, onSelect: () => ui().setModal({ kind: "invite", guildId }) };
  const mute: MenuEntry = { label: muted ? t("channel.unmute") : t("channel.mute"), icon: muted ? <Bell size={16} /> : <BellOff size={16} />, onSelect: () => void setMute(guildId, !muted) };
  const settingsItem: MenuEntry = manage && { label: t("guild.settings"), icon: <Settings size={16} />, onSelect: () => ui().setModal({ kind: "guildSettings", guildId }) };
  const createChannel: MenuEntry = channels && { label: t("guild.createChannel"), icon: <Hash size={16} />, onSelect: () => ui().setModal({ kind: "createChannel", guildId }) };
  const createCategory: MenuEntry = channels && { label: t("guild.createCategory"), icon: <FolderPlus size={16} />, onSelect: () => ui().setModal({ kind: "createChannel", guildId, type: "category" }) };
  const copyId: MenuEntry = settings().developerMode && { label: t("chat.menu.copyId"), icon: <Copy size={16} />, onSelect: () => copy(guildId) };
  const head: MenuEntry[] = opts.header
    ? [invite, settingsItem, createChannel, createCategory, { separator: true }, mute, markRead, copyId]
    : [markRead, { separator: true }, invite, mute, settingsItem, createChannel, copyId];
  return [
    ...head,
    !owner && { separator: true },
    !owner && {
      label: t("guild.leave"),
      icon: <LogOut size={16} />,
      danger: true,
      onSelect: () =>
        confirmDialog({
          title: t("guild.leave"),
          body: t("guild.leaveConfirm", { name: g.name }),
          danger: true,
          confirmLabel: t("common.leave"),
          onConfirm: async () => {
            await api(`/api/users/@me/guilds/${guildId}`, { method: "DELETE" });
            if (ui().guildId === guildId) navigate("@me");
          },
        }),
    },
  ];
}

export function channelMenu(channelId: string): MenuEntry[] {
  const s = data();
  const c = s.channels[channelId];
  if (!c) return [];
  const bits = channelPerms(s, channelId);
  const muted = isMuted(s, channelId, c.guildId);
  const manage = can(bits, Permission.MANAGE_CHANNELS);
  const link = webLink(`/#/channels/${c.guildId ?? "@me"}/${channelId}`);
  return [
    c.type !== "voice" && c.type !== "category" && { label: t("guild.markRead"), icon: <Check size={16} />, onSelect: () => void run(api(`/api/channels/${channelId}/ack`, { method: "POST", body: {} })) },
    c.type === "voice" && { label: t("voice.joinChannel"), icon: <Volume2 size={16} />, onSelect: () => void joinVoice(channelId) },
    { label: muted ? t("channel.unmute") : t("channel.mute"), icon: muted ? <Bell size={16} /> : <BellOff size={16} />, onSelect: () => void setMute(channelId, !muted) },
    c.guildId && can(bits, Permission.CREATE_INSTANT_INVITE) && c.type !== "category" && { label: t("common.invite"), icon: <UserPlus size={16} />, onSelect: () => ui().setModal({ kind: "invite", guildId: c.guildId!, channelId }) },
    { label: t("channel.copyLink"), icon: <Copy size={16} />, onSelect: () => copy(link) },
    manage && { separator: true },
    manage && { label: t("channel.edit"), icon: <Pencil size={16} />, onSelect: () => ui().setModal({ kind: "channelSettings", channelId }) },
    manage &&
      c.guildId && {
        label: t("channel.delete"),
        icon: <Trash2 size={16} />,
        danger: true,
        onSelect: () =>
          confirmDialog({
            title: t("channel.delete"),
            body: t("channel.deleteConfirm", { name: c.name }),
            danger: true,
            confirmLabel: t("common.delete"),
            onConfirm: () => api(`/api/channels/${channelId}`, { method: "DELETE" }),
          }),
      },
    settings().developerMode && { label: t("chat.menu.copyId"), icon: <Copy size={16} />, onSelect: () => copy(channelId) },
  ];
}

export async function openDmWith(userId: string) {
  const c = await api<{ id: string }>("/api/users/@me/channels", { method: "POST", body: { recipientId: userId } });
  navigate("@me", c.id);
  return c.id;
}

export async function callUser(userId: string) {
  const id = await openDmWith(userId);
  await joinVoice(id);
}

/** Mute someone for yourself only (their mic and their stream audio). */
export function toggleLocalMute(userId: string) {
  const s = settings();
  s.setLocal({ localMutes: { ...s.localMutes, [userId]: !s.localMutes[userId] } });
}

export function userMenu(userId: string, guildId?: string | null): MenuEntry[] {
  const s = data();
  const me = s.me?.id;
  const self = userId === me;
  const rel = s.relationships[userId]?.type;
  const bits = guildId ? guildPerms(s, guildId) : 0n;
  const g = guildId ? s.guilds[guildId] : undefined;
  const vs = s.voiceStates[userId];
  const inMyGuildVoice = !!guildId && vs?.guildId === guildId;
  const local = settings();
  const localMuted = !!local.localMutes[userId];
  const inCallWithMe = !!vs && vs.channelId === useVoice.getState().channelId;
  const username = s.users[userId]?.username ?? "";
  return [
    { label: t("profile.viewFull"), icon: <MessageSquare size={16} />, onSelect: () => ui().setModal({ kind: "profile", userId, guildId }) },
    !self && { label: t("friends.message"), icon: <MessageSquare size={16} />, onSelect: () => void run(openDmWith(userId)) },
    !self && { label: t("friends.call"), icon: <Phone size={16} />, onSelect: () => void run(callUser(userId)) },
    guildId &&
      (can(bits, Permission.MANAGE_NICKNAMES) || (self && can(bits, Permission.CHANGE_NICKNAME))) && {
        label: t("profile.changeNick"),
        icon: <Pencil size={16} />,
        onSelect: () => ui().setModal({ kind: "nick", guildId, userId }),
      },
    !self && inCallWithMe && { separator: true },
    !self && inCallWithMe && { label: localMuted ? t("voice.localUnmute") : t("voice.localMute"), icon: localMuted ? <Volume2 size={16} /> : <VolumeX size={16} />, onSelect: () => toggleLocalMute(userId) },
    { separator: true },
    !self && rel === RelationshipType.FRIEND && {
      label: t("friends.remove"),
      icon: <UserMinus size={16} />,
      onSelect: () =>
        confirmDialog({ title: t("friends.remove"), body: t("friends.removeConfirm", { name: s.users[userId]?.displayName || username }), danger: true, onConfirm: () => api(`/api/users/@me/relationships/${userId}`, { method: "DELETE" }) }),
    },
    !self && (rel === undefined || rel === RelationshipType.INCOMING) && { label: rel === RelationshipType.INCOMING ? t("friends.accept") : t("friends.add"), icon: <UserPlus size={16} />, onSelect: () => void run(api(`/api/users/@me/relationships/${userId}`, { method: "PUT", body: {} })) },
    !self && rel !== RelationshipType.BLOCKED && { label: t("friends.block"), icon: <UserX size={16} />, danger: true, onSelect: () => void run(api(`/api/users/@me/relationships/${userId}`, { method: "PUT", body: { type: 2 } })) },
    !self && rel === RelationshipType.BLOCKED && { label: t("friends.unblock"), icon: <UserX size={16} />, onSelect: () => void run(api(`/api/users/@me/relationships/${userId}`, { method: "DELETE" })) },
    guildId && inMyGuildVoice && can(bits, Permission.MUTE_MEMBERS) && { separator: true },
    guildId && inMyGuildVoice && can(bits, Permission.MUTE_MEMBERS) && {
      label: vs!.serverMute ? t("voice.serverUnmute") : t("voice.serverMute"),
      icon: <MicOff size={16} />,
      onSelect: () => void run(api(`/api/guilds/${guildId}/voice/${userId}`, { method: "PATCH", body: { mute: !vs!.serverMute } })),
    },
    guildId && inMyGuildVoice && can(bits, Permission.DEAFEN_MEMBERS) && {
      label: vs!.serverDeaf ? t("voice.serverUndeafen") : t("voice.serverDeafen"),
      icon: <VolumeX size={16} />,
      onSelect: () => void run(api(`/api/guilds/${guildId}/voice/${userId}`, { method: "PATCH", body: { deaf: !vs!.serverDeaf } })),
    },
    guildId && inMyGuildVoice && can(bits, Permission.MOVE_MEMBERS) && { label: t("voice.disconnectUser"), icon: <PhoneOff size={16} />, danger: true, onSelect: () => void run(api(`/api/guilds/${guildId}/voice/${userId}`, { method: "PATCH", body: { channelId: null } })) },
    guildId && !self && g && g.ownerId !== userId && (can(bits, Permission.MODERATE_MEMBERS) || can(bits, Permission.KICK_MEMBERS) || can(bits, Permission.BAN_MEMBERS)) && { separator: true },
    guildId && !self && can(bits, Permission.MODERATE_MEMBERS) && g?.ownerId !== userId && { label: t("profile.timeout"), icon: <Timer size={16} />, danger: true, onSelect: () => ui().setModal({ kind: "timeout", guildId, userId }) },
    guildId &&
      !self &&
      can(bits, Permission.KICK_MEMBERS) &&
      g?.ownerId !== userId && {
        label: t("profile.kick"),
        icon: <UserMinus size={16} />,
        danger: true,
        onSelect: () =>
          confirmDialog({ title: t("profile.kick"), body: t("profile.kickConfirm", { name: s.users[userId]?.displayName || username }), danger: true, confirmLabel: t("profile.kick"), onConfirm: () => api(`/api/guilds/${guildId}/members/${userId}`, { method: "DELETE" }) }),
      },
    guildId && !self && can(bits, Permission.BAN_MEMBERS) && g?.ownerId !== userId && { label: t("profile.ban"), icon: <ShieldBan size={16} />, danger: true, onSelect: () => ui().setModal({ kind: "ban", guildId, userId }) },
    local.developerMode && { label: t("chat.menu.copyId"), icon: <Copy size={16} />, onSelect: () => copy(userId) },
  ];
}
