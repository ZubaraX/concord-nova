// Background jobs — plain intervals (single process, no queue infra needed).
// Each tick is guarded so a slow run can't overlap the next one.
import { MessageType } from "@nova/shared";
import { prisma, jsonParse } from "./db";
import { deleteStored } from "./lib/files";
import { presence } from "./state/presence";
import { voice } from "./state/voice";
import { broadcastPresence } from "./services/audience";
import { broadcastPoll, createMessage } from "./services/messages";

type Log = { error: (o: unknown, m?: string) => void; info: (m: string) => void };

function every(ms: number, fn: () => Promise<void>, log: Log, name: string) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      log.error({ err }, `job ${name} failed`);
    } finally {
      running = false;
    }
  };
  const t = setInterval(tick, ms);
  t.unref?.();
  setTimeout(tick, Math.min(ms, 3000)).unref?.();
  return t;
}

async function sendScheduled() {
  const due = await prisma.scheduledMessage.findMany({ where: { sendAt: { lte: new Date() } }, take: 50 });
  for (const row of due) {
    // Delete first: a crash mid-send must not re-send it on the next tick.
    const del = await prisma.scheduledMessage.deleteMany({ where: { id: row.id } });
    if (!del.count) continue;
    try {
      await createMessage(row.authorId, row.channelId, { content: row.content, attachments: jsonParse<string[]>(row.attachments, []), nonce: `sched-${row.id}` });
    } catch {
      /* lost access / channel gone — nothing sensible to retry */
    }
  }
}

async function finalizePolls() {
  const now = Date.now();
  const rows = await prisma.message.findMany({ where: { poll: { not: null, contains: '"finalized":false' } }, select: { id: true, channelId: true, poll: true, authorId: true }, take: 500 });
  for (const r of rows) {
    const p = jsonParse<{ expiresAt: string | null; finalized: boolean } | null>(r.poll, null);
    if (!p || !p.expiresAt || new Date(p.expiresAt).getTime() > now) continue;
    p.finalized = true;
    await prisma.message.update({ where: { id: r.id }, data: { poll: JSON.stringify({ ...jsonParse<object>(r.poll, {}), finalized: true }) } });
    await broadcastPoll(r.id, r.channelId);
    await createMessage(r.authorId, r.channelId, { content: "" }, { type: MessageType.POLL_RESULT, replyTo: r.id }).catch(() => {});
  }
}

async function cleanupOrphans() {
  const cutoff = new Date(Date.now() - 24 * 3_600_000);
  const scheduled = await prisma.scheduledMessage.findMany({ select: { attachments: true } });
  const keep = new Set(scheduled.flatMap((s) => jsonParse<string[]>(s.attachments, [])));
  const orphans = await prisma.attachment.findMany({ where: { messageId: null, createdAt: { lt: cutoff } }, select: { id: true, path: true }, take: 500 });
  for (const a of orphans) {
    if (keep.has(a.id)) continue;
    await prisma.attachment.delete({ where: { id: a.id } }).catch(() => {});
    await deleteStored(a.path);
  }
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

async function expireCustomStatuses() {
  const rows = await prisma.user.findMany({ where: { customStatusExpires: { lt: new Date() } }, select: { id: true } });
  if (!rows.length) return;
  await prisma.user.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { customStatusText: null, customStatusEmoji: null, customStatusExpires: null },
  });
  for (const r of rows) {
    presence.setCustom(r.id, null);
    await broadcastPresence(r.id);
  }
}

export function startJobs(log: Log) {
  return [
    every(10_000, sendScheduled, log, "scheduled"),
    every(30_000, finalizePolls, log, "polls"),
    every(60 * 60_000, cleanupOrphans, log, "cleanup"),
    every(60_000, expireCustomStatuses, log, "custom-status"),
    every(30_000, () => voice.reconcile(), log, "voice-reconcile"),
  ];
}
