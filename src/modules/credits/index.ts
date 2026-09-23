import { and, desc, eq, gte, inArray, sql, sum } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { audit } from "../../db/audit.js";
import { campaigns, creditLedger, opusUsageSnapshots } from "../../db/schema.js";

// Our own ledger of OpusClip credits. OpusClip reports its monthly cap as not
// enforced, so this ledger (plus the `--opus-remaining` figure the operator reads
// from opusclip_get_usage) is the limit that actually holds.

/** Held when a video's length is unknown (Drive/YouTube listings don't give it). ≈1 credit per source minute. */
export const DEFAULT_ESTIMATE_MINUTES = 90;
/** OpusClip consumes at least this much per project. */
export const MIN_CREDITS_PER_PROJECT = 10;

/** Serializes every budget check + reservation so two concurrent reserves can't both pass. */
const BUDGET_LOCK_KEY = 0x636c6970; // "clip"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function estimateCredits(opts: { rangeSeconds?: number; estimatedMinutes?: number }): number {
  const minutes = opts.rangeSeconds !== undefined ? opts.rangeSeconds / 60 : (opts.estimatedMinutes ?? DEFAULT_ESTIMATE_MINUTES);
  return Math.max(MIN_CREDITS_PER_PROJECT, Math.ceil(minutes));
}

export async function lockBudget(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${BUDGET_LOCK_KEY})`);
}

/** Credits held or spent since the start of today (UTC): open + consumed reservations. */
export async function usedToday(db: Pick<Db, "select">, campaignId?: string, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ total: sum(creditLedger.creditsReserved) })
    .from(creditLedger)
    .where(
      and(
        inArray(creditLedger.status, ["open", "consumed"]),
        gte(creditLedger.reservedAt, startOfUtcDay(now)),
        campaignId ? eq(creditLedger.campaignId, campaignId) : undefined,
      ),
    );
  return Number(row?.total ?? 0);
}

export async function latestUsageSnapshot(db: Pick<Db, "select">) {
  const [snap] = await db.select().from(opusUsageSnapshots).orderBy(desc(opusUsageSnapshots.createdAt)).limit(1);
  return snap ?? null;
}

/** Budget view for `clipper credits`. */
export async function creditsSummary(db: Db, dailyBudget: number, now = new Date()) {
  const perCampaign = await db
    .select({
      campaignId: creditLedger.campaignId,
      title: campaigns.title,
      maxDailyCredits: campaigns.maxDailyCredits,
      used: sum(creditLedger.creditsReserved),
    })
    .from(creditLedger)
    .innerJoin(campaigns, eq(campaigns.id, creditLedger.campaignId))
    .where(and(inArray(creditLedger.status, ["open", "consumed"]), gte(creditLedger.reservedAt, startOfUtcDay(now))))
    .groupBy(creditLedger.campaignId, campaigns.title, campaigns.maxDailyCredits);
  const used = perCampaign.reduce((n, c) => n + Number(c.used ?? 0), 0);
  const [open] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(creditLedger)
    .where(eq(creditLedger.status, "open"));
  const snap = await latestUsageSnapshot(db);
  return {
    today: { used, budget: dailyBudget, remaining: Math.max(0, dailyBudget - used), resetsAt: new Date(startOfUtcDay(now).getTime() + 86_400_000) },
    perCampaign: perCampaign.map((c) => ({
      campaignId: c.campaignId,
      title: c.title,
      used: Number(c.used ?? 0),
      cap: c.maxDailyCredits,
    })),
    openReservations: open?.n ?? 0,
    opusclip: snap
      ? { used: snap.used, limit: snap.monthlyLimit, remaining: snap.monthlyLimit - snap.used, resetAt: snap.resetAt, recordedAt: snap.createdAt }
      : null,
  };
}

/** Records OpusClip's own usage figures (from opusclip_get_usage). */
export async function reconcileUsage(
  db: Db,
  actor: string,
  input: { used: number; limit: number; resetAt: Date },
) {
  const previous = await latestUsageSnapshot(db);
  return db.transaction(async (tx) => {
    const [snap] = await tx
      .insert(opusUsageSnapshots)
      .values({ used: input.used, monthlyLimit: input.limit, resetAt: input.resetAt, recordedBy: actor })
      .returning();
    await audit(tx, {
      entityType: "credits",
      action: "reconcile",
      actor,
      details: { used: input.used, limit: input.limit, resetAt: input.resetAt.toISOString(), previousUsed: previous?.used ?? null },
    });
    return {
      used: snap!.used,
      limit: snap!.monthlyLimit,
      remaining: snap!.monthlyLimit - snap!.used,
      resetAt: snap!.resetAt,
      sinceLastReconcile: previous && previous.resetAt.getTime() === snap!.resetAt.getTime() ? snap!.used - previous.used : null,
    };
  });
}
