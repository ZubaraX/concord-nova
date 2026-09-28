// Per-channel message logs with windowed pagination, optimistic sending and
// gap-filling after reconnects. Pending messages use ids "~<nonce>", which
// sort after every real ULID, so they naturally sit at the bottom.
import { create } from "zustand";
import { compareIds, ulid, type MessageCreateInput, type MessageDTO, type PollDTO, type AttachmentDTO } from "@nova/shared";
import { api, ApiError } from "../lib/api";
import { useData } from "./data";

export interface ChannelLog {
  list: MessageDTO[];
  hasBefore: boolean;
  hasAfter: boolean;
  loading: false | "initial" | "before" | "after";
  error: string | null;
  lastAccess: number;
}

export interface PendingInfo {
  channelId: string;
  input: MessageCreateInput;
  state: "sending" | "failed";
  error?: string;
  tries: number;
}

interface MessagesState {
  logs: Record<string, ChannelLog>;
  pending: Record<string, PendingInfo>;
  /** channelId → message to highlight/scroll to */
  jump: Record<string, string | null>;
}

const PAGE = 50;
const MAX_LOGS = 40;
export const PENDING_PREFIX = "~";

export const useMessages = create<MessagesState>(() => ({ logs: {}, pending: {}, jump: {} }));
const S = () => useMessages.getState();

function setLog(channelId: string, fn: (l: ChannelLog) => ChannelLog) {
  const logs = S().logs;
  const cur = logs[channelId] ?? { list: [], hasBefore: true, hasAfter: false, loading: false, error: null, lastAccess: Date.now() };
  useMessages.setState({ logs: { ...logs, [channelId]: fn(cur) } });
}

function evict() {
  const logs = S().logs;
  const ids = Object.keys(logs);
  if (ids.length <= MAX_LOGS) return;
  const drop = ids.sort((a, b) => logs[a].lastAccess - logs[b].lastAccess).slice(0, ids.length - MAX_LOGS);
  const next = { ...logs };
  for (const id of drop) delete next[id];
  useMessages.setState({ logs: next });
}

/** Merge messages into a sorted list (dedupe by id; replace pending by nonce). */
function merge(list: MessageDTO[], incoming: MessageDTO[]): MessageDTO[] {
  if (!incoming.length) return list;
  const map = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) {
    if (m.nonce) map.delete(PENDING_PREFIX + m.nonce);
    map.set(m.id, m);
  }
  return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const realLast = (list: MessageDTO[]) => {
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].id.startsWith(PENDING_PREFIX)) return list[i].id;
  return null;
};

export function touch(channelId: string) {
  const l = S().logs[channelId];
  if (l) setLog(channelId, (x) => ({ ...x, lastAccess: Date.now() }));
}

export async function loadInitial(channelId: string, around?: string | null) {
  const cur = S().logs[channelId];
  if (cur?.loading === "initial") return;
  if (cur && !around && cur.list.length && !cur.error) {
    touch(channelId);
    return;
  }
  setLog(channelId, (l) => ({ ...l, loading: "initial", error: null, lastAccess: Date.now() }));
  try {
    const list = await api<MessageDTO[]>(`/api/channels/${channelId}/messages`, { query: { limit: PAGE, around: around ?? undefined } });
    // Anything that arrived while the request was in flight (live events, my
    // own just-sent or still-pending messages) is newer than this page — keep it.
    const lastFetched = list[list.length - 1]?.id ?? "";
    const newer = around ? [] : (S().logs[channelId]?.list ?? []).filter((m) => m.id.startsWith(PENDING_PREFIX) || m.id > lastFetched);
    setLog(channelId, (l) => ({
      ...l,
      list: merge(list, newer),
      hasBefore: around ? true : list.length >= PAGE,
      hasAfter: around ? list.length > 0 && compareIds(list[list.length - 1].id, useData.getState().channels[channelId]?.lastMessageId) < 0 : false,
      loading: false,
      error: null,
    }));
    if (around) useMessages.setState({ jump: { ...S().jump, [channelId]: around } });
    evict();
  } catch (e) {
    setLog(channelId, (l) => ({ ...l, loading: false, error: (e as ApiError).code ?? "error" }));
  }
}

export async function loadBefore(channelId: string) {
  const l = S().logs[channelId];
  if (!l || l.loading || !l.hasBefore) return;
  const first = l.list.find((m) => !m.id.startsWith(PENDING_PREFIX));
  if (!first) return;
  setLog(channelId, (x) => ({ ...x, loading: "before" }));
  try {
    const older = await api<MessageDTO[]>(`/api/channels/${channelId}/messages`, { query: { before: first.id, limit: PAGE } });
    setLog(channelId, (x) => ({ ...x, list: merge(x.list, older), hasBefore: older.length >= PAGE, loading: false }));
  } catch {
    setLog(channelId, (x) => ({ ...x, loading: false }));
  }
}

export async function loadAfter(channelId: string) {
  const l = S().logs[channelId];
  if (!l || l.loading || !l.hasAfter) return;
  const last = realLast(l.list);
  if (!last) return;
  setLog(channelId, (x) => ({ ...x, loading: "after" }));
  try {
    const newer = await api<MessageDTO[]>(`/api/channels/${channelId}/messages`, { query: { after: last, limit: PAGE } });
    setLog(channelId, (x) => ({ ...x, list: merge(x.list, newer), hasAfter: newer.length >= PAGE, loading: false }));
  } catch {
    setLog(channelId, (x) => ({ ...x, loading: false }));
  }
}

/** Show a specific message: reuse the loaded window or load around it. */
export async function jumpTo(channelId: string, messageId: string) {
  const l = S().logs[channelId];
  if (l?.list.some((m) => m.id === messageId)) {
    useMessages.setState({ jump: { ...S().jump, [channelId]: messageId } });
    return;
  }
  await loadInitial(channelId, messageId);
}

export function clearJump(channelId: string) {
  if (S().jump[channelId]) useMessages.setState({ jump: { ...S().jump, [channelId]: null } });
}

/** Return to the newest messages (drop a mid-history window). */
export async function jumpToPresent(channelId: string) {
  const l = S().logs[channelId];
  if (l?.hasAfter) {
    useMessages.setState({ logs: { ...S().logs, [channelId]: { ...l, list: [], hasAfter: false } } });
    await loadInitial(channelId);
  }
}

/** After a reconnect: fetch what was missed for every loaded channel. */
export async function resyncAll() {
  const logs = S().logs;
  await Promise.all(
    Object.entries(logs).map(async ([channelId, l]) => {
      if (l.hasAfter || !l.list.length) return;
      const last = realLast(l.list);
      if (!last) return;
      try {
        const newer = await api<MessageDTO[]>(`/api/channels/${channelId}/messages`, { query: { after: last, limit: 100 } });
        if (newer.length >= 100) {
          // Too much missed — drop the log; it reloads fresh when viewed.
          const next = { ...S().logs };
          delete next[channelId];
          useMessages.setState({ logs: next });
        } else setLog(channelId, (x) => ({ ...x, list: merge(x.list, newer) }));
      } catch (e) {
        if ((e as ApiError).status === 404) {
          const next = { ...S().logs };
          delete next[channelId];
          useMessages.setState({ logs: next });
        }
      }
    })
  );
  // Retry anything that failed while offline.
  for (const [nonce, p] of Object.entries(S().pending)) if (p.state === "failed" && p.tries < 3) void retrySend(nonce);
}

// ── realtime ─────────────────────────────────────────────────────────────────
export function onCreate(m: MessageDTO) {
  const l = S().logs[m.channelId];
  if (!l) return;
  if (m.nonce && S().pending[m.nonce]) {
    const p = { ...S().pending };
    delete p[m.nonce];
    useMessages.setState({ pending: p });
  }
  if (l.hasAfter) return; // viewing old history; the new message shows on "jump to present"
  setLog(m.channelId, (x) => ({ ...x, list: merge(x.list, [m]) }));
}

export function onUpdate(m: MessageDTO) {
  const l = S().logs[m.channelId];
  if (!l || !l.list.some((x) => x.id === m.id)) return;
  setLog(m.channelId, (x) => ({ ...x, list: x.list.map((y) => (y.id === m.id ? m : y)) }));
}

export function onDelete(channelId: string, ids: string[]) {
  const l = S().logs[channelId];
  if (!l) return;
  const set = new Set(ids);
  setLog(channelId, (x) => ({
    ...x,
    list: x.list
      .filter((y) => !set.has(y.id))
      .map((y) => (y.replyTo && set.has(y.replyTo.id) ? { ...y, replyTo: { ...y.replyTo, deleted: true, author: null, content: "" } } : y)),
  }));
}

function mapMessage(channelId: string, id: string, fn: (m: MessageDTO) => MessageDTO) {
  const l = S().logs[channelId];
  if (!l) return;
  const i = l.list.findIndex((m) => m.id === id);
  if (i < 0) return;
  const list = l.list.slice();
  list[i] = fn(list[i]);
  setLog(channelId, (x) => ({ ...x, list }));
}

export function onReaction(channelId: string, messageId: string, emoji: string, userId: string, added: boolean) {
  mapMessage(channelId, messageId, (m) => {
    const reactions = m.reactions.map((r) => ({ ...r, users: [...r.users] }));
    let r = reactions.find((x) => x.emoji === emoji);
    if (added) {
      if (r?.users.includes(userId)) return m;
      if (!r) reactions.push((r = { emoji, count: 0, users: [] }));
      r.count++;
      r.users.push(userId);
    } else {
      if (!r || !r.users.includes(userId)) return m;
      r.count--;
      r.users = r.users.filter((u) => u !== userId);
    }
    return { ...m, reactions: reactions.filter((x) => x.count > 0) };
  });
}

export function onReactionEmojiRemoved(channelId: string, messageId: string, emoji: string) {
  mapMessage(channelId, messageId, (m) => ({ ...m, reactions: m.reactions.filter((r) => r.emoji !== emoji) }));
}

export function onPoll(channelId: string, messageId: string, poll: PollDTO) {
  mapMessage(channelId, messageId, (m) => ({ ...m, poll }));
}

// ── sending ──────────────────────────────────────────────────────────────────
export function optimisticMessage(channelId: string, nonce: string, input: MessageCreateInput, attachments: AttachmentDTO[] = []): MessageDTO {
  const d = useData.getState();
  const me = d.me!;
  const reply = input.replyTo ? S().logs[channelId]?.list.find((m) => m.id === input.replyTo) : undefined;
  return {
    id: PENDING_PREFIX + nonce,
    channelId,
    guildId: d.channels[channelId]?.guildId ?? null,
    author: { id: me.id, username: me.username, displayName: me.displayName, avatar: me.avatar, accentColor: me.accentColor, flags: me.flags },
    type: input.replyTo ? 19 : 0,
    content: input.content ?? "",
    createdAt: new Date().toISOString(),
    editedAt: null,
    pinned: false,
    flags: 0,
    mentions: [],
    mentionRoles: [],
    mentionEveryone: false,
    attachments,
    embeds: [],
    reactions: [],
    replyTo: reply ? { id: reply.id, channelId, author: reply.author, content: reply.content, attachments: reply.attachments.length, deleted: false } : null,
    nonce,
    poll: null,
    thread: null,
    meta: null,
  };
}

async function doSend(nonce: string) {
  const p = S().pending[nonce];
  if (!p) return;
  try {
    const msg = await api<MessageDTO>(`/api/channels/${p.channelId}/messages`, { method: "POST", body: { ...p.input, nonce } });
    onCreate(msg);
    const l = S().logs[p.channelId];
    if (l && !l.list.some((m) => m.id === msg.id)) setLog(p.channelId, (x) => ({ ...x, list: merge(x.list, [msg]) }));
  } catch (e) {
    const err = e as ApiError;
    // Rate limits and network blips are retried automatically.
    if ((err.status === 429 || err.isNetwork) && p.tries < 3) {
      useMessages.setState({ pending: { ...S().pending, [nonce]: { ...p, tries: p.tries + 1 } } });
      if (!err.isNetwork) setTimeout(() => void doSend(nonce), Math.max(1, err.retryAfter ?? 2) * 1000);
      else useMessages.setState({ pending: { ...S().pending, [nonce]: { ...p, state: "failed", error: err.code, tries: p.tries + 1 } } });
      return;
    }
    useMessages.setState({ pending: { ...S().pending, [nonce]: { ...p, state: "failed", error: err.code } } });
  }
}

export function sendMessage(channelId: string, input: MessageCreateInput, attachments: AttachmentDTO[] = []): string {
  const nonce = ulid();
  const optimistic = optimisticMessage(channelId, nonce, input, attachments);
  useMessages.setState({ pending: { ...S().pending, [nonce]: { channelId, input, state: "sending", tries: 0 } } });
  setLog(channelId, (l) => ({ ...l, list: l.hasAfter ? l.list : merge(l.list, [optimistic]), lastAccess: Date.now() }));
  void doSend(nonce);
  return nonce;
}

export async function retrySend(nonce: string) {
  const p = S().pending[nonce];
  if (!p) return;
  useMessages.setState({ pending: { ...S().pending, [nonce]: { ...p, state: "sending" } } });
  await doSend(nonce);
}

export function discardPending(nonce: string) {
  const p = S().pending[nonce];
  if (!p) return;
  const pend = { ...S().pending };
  delete pend[nonce];
  useMessages.setState({ pending: pend });
  onDelete(p.channelId, [PENDING_PREFIX + nonce]);
}

export function lastOwnMessage(channelId: string, userId: string): MessageDTO | undefined {
  const l = S().logs[channelId];
  if (!l) return;
  for (let i = l.list.length - 1; i >= 0; i--) {
    const m = l.list[i];
    if (m.author.id === userId && !m.id.startsWith(PENDING_PREFIX) && (m.type === 0 || m.type === 19)) return m;
  }
}

export function resetMessages() {
  useMessages.setState({ logs: {}, pending: {}, jump: {} }, true);
}
