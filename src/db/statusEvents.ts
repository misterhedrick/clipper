import type { QueryClient } from "./pool.js";
import type { EntityType } from "./types.js";

export interface RecordStatusEventInput {
  entityType: EntityType;
  entityId: string;
  fromStatus: string | null;
  toStatus: string;
  actor: string;
  reason?: string | null;
  errorDetails?: unknown;
}

/**
 * Per DATA_MODEL.md: "Application code should never update a status column
 * without also inserting here in the same transaction." Callers pass the
 * transaction client obtained from withTransaction().
 */
export async function recordStatusEvent(client: QueryClient, input: RecordStatusEventInput): Promise<void> {
  await client.query(
    `insert into status_events (entity_type, entity_id, from_status, to_status, actor, reason, error_details)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.entityType,
      input.entityId,
      input.fromStatus,
      input.toStatus,
      input.actor,
      input.reason ?? null,
      input.errorDetails ? JSON.stringify(input.errorDetails) : null,
    ],
  );
}
