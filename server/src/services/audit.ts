import type { AuditActionValue, AuditEntryDTO } from "@nova/shared";
import { ulid } from "@nova/shared";
import { prisma, jsonParse } from "../db";

export async function audit(
  guildId: string,
  actorId: string,
  action: AuditActionValue,
  targetId: string | null,
  changes?: Record<string, unknown> | null,
  reason?: string | null
) {
  try {
    await prisma.auditLog.create({
      data: {
        id: ulid(),
        guildId,
        actorId,
        action,
        targetId,
        changes: changes ? JSON.stringify(changes) : null,
        reason: reason ?? null,
      },
    });
  } catch {
    /* auditing must never break the action itself */
  }
}

export async function listAudit(guildId: string, before?: string, limit = 50): Promise<AuditEntryDTO[]> {
  const rows = await prisma.auditLog.findMany({
    where: { guildId, ...(before ? { id: { lt: before } } : {}) },
    orderBy: { id: "desc" },
    take: Math.min(100, Math.max(1, limit)),
  });
  return rows.map((r) => ({
    id: r.id,
    guildId: r.guildId,
    actorId: r.actorId,
    action: r.action,
    targetId: r.targetId,
    changes: jsonParse<Record<string, unknown> | null>(r.changes, null),
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }));
}
