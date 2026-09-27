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
    queued: ["submitting", "waiting_on_drive", "needs_attention"],
    waiting_on_drive: ["queued", "needs_attention"],
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

/**
 * Moves into a human-only status that automation may still make, because they
 * return to a decision a person already took rather than make a new one:
 * a failed packaging run (exporting, only reachable from approved) goes back to approved.
 */
const humanOnlyReverts: { [E in EntityType]: Partial<Record<StatusOf[E], readonly StatusOf[E][]>> } = {
  campaign: {},
  source_job: {},
  candidate_clip: { approved: ["exporting"] },
};

/**
 * Human-only moves automation may make when a named person asked for exactly
 * that (`requestedBy`): only rejecting clips, which spends nothing and
 * publishes nothing. The requester goes into the status_events reason.
 */
const onPersonsRequest: { [E in EntityType]: readonly StatusOf[E][] } = {
  campaign: [],
  source_job: [],
  candidate_clip: ["rejected"],
};

/**
 * Standing rules a person set once, under which automation may make a
 * human-only move without being asked each time. The caller checks the rule's
 * conditions; the rule's name goes into the status_events reason.
 */
export const STANDING_RULES = {
  /** A clip with a recorded failed check that the operator's own pre-screen also rejects (decided 2026-09-27). */
  reject_failed_checks: "standing rule: failed checks + pre-screen reject",
  /** A config the operator verified against the campaign page and brief, every field matching (decided 2026-09-27). */
  activate_verified_config: "standing rule: config self-verified against the campaign page and brief",
} as const;
export type StandingRule = keyof typeof STANDING_RULES;

const byStandingRule: { [R in StandingRule]: { entity: EntityType; to: string } } = {
  reject_failed_checks: { entity: "candidate_clip", to: "rejected" },
  activate_verified_config: { entity: "campaign", to: "active" },
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
  /** The person who asked automation to make this move; see `onPersonsRequest`. */
  requestedBy?: string;
  /** The standing rule this move is made under; see `STANDING_RULES`. */
  standingRule?: StandingRule;
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
    const revert = ((humanOnlyReverts[entity] as Record<string, readonly string[] | undefined>)[to] ?? []).includes(from);
    const requested = !!input.requestedBy?.trim() && (onPersonsRequest[entity] as readonly string[]).includes(to);
    const rule = input.standingRule ? byStandingRule[input.standingRule] : undefined;
    const byRule = !!rule && rule.entity === entity && rule.to === to;
    if ((humanOnly[entity] as readonly string[]).includes(to) && !revert && !requested && !byRule && !isHumanActor(actor)) {
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

/**
 * Audit row for an entity's *initial* status, written by the code that inserts
 * it (in the same transaction). Inserts don't go through transition(): there's
 * no previous status to validate against.
 */
export async function recordCreated<E extends EntityType>(
  tx: Pick<Db, "insert">,
  input: { entity: E; id: string; status: StatusOf[E]; actor: string; reason?: string },
): Promise<void> {
  await tx.insert(statusEvents).values({
    entityType: input.entity,
    entityId: input.id,
    fromStatus: null,
    toStatus: input.status,
    actor: input.actor,
    reason: input.reason ?? null,
  });
}
