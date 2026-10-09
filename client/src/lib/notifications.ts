// In-app notification policy: sounds, desktop notifications, taskbar badge.
// Mirrors the server's push rules (DND, mutes, levels — every message by
// default, in servers too) so every device behaves the same.
import { MessageFlags, RelationshipType, isGifLink, type MessageDTO } from "@nova/shared";
import { bus, toast } from "./bus";
import { playSound } from "./sound";
import { isAndroid, isDesktop } from "./platform";
import { mediaUrl } from "./server";
import { t } from "./i18n";
import { channelTitle, data, dmBadgeCount, displayName, isMuted, useData, type DataState } from "../store/data";
import { navigate, ui } from "../store/ui";
import { settings } from "../store/settings";

function mentionsMe(s: DataState, m: MessageDTO): boolean {
  const me = s.me?.id;
  if (!me) return false;
  if (m.mentions.includes(me)) return true;
  if (m.mentionEveryone && !(m.guildId && s.notif[m.guildId]?.suppressEveryone)) return true;
  if (m.guildId && m.mentionRoles.length) {
    const mine = s.members[m.guildId]?.[me]?.roles ?? [];
    return m.mentionRoles.some((r) => mine.includes(r));
  }
  return false;
}

/** What reaches me from a channel: its own setting, else its server's, else everything (until 1.7.5 servers defaulted to mentions only). */
export function notifyLevel(s: DataState, channelId: string, guildId: string | null): "all" | "mentions" | "none" {
  const ch = s.notif[channelId]?.level;
  if (ch && ch !== "default") return ch;
  if (!guildId) return "all";
  const g = s.notif[guildId]?.level;
  return g && g !== "default" ? g : "all";
}

function plain(m: MessageDTO, s: DataState): string {
  if (m.poll) return `📊 ${m.poll.question}`;
  if (isGifLink(m.content)) return "GIF";
  const text = m.content
    .replace(/<@!?([0-9A-Z]{26})>/g, (_, id) => "@" + displayName(s, id, m.guildId))
    .replace(/<@&([0-9A-Z]{26})>/g, (_, id) => "@" + (m.guildId ? s.roles[m.guildId]?.[id]?.name ?? "role" : "role"))
    .replace(/<#([0-9A-Z]{26})>/g, (_, id) => "#" + (s.channels[id]?.name ?? "channel"))
    .replace(/<a?:(\w+):[0-9A-Z]{26}>/g, ":$1:")
    .replace(/[*_~`|>]/g, "")
    .slice(0, 180);
  if (text.trim()) return text;
  if (m.attachments.some((a) => a.duration)) return "🎤 " + t("chat.voiceMessage");
  if (m.attachments.length) return `📎 ${m.attachments[0].filename}`;
  return "";
}

let notifPermissionAsked = false;
export async function ensureNotificationPermission() {
  if (isDesktop || typeof Notification === "undefined") return true;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied" || notifPermissionAsked) return false;
  notifPermissionAsked = true;
  return (await Notification.requestPermission()) === "granted";
}

function openMessage(m: MessageDTO) {
  navigate(m.guildId ?? "@me", m.channelId);
}

/** A notification outside the window (desktop app or browser); a click opens `guildId/channelId`. */
function showDesktop(where: { guildId: string | null; channelId: string }, title: string, body: string, avatar?: string | null, onOpen?: () => void) {
  if (!settings().desktopNotifications) return;
  const open = onOpen ?? (() => navigate(where.guildId ?? "@me", where.channelId));
  if (isDesktop) {
    window.nova!.notify(title, body, `${where.guildId ?? "@me"}/${where.channelId}`);
    if (settings().flashTaskbar) window.nova!.flashFrame(true);
    return;
  }
  if (isAndroid || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, icon: mediaUrl(avatar, 96), tag: where.channelId, silent: true });
    n.onclick = () => {
      window.focus();
      open();
      n.close();
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

const focused = () => document.visibilityState === "visible" && document.hasFocus();

/** An incoming private call while the window is in the background: who calls, and where. */
export function notifyIncomingCall(channelId: string, callerId: string) {
  const s = data();
  if (focused() || s.me?.status === "dnd") return;
  const channel = s.channels[channelId];
  const caller = displayName(s, callerId, null);
  const group = channel?.type === "group_dm";
  showDesktop({ guildId: null, channelId }, t("call.notifyTitle", { name: caller }), group ? t("call.notifyGroup", { name: channelTitle(s, channel) }) : t("call.notifyBody"), s.users[callerId]?.avatar);
}

// Someone opened a call in a server's voice channel (it was empty): the members
// who hear of every message there hear of this too — a sound, and a toast
// with "Join", or a notification outside the window. Once per channel a minute.
const inVoice = new Map<string, string>();
const announced = new Map<string, number>();

function onVoiceState(userId: string, channelId: string | null, guildId: string | null) {
  const was = inVoice.get(userId);
  if (channelId) inVoice.set(userId, channelId);
  else inVoice.delete(userId);
  if (!channelId || !guildId || was === channelId) return;
  for (const [u, c] of inVoice) if (u !== userId && c === channelId) return; // someone was already there
  const s = data();
  const me = s.me;
  if (!me || userId === me.id || me.status === "dnd" || inVoice.get(me.id) === channelId) return;
  if (s.relationships[userId]?.type === RelationshipType.BLOCKED) return;
  if (notifyLevel(s, channelId, guildId) !== "all" || isMuted(s, channelId, guildId)) return;
  if (Date.now() - (announced.get(channelId) ?? 0) < 60_000) return;
  announced.set(channelId, Date.now());
  const name = displayName(s, userId, guildId);
  const where = `${s.channels[channelId]?.name ?? ""} · ${s.guilds[guildId]?.name ?? ""}`;
  const join = () => {
    navigate(guildId, channelId);
    void import("../features/voice/voice").then((m) => m.joinVoice(channelId));
  };
  playSound("join");
  if (focused()) toast(t("voice.callStarted", { name, where }), "info", { label: t("voice.joinCall"), run: join });
  else showDesktop({ guildId, channelId }, name, t("voice.callStarted", { name, where }), s.users[userId]?.avatar);
}

function onMessage(m: MessageDTO) {
  const s = data();
  if (!s.me || m.author.id === s.me.id) return;
  if (m.flags & MessageFlags.SUPPRESS_NOTIFICATIONS) return;
  if (s.relationships[m.author.id]?.type === RelationshipType.BLOCKED) return;
  if (s.me.status === "dnd") return;
  const lvl = notifyLevel(s, m.channelId, m.guildId);
  if (lvl === "none") return;
  const mention = mentionsMe(s, m);
  const muted = isMuted(s, m.channelId, m.guildId);
  if (muted && !(mention && m.guildId)) return;
  if (lvl === "mentions" && !mention) return;

  const viewing = ui().channelId === m.channelId && document.visibilityState === "visible" && document.hasFocus();
  if (viewing) return;
  playSound(mention && m.guildId ? "mention" : "message");
  if (isAndroid) navigator.vibrate?.(mention ? [80, 60, 80] : 60);
  if (document.visibilityState === "visible" && document.hasFocus()) return;

  const channel = s.channels[m.channelId];
  const author = displayName(s, m.author.id, m.guildId);
  const title = m.guildId ? `${author} (#${channel?.name ?? ""}, ${s.guilds[m.guildId]?.name ?? ""})` : channel?.type === "group_dm" ? `${author} · ${channelTitle(s, channel)}` : author;
  showDesktop(m, title, plain(m, s), m.author.avatar, () => openMessage(m));
}

// ── badge + title ────────────────────────────────────────────────────────────
function badgeCount(s: DataState): number {
  let n = dmBadgeCount(s);
  for (const c of Object.values(s.channels)) if (c.guildId && !isMuted(s, c.id, c.guildId)) n += s.readStates[c.id]?.mentionCount ?? 0;
  n += Object.values(s.relationships).filter((r) => r.type === RelationshipType.INCOMING).length;
  return n;
}

function drawBadge(count: number): string | null {
  if (!count) return null;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ff5c7a";
  g.beginPath();
  g.arc(16, 16, 16, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fff";
  g.font = `bold ${count > 9 ? 16 : 20}px sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(count > 99 ? "99+" : String(count), 16, 17);
  return c.toDataURL();
}

let lastBadge = -1;
function updateBadge() {
  const s = useData.getState();
  if (!s.ready) return;
  const n = settings().unreadBadge ? badgeCount(s) : 0;
  if (n === lastBadge) return;
  lastBadge = n;
  document.title = n ? `(${n}) Concord Nova` : "Concord Nova";
  if (isDesktop) window.nova!.setBadge(n, drawBadge(n));
}

export function initNotifications() {
  bus.on("dispatch", (e) => {
    if (e.t === "MESSAGE_CREATE") onMessage(e.d);
    if (e.t === "RELATIONSHIP_ADD" && e.d.type === RelationshipType.INCOMING) playSound("friend");
    if (e.t === "VOICE_STATE_UPDATE") onVoiceState(e.d.userId, e.d.channelId, e.d.guildId ?? null);
    if (e.t === "READY") {
      inVoice.clear();
      for (const v of e.d.voiceStates) if (v.channelId) inVoice.set(v.userId, v.channelId);
    }
  });
  useData.subscribe((s, prev) => {
    if (s.readStates !== prev.readStates || s.relationships !== prev.relationships || s.notif !== prev.notif || s.ready !== prev.ready) updateBadge();
  });
  window.addEventListener("focus", () => {
    if (isDesktop) window.nova!.flashFrame(false);
  });
  if (isDesktop) window.nova!.onNotificationClick((tag) => {
    const [g, c] = tag.split("/");
    navigate(g, c);
  });
}
