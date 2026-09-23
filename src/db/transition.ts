import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  campaigns,
  candidateClips,
  sourceJobs,
  statusEvents,
  type CampaignStatus,
  type CandidateClipStatus,
  type EntityType,
  type SourceJobStatus,
} from "./schema.js";

// The only code path that writes a `status` column. Each call updates the row and
// appends its `status_events` audit row in one transaction, and refuses changes
// that aren't in the allowed-transition tables below.

type StatusOf = {
  campaign: CampaignStatus;
  source_job: SourceJobStatus;
  candidate_clip: CandidateClipStatus;
};

const tables = {
  campaign: campaigns,
  source_job: sourceJobs,
  candidate_clip: candidateClips,
} as const;

type TableOf = typeof tables;
type Settable<E extends EntityType> = Omit<Partial<TableOf[E]["$inferInsert"]>, "id" | "status" | "statusReason">;

const allowed: { [E in EntityType]: Partial<Record<StatusOf[E], readonly StatusOf[E][]>> } = {
  campaign: {
    discovered: ["ingesting", "requirements_drafted", "pending_confirmation", "needs_attention", "archived"],
    ingesting: ["discovered", "requirements_drafted", "needs_attention"],
    requirements_drafted: ["pending_confirmation", "needs_attention", "archived"],
    pending_confirmation: ["pending_confirmation", "active", "needs_attention", "archived"],
    active: ["paused", "needs_attention", "archived"],
    paused: ["active", "archived"],
    needs_attention: ["discovered", "pending_confirmation", "active", "paused", "archived"],
    archived: [],
  },
  source_job: {
    detected: ["validating", "queued", "validation_failed", "needs_attention"],
    validating: ["queued", "validation_failed"],
    validation_failed: ["queued", "needs_attention"],
    queued: ["submitting", "needs_attention"],
    submitting: ["project_created", "queued", "submit_failed", "needs_attention"],
    submit_failed: ["queued", "needs_attention"],
    project_created: ["processing", "candidates_ready", "needs_attention"],
    processing: ["processing", "candidates_ready", "needs_attention"],
    candidates_ready: ["completed"],
    needs_attention: ["detected", "queued", "submit_failed", "project_created"],
    skipped: [],
    completed: [],
  },
  candidate_clip: {
    generated: ["checking", "awaiting_review"],
    checking: ["awaiting_review"],
    awaiting_review: ["approved", "needs_edit", "rejected", "archived"],
    needs_edit: ["awaiting_review", "rejected"],
    approved: ["exporting", "ready_to_post"],
    exporting: ["ready_to_post", "approved"],
    ready_to_post: ["posted"],
    posted: ["archived"],
    rejected: ["archived"],
    archived: [],
  },
};

/**
 * Transitions only a person may make. Automation (the operator, cron, the CLI)
 * can never activate a campaign or decide a clip's fate, whatever it's told.
 */
const humanOnly: { [E in EntityType]: readonly StatusOf[E][] } = {
  campaign: ["active"],
  source_job: [],
  candidate_clip: ["approved", "needs_edit", "rejected", "posted"],
};

/** Human actors are recorded as `reviewer:<identity>`. Anything else is automation. */
export const isHumanActor = (actor: string) => /^reviewer:\S+$/.test(actor);

export const OPERATOR_ACTOR = "claude-operator";

export type TransitionErrorCode = "not_found" | "invalid_transition" | "human_only";

export class TransitionError extends Error {
  constructor(
    public readonly code: TransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TransitionError";
  }
}

export type TransitionInput<E extends EntityType> = {
  entity: E;
  id: string;
  to: StatusOf[E];
  actor: string;
  reason?: string;
  errorDetails?: unknown;
  /** Other columns to update in the same statement. `status`/`statusReason` are set by `to`/`reason`. */
  set?: Settable<E>;
  /** Refuse unless the current status is one of these (for callers that need a precondition). */
  expectFrom?: readonly StatusOf[E][];
};

type Executor = Pick<Db, "transaction">;

export async function transition<E extends EntityType>(
  db: Executor,
  input: TransitionInput<E>,
): Promise<{ from: StatusOf[E]; to: StatusOf[E] }> {
  const { entity, id, to, actor } = input;
  // The three tables share `id` and `status`; drizzle can't type a union of tables,
  // so view the chosen one through a single table type. Only shared columns are touched.
  const table = tables[entity] as unknown as typeof sourceJobs;
  const hasStatusReason = "statusReason" in tables[entity];

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ status: table.status })
      .from(table)
      .where(eq(table.id, id))
      .for("update");
    if (!row) throw new TransitionError("not_found", `${entity} ${id} not found`);
    const from = row.status as StatusOf[E];

    if (input.expectFrom && !input.expectFrom.includes(from)) {
      throw new TransitionError(
        "invalid_transition",
        `${entity} ${id} is ${from}; expected one of ${input.expectFrom.join(", ")}`,
      );
    }
    const targets = (allowed[entity] as Record<string, readonly string[] | undefined>)[from] ?? [];
    if (!targets.includes(to)) {
      throw new TransitionError("invalid_transition", `${entity} ${id} cannot go from ${from} to ${to}`);
    }
    if ((humanOnly[entity] as readonly string[]).includes(to) && !isHumanActor(actor)) {
      throw new TransitionError("human_only", `only a reviewer can move a ${entity} to ${to} (actor: ${actor})`);
    }

    // `status` goes last so a loosely-typed `set` can never override it.
    const values: Record<string, unknown> = { ...(input.set ?? {}), status: to };
    if (hasStatusReason) values.statusReason = input.reason ?? null;

    await tx.update(table).set(values as never).where(eq(table.id, id));
    await tx.insert(statusEvents).values({
      entityType: entity,
      entityId: id,
      fromStatus: from,
      toStatus: to,
      actor,
      reason: input.reason ?? null,
      errorDetails: input.errorDetails ?? null,
    });
    return { from, to };
  });
}
