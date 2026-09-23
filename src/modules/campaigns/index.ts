import { count, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { audit } from "../../db/audit.js";
import {
  CAMPAIGN_STATUSES,
  CAMPAIGN_TYPES,
  campaigns,
  candidateClips,
  footageSources,
  sourceJobs,
  type CampaignStatus,
  type CampaignType,
} from "../../db/schema.js";
import { recordCreated, transition } from "../../db/transition.js";
import {
  fetchCampaign,
  fetchDiscoverListing,
  parseCampaignIdFromUrlSafe,
  type ConnectorDeps,
  type ListedCampaign,
} from "../campaign-connector/index.js";

export class CampaignsError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid_argument",
    message: string,
  ) {
    super(message);
    this.name = "CampaignsError";
  }
}

export type Ctx = { db: Db; actor: string; connector?: ConnectorDeps };

type CampaignRow = typeof campaigns.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Finds a tracked campaign by our ID, its Content Rewards campaign ID, or a
 * Content Rewards URL, so the operator can use whichever it has at hand.
 */
export async function resolveCampaign(db: Db, ref: string): Promise<CampaignRow> {
  const trimmed = ref.trim();
  const crId = UUID.test(trimmed) ? trimmed.toLowerCase() : parseCampaignIdFromUrlSafe(trimmed);
  if (!crId) throw new CampaignsError("invalid_argument", `Not a campaign ID or Content Rewards URL: ${ref}`);

  const [byId] = UUID.test(trimmed) ? await db.select().from(campaigns).where(eq(campaigns.id, crId)) : [];
  if (byId) return byId;
  const [byCrId] = await db.select().from(campaigns).where(eq(campaigns.contentRewardsCampaignId, crId));
  if (byCrId) return byCrId;
  throw new CampaignsError("not_found", `No tracked campaign matches ${ref}`);
}

/** Summary shape used by list/show output: no large JSON blobs. */
function summary(c: CampaignRow) {
  return {
    id: c.id,
    contentRewardsCampaignId: c.contentRewardsCampaignId,
    url: c.contentRewardsUrl,
    title: c.title,
    brand: c.brand,
    platforms: c.platforms ?? [],
    status: c.status,
    statusReason: c.statusReason,
    campaignType: c.campaignType,
    campaignTypeReason: c.campaignTypeReason,
    configConfirmedAt: c.configConfirmedAt,
    createdAt: c.createdAt,
  };
}

/**
 * Tracks a campaign: runs campaign-connector and inserts it as `discovered`.
 * Idempotent: adding an already-tracked campaign returns it unchanged.
 */
export async function addCampaign(ctx: Ctx, url: string) {
  const metadata = await fetchCampaign(url, ctx.connector);
  const [existing] = await ctx.db
    .select()
    .from(campaigns)
    .where(eq(campaigns.contentRewardsCampaignId, metadata.campaignId));
  if (existing) return { created: false, campaign: summary(existing) };

  const row = await ctx.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(campaigns)
      .values({
        contentRewardsCampaignId: metadata.campaignId,
        contentRewardsUrl: url.trim(),
        title: metadata.title,
        brand: metadata.brand,
        platforms: metadata.platforms,
        guidelineDocUrl: metadata.guidelineDocUrl,
        crSnapshot: metadata as unknown as Record<string, unknown>,
        crSnapshotAt: new Date(),
        status: "discovered",
      })
      .onConflictDoNothing({ target: campaigns.contentRewardsCampaignId })
      .returning();
    if (inserted) {
      await recordCreated(tx, { entity: "campaign", id: inserted.id, status: "discovered", actor: ctx.actor });
    }
    return inserted;
  });
  if (!row) {
    // Lost a race with a concurrent add of the same campaign; return the winner.
    const [winner] = await ctx.db
      .select()
      .from(campaigns)
      .where(eq(campaigns.contentRewardsCampaignId, metadata.campaignId));
    return { created: false, campaign: summary(winner!) };
  }
  return {
    created: true,
    campaign: summary(row),
    // Content Rewards' own view, for the operator's next step (classify / onboard).
    contentRewards: {
      status: metadata.sourceStatus,
      requiresApplication: metadata.requiresApplication,
      payouts: metadata.payouts,
      referenceMaterials: metadata.referenceMaterials,
    },
  };
}

export async function listCampaigns(db: Db, opts: { status?: string } = {}) {
  if (opts.status && !(CAMPAIGN_STATUSES as readonly string[]).includes(opts.status)) {
    throw new CampaignsError("invalid_argument", `Unknown status ${opts.status}; one of ${CAMPAIGN_STATUSES.join(", ")}`);
  }
  const rows = await db
    .select()
    .from(campaigns)
    .where(opts.status ? eq(campaigns.status, opts.status as CampaignStatus) : undefined)
    .orderBy(desc(campaigns.createdAt));
  return { campaigns: rows.map(summary) };
}

export async function showCampaign(db: Db, ref: string) {
  const c = await resolveCampaign(db, ref);
  const sources = await db.select().from(footageSources).where(eq(footageSources.campaignId, c.id));
  const jobCounts = await db
    .select({ status: sourceJobs.status, n: count() })
    .from(sourceJobs)
    .where(eq(sourceJobs.campaignId, c.id))
    .groupBy(sourceJobs.status);
  const jobIds = db.select({ id: sourceJobs.id }).from(sourceJobs).where(eq(sourceJobs.campaignId, c.id));
  const clipCounts = await db
    .select({ status: candidateClips.status, n: count() })
    .from(candidateClips)
    .where(inArray(candidateClips.sourceJobId, jobIds))
    .groupBy(candidateClips.status);
  const byStatus = (rows: { status: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return {
    campaign: {
      ...summary(c),
      guidelineDocUrl: c.guidelineDocUrl,
      maxDailyCredits: c.maxDailyCredits,
      config: c.config,
      configConfirmedBy: c.configConfirmedBy,
      contentRewards: c.crSnapshot,
      contentRewardsSnapshotAt: c.crSnapshotAt,
    },
    footageSources: sources.map((s) => ({
      id: s.id,
      kind: s.kind,
      url: s.url,
      label: s.label,
      reason: s.reason,
      lastListedAt: s.lastListedAt,
    })),
    sourceJobs: byStatus(jobCounts),
    candidateClips: byStatus(clipCounts),
  };
}

/** Records what kind of campaign this is. Not a status change, so it's audited in audit_log. */
export async function classifyCampaign(ctx: Ctx, ref: string, type: string, reason: string) {
  if (!(CAMPAIGN_TYPES as readonly string[]).includes(type)) {
    throw new CampaignsError("invalid_argument", `Unknown type ${type}; one of ${CAMPAIGN_TYPES.join(", ")}`);
  }
  if (!reason.trim()) throw new CampaignsError("invalid_argument", "--reason is required");
  const c = await resolveCampaign(ctx.db, ref);
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(campaigns)
      .set({ campaignType: type as CampaignType, campaignTypeReason: reason })
      .where(eq(campaigns.id, c.id));
    await audit(tx, {
      entityType: "campaign",
      entityId: c.id,
      action: "classify",
      actor: ctx.actor,
      details: { from: c.campaignType, to: type, reason },
    });
  });
  return { id: c.id, campaignType: type, reason };
}

/** Puts a campaign in front of a person. Notification delivery arrives with the notifier (task 12). */
export async function flagCampaign(ctx: Ctx, ref: string, reason: string) {
  if (!reason.trim()) throw new CampaignsError("invalid_argument", "--reason is required");
  const c = await resolveCampaign(ctx.db, ref);
  if (c.status === "needs_attention") {
    // Already flagged: keep the status, record the additional reason.
    await audit(ctx.db, { entityType: "campaign", entityId: c.id, action: "flag", actor: ctx.actor, details: { reason } });
    return { id: c.id, status: c.status, alreadyFlagged: true, notified: false };
  }
  await transition(ctx.db, { entity: "campaign", id: c.id, to: "needs_attention", actor: ctx.actor, reason });
  return { id: c.id, status: "needs_attention" as const, alreadyFlagged: false, notified: false };
}

/**
 * Discover-page campaigns, annotated with whether we already track them.
 * Untracked only by default: those are what scouting is for.
 */
export async function scoutCampaigns(ctx: Ctx, opts: { all?: boolean } = {}) {
  const listed: ListedCampaign[] = await fetchDiscoverListing(ctx.connector);
  const ids = listed.map((c) => c.campaignId);
  const tracked = ids.length
    ? await ctx.db
        .select({ crId: campaigns.contentRewardsCampaignId, id: campaigns.id, status: campaigns.status })
        .from(campaigns)
        .where(inArray(campaigns.contentRewardsCampaignId, ids))
    : [];
  const trackedById = new Map(tracked.map((t) => [t.crId, t]));
  const annotated = listed.map((c) => ({ ...c, tracked: trackedById.get(c.campaignId) ?? null }));
  const shown = opts.all ? annotated : annotated.filter((c) => !c.tracked);
  return { listed: listed.length, tracked: tracked.length, campaigns: shown };
}

