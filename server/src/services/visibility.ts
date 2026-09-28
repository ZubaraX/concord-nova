// When roles, overwrites or membership change, some members gain or lose the
// ability to see channels. Run the mutation inside withVisibilityDiff() and
// each affected member gets CHANNEL_CREATE / CHANNEL_DELETE for exactly the
// channels that appeared or vanished for them.
import { prisma } from "../db";
import { cache } from "../state/cache";
import { toUser } from "../gateway/io";
import { channelInclude, toChannel } from "./serialize";

export async function withVisibilityDiff<T>(guildId: string, fn: () => Promise<T>): Promise<T> {
  const before = cache.visibilityMap(guildId);
  const result = await fn();
  const after = cache.visibilityMap(guildId);

  const gained = new Map<string, string[]>();
  const lost = new Map<string, string[]>();
  const need = new Set<string>();
  for (const [uid, now] of after) {
    const was = before.get(uid);
    if (!was) continue; // new member → gets GUILD_CREATE elsewhere
    const g = [...now].filter((c) => !was.has(c));
    const l = [...was].filter((c) => !now.has(c));
    if (g.length) {
      gained.set(uid, g);
      g.forEach((c) => need.add(c));
    }
    if (l.length) lost.set(uid, l);
  }
  if (need.size) {
    const rows = await prisma.channel.findMany({ where: { id: { in: [...need] } }, include: channelInclude });
    const byId = new Map(rows.map((r) => [r.id, toChannel(r)]));
    for (const [uid, ids] of gained) for (const id of ids) {
      const dto = byId.get(id);
      if (dto) toUser(uid, "CHANNEL_CREATE", dto);
    }
  }
  for (const [uid, ids] of lost) for (const id of ids) toUser(uid, "CHANNEL_DELETE", { id, guildId });
  return result;
}
