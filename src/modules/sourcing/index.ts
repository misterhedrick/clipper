import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { audit } from "../../db/audit.js";
import { footageSources, sourceJobs, type SourceDecision } from "../../db/schema.js";
import { recordCreated } from "../../db/transition.js";
import { CampaignsError, resolveCampaign } from "../campaigns/index.js";
import { classifyFootageUrl, FootageError, listFootageUrl, type ListDeps } from "../footage-sources/index.js";

// The operator's footage decisions: which locations belong to a campaign, and for
// each video, selected (→ a source job) or skipped. Every decision is recorded with
// a reason, and the (campaign, source_key) unique key makes each one final and
// dedupes re-listings.

export type SourcingCtx = { db: Db; actor: string; list?: ListDeps };

export class SourcingError extends Error {
  constructor(
    public readonly code: "already_decided" | "invalid_argument" | "invalid_state",
    message: string,
  ) {
    super(message);
    this.name = "SourcingError";
  }
}

async function sourcingCampaign(db: Db, ref: string) {
  const c = await resolveCampaign(db, ref);
  if (c.campaignType !== "lf") {
    throw new CampaignsError("invalid_state", `Only long-form (lf) campaigns get footage; this one is ${c.campaignType ?? "unclassified"}.`);
  }
  if (c.status === "archived") throw new CampaignsError("invalid_state", "Campaign is archived.");
  return c;
}

const requireReason = (reason: string) => {
  if (!reason.trim()) throw new SourcingError("invalid_argument", "--reason is required");
};

/** Registers a footage location (folder, channel or single file) for a campaign. Idempotent per URL. */
export async function addFootageSource(ctx: SourcingCtx, campaignRef: string, url: string, label: string | undefined, reason: string) {
  requireReason(reason);
  const c = await sourcingCampaign(ctx.db, campaignRef);
  const classified = classifyFootageUrl(url);
  if (classified.role === "unsupported") {
    throw new FootageError("unsupported_host", `${classified.url}: ${classified.reason}`);
  }
  const stored = classified.url;
  return ctx.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(footageSources)
      .values({ campaignId: c.id, kind: classified.kind, url: stored, label: label ?? null, addedBy: ctx.actor, reason })
      .onConflictDoNothing({ target: [footageSources.campaignId, footageSources.url] })
      .returning();
    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(footageSources)
        .where(and(eq(footageSources.campaignId, c.id), eq(footageSources.url, stored)));
      return { created: false, footageSource: existing!, role: classified.role };
    }
    await audit(tx, {
      entityType: "footage_source",
      entityId: inserted.id,
      action: "add",
      actor: ctx.actor,
      details: { campaignId: c.id, kind: classified.kind, url: stored, label, reason },
    });
    return { created: true, footageSource: inserted, role: classified.role };
  });
}

type DecideOpts = { name?: string; path?: string; from?: string };

/**
 * Records the operator's decision about one video. `selected` creates a source job
 * in `detected`; `skipped` parks it in the terminal `skipped` status so later
 * listings don't bring it back. Re-recording the same decision is a no-op;
 * a different decision is refused (`already_decided`).
 */
export async function decideFootage(
  ctx: SourcingCtx,
  campaignRef: string,
  url: string,
  decision: SourceDecision,
  reason: string,
  opts: DecideOpts = {},
) {
  requireReason(reason);
  const c = await sourcingCampaign(ctx.db, campaignRef);
  const classified = classifyFootageUrl(url);
  if (classified.role === "unsupported") throw new FootageError("unsupported_host", `${classified.url}: ${classified.reason}`);
  if (classified.role !== "file") {
    throw new SourcingError(
      "invalid_argument",
      `${url} is a ${classified.role}; select individual videos from \`footage list-url\` instead`,
    );
  }

  let footageSourceId: string | null = null;
  if (opts.from) {
    const [src] = await ctx.db
      .select({ id: footageSources.id })
      .from(footageSources)
      .where(and(eq(footageSources.campaignId, c.id), eq(footageSources.url, classifyFootageUrl(opts.from).url)));
    if (!src) throw new SourcingError("invalid_argument", `--from ${opts.from} isn't a registered footage source for this campaign`);
    footageSourceId = src.id;
  }

  const [existing] = await ctx.db
    .select()
    .from(sourceJobs)
    .where(and(eq(sourceJobs.campaignId, c.id), eq(sourceJobs.sourceKey, classified.sourceKey)));
  if (existing) {
    if (existing.decision !== decision) {
      throw new SourcingError(
        "already_decided",
        `${classified.sourceKey} was already ${existing.decision} (${existing.decisionReason}); decisions are final, ask a person to change it`,
      );
    }
    return { created: false, sourceJob: jobSummary(existing) };
  }

  const status = decision === "selected" ? ("detected" as const) : ("skipped" as const);
  const job = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(sourceJobs)
      .values({
        campaignId: c.id,
        footageSourceId,
        sourceKey: classified.sourceKey,
        sourceKind: classified.kind,
        sourceName: opts.name ?? null,
        sourcePath: opts.path ?? null,
        sourceUrl: classified.videoUrl,
        decision,
        decisionReason: reason,
        decidedBy: ctx.actor,
        status,
      })
      .onConflictDoNothing({ target: [sourceJobs.campaignId, sourceJobs.sourceKey] })
      .returning();
    if (row) await recordCreated(tx, { entity: "source_job", id: row.id, status, actor: ctx.actor, reason });
    return row;
  });
  if (!job) {
    // A concurrent decision on the same video won; report it the same way as above.
    return decideFootage(ctx, campaignRef, url, decision, reason, opts);
  }
  return { created: true, sourceJob: jobSummary(job) };
}

function jobSummary(j: typeof sourceJobs.$inferSelect) {
  return {
    id: j.id,
    sourceKey: j.sourceKey,
    kind: j.sourceKind,
    name: j.sourceName,
    path: j.sourcePath,
    url: j.sourceUrl,
    decision: j.decision,
    reason: j.decisionReason,
    status: j.status,
  };
}

/**
 * Expands a footage URL (read-only). With a campaign, each video is annotated with
 * the decision already recorded for it, so the operator only decides on new ones.
 */
export async function listFootage(ctx: SourcingCtx, url: string, campaignRef?: string) {
  const listing = await listFootageUrl(url, ctx.list);
  if (!campaignRef) return listing;
  const c = await resolveCampaign(ctx.db, campaignRef);
  const keys = listing.entries.map((e) => e.sourceKey).filter((k): k is string => !!k);
  const decided = keys.length
    ? await ctx.db
        .select({ sourceKey: sourceJobs.sourceKey, decision: sourceJobs.decision, status: sourceJobs.status })
        .from(sourceJobs)
        .where(and(eq(sourceJobs.campaignId, c.id), inArray(sourceJobs.sourceKey, keys)))
    : [];
  const byKey = new Map(decided.map((d) => [d.sourceKey, d]));
  const entries = listing.entries.map((e) => {
    const d = e.sourceKey ? byKey.get(e.sourceKey) : undefined;
    return { ...e, decision: d?.decision ?? null, jobStatus: d?.status ?? null };
  });
  const undecidedVideos = entries.filter((e) => e.isVideo && e.sourceKey && !e.decision).length;
  return { ...listing, campaignId: c.id, undecidedVideos, entries };
}

/** Every recorded footage decision for a campaign (read-only). */
export async function listDecisions(db: Db, campaignRef: string, decision?: string) {
  const c = await resolveCampaign(db, campaignRef);
  if (decision && decision !== "selected" && decision !== "skipped") {
    throw new SourcingError("invalid_argument", "--decision must be selected or skipped");
  }
  const rows = await db
    .select()
    .from(sourceJobs)
    .where(
      and(eq(sourceJobs.campaignId, c.id), decision ? eq(sourceJobs.decision, decision as SourceDecision) : undefined),
    )
    .orderBy(asc(sourceJobs.createdAt));
  const sources = await db.select().from(footageSources).where(eq(footageSources.campaignId, c.id));
  return { campaignId: c.id, footageSources: sources, decisions: rows.map(jobSummary) };
}
