// In-app notification policy: sounds, desktop notifications, taskbar badge.
// Mirrors the server's push rules (DND, mutes, mention-only by default in
// guilds) so every device behaves the same.
import { MessageFlags, RelationshipType, type MessageDTO } from "@nova/shared";
import { bus } from "./bus";
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

function level(s: DataState, m: MessageDTO): "all" | "mentions" | "none" {
  const ch = s.notif[m.channelId]?.level;
  if (ch && ch !== "default") return ch;
  if (!m.guildId) return "all";
  const g = s.notif[m.guildId]?.level;
  return g && g !== "default" ? g : "mentions";
}

function plain(m: MessageDTO, s: DataState): string {
  if (m.poll) return `📊 ${m.poll.question}`;
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

function showDesktop(m: MessageDTO, title: string, body: string) {
  if (!settings().desktopNotifications) return;
  if (isDesktop) {
    window.nova!.notify(title, body, `${m.guildId ?? "@me"}/${m.channelId}`);
    if (settings().flashTaskbar) window.nova!.flashFrame(true);
    return;
  }
  if (isAndroid || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, icon: mediaUrl(m.author.avatar, 96), tag: m.channelId, silent: true });
    n.onclick = () => {
      window.focus();
      openMessage(m);
      n.close();
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

function onMessage(m: MessageDTO) {
  const s = data();
  if (!s.me || m.author.id === s.me.id) return;
  if (m.flags & MessageFlags.SUPPRESS_NOTIFICATIONS) return;
  if (s.relationships[m.author.id]?.type === RelationshipType.BLOCKED) return;
  if (s.me.status === "dnd") return;
  const lvl = level(s, m);
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
  showDesktop(m, title, plain(m, s));
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
