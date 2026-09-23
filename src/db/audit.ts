import type { Db } from "./client.js";
import { auditLog, type AuditEntityType } from "./schema.js";

/**
 * Records a write that isn't a status change (status changes are audited by
 * transition()). Call it inside the same transaction as the write it describes.
 */
export async function audit(
  tx: Pick<Db, "insert">,
  entry: {
    entityType: AuditEntityType;
    entityId?: string | null;
    action: string;
    actor: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    action: entry.action,
    actor: entry.actor,
    details: entry.details ?? null,
  });
}
