import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { audit } from "../../db/audit.js";
import { auditLog, campaigns, sourceJobs, statusEvents, type EntityType } from "../../db/schema.js";

// Everything waiting on a person or on triage, and the notification digest for
// it. An item is notified once per status change: the digest records which
// status event it announced, so the same failure isn't re-sent every hour, but
// a job that fails again later is.

export const ATTENTION_JOB_STATUSES = ["needs_attention", "validation_failed", "submit_failed"] as const;
/** A config waiting this long for a person's confirmation is worth a nudge. */
export const STALE_CONFIG_HOURS = 24;

export type AttentionItem = {
  entity: Extract<EntityType, "campaign" | "source_job">;
  id: string;
  kind: "campaign_needs_attention" | "config_waiting" | "job_needs_attention" | "job_validation_failed" | "job_submit_failed";
  status: string;
  reason: string | null;
  campaignId: string;
  campaign: string | null;
  name?: string | null;
  since: Date | null;
  statusEventId: string | null;
};

async function latestEvents(db: Pick<Db, "select">, ids: string[]) {
  if (!ids.length) return new Map<string, { id: string; at: Date }>();
  const rows = await db
    .select({ id: statusEvents.id, entityId: statusEvents.entityId, at: statusEvents.createdAt })
    .from(statusEvents)
    .where(inArray(statusEvents.entityId, ids))
    .orderBy(desc(statusEvents.createdAt));
  const latest = new Map<string, { id: string; at: Date }>();
  for (const r of rows) if (!latest.has(r.entityId)) latest.set(r.entityId, { id: r.id, at: r.at });
  return latest;
}

/** Jobs and campaigns needing triage, plus every config waiting for confirmation (oldest first). */
export async function listAttention(db: Db): Promise<{ items: AttentionItem[] }> {
  const jobs = await db
    .select({ job: sourceJobs, campaignTitle: campaigns.title })
    .from(sourceJobs)
    .innerJoin(campaigns, eq(campaigns.id, sourceJobs.campaignId))
    .where(inArray(sourceJobs.status, [...ATTENTION_JOB_STATUSES]));
  const camps = await db.select().from(campaigns).where(inArray(campaigns.status, ["needs_attention", "pending_confirmation"]));
  const latest = await latestEvents(db, [...jobs.map((j) => j.job.id), ...camps.map((c) => c.id)]);

  const items: AttentionItem[] = [
    ...camps.map((c) => ({
      entity: "campaign" as const,
      id: c.id,
      kind: c.status === "pending_confirmation" ? ("config_waiting" as const) : ("campaign_needs_attention" as const),
      status: c.status,
      reason: c.statusReason,
      campaignId: c.id,
      campaign: c.title,
      since: latest.get(c.id)?.at ?? c.updatedAt,
      statusEventId: latest.get(c.id)?.id ?? null,
    })),
    ...jobs.map(({ job, campaignTitle }) => ({
      entity: "source_job" as const,
      id: job.id,
      kind: `job_${job.status}` as AttentionItem["kind"],
      status: job.status,
      reason: job.statusReason,
      campaignId: job.campaignId,
      campaign: campaignTitle,
      name: job.sourceName,
      since: latest.get(job.id)?.at ?? job.updatedAt,
      statusEventId: latest.get(job.id)?.id ?? null,
    })),
  ];
  items.sort((a, b) => (a.since?.getTime() ?? 0) - (b.since?.getTime() ?? 0));
  return { items };
}

const describe = (i: AttentionItem, now: Date) => {
  const hours = i.since ? Math.floor((now.getTime() - i.since.getTime()) / 3_600_000) : null;
  const what = i.name ? `${i.campaign ?? "?"} / ${i.name}` : (i.campaign ?? i.id);
  switch (i.kind) {
    case "config_waiting":
      return `• Config waiting for your confirmation${hours !== null ? ` for ${hours}h` : ""}: ${what}`;
    case "campaign_needs_attention":
      return `• Campaign needs attention: ${what}: ${i.reason ?? "no reason recorded"}`;
    default:
      return `• ${i.status.replace(/_/g, " ")}: ${what}: ${i.reason ?? "no reason recorded"}`;
  }
};

export type NotifyAttentionCtx = {
  db: Db;
  actor: string;
  send: (message: string) => Promise<unknown>;
  now?: () => Date;
  staleConfigHours?: number;
  /** Base URL of the review web app, to link from the message. */
  reviewUrl?: string;
};

/**
 * Sends one digest of attention items not yet announced for their current
 * status, plus configs waiting longer than STALE_CONFIG_HOURS, and records each
 * as notified only after delivery succeeds.
 */
export async function notifyAttention(ctx: NotifyAttentionCtx) {
  const now = ctx.now?.() ?? new Date();
  const staleMs = (ctx.staleConfigHours ?? STALE_CONFIG_HOURS) * 3_600_000;
  const { items } = await listAttention(ctx.db);
  const due = items.filter((i) => i.kind !== "config_waiting" || (i.since !== null && now.getTime() - i.since.getTime() >= staleMs));

  const eventIds = due.map((i) => i.statusEventId).filter((x): x is string => x !== null);
  const already = new Set<string>();
  if (due.length) {
    const rows = await ctx.db
      .select({ entityId: auditLog.entityId, details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.action, "notify"), inArray(auditLog.entityId, due.map((i) => i.id))));
    for (const r of rows) {
      const ev = (r.details as { statusEventId?: string } | null)?.statusEventId;
      if (ev && eventIds.includes(ev)) already.add(ev);
    }
  }
  const fresh = due.filter((i) => !(i.statusEventId && already.has(i.statusEventId)));
  if (!fresh.length) return { sent: false, items: 0, pending: items.length };

  const lines = [`Clipper needs you (${fresh.length}):`, ...fresh.map((i) => describe(i, now))];
  if (ctx.reviewUrl) lines.push(`Review: ${ctx.reviewUrl}`);
  const message = lines.join("\n");
  await ctx.send(message);

  await ctx.db.transaction(async (tx) => {
    for (const i of fresh) {
      await audit(tx, { entityType: i.entity, entityId: i.id, action: "notify", actor: ctx.actor, details: { statusEventId: i.statusEventId, kind: i.kind } });
    }
  });
  return { sent: true, items: fresh.length, pending: items.length, message };
}
