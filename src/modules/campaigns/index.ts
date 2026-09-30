import { createHash } from "node:crypto";
import { count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
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
  type ConfigVerificationRound,
} from "../../db/schema.js";
import { OPERATOR_ACTOR, recordCreated, STANDING_RULES, transition } from "../../db/transition.js";
import {
  fetchCampaign,
  fetchDiscoverListing,
  parseCampaignIdFromUrlSafe,
  type ConnectorDeps,
  type ListedCampaign,
} from "../campaign-connector/index.js";
import { briefDocId, parseNotionPageUrl, readBriefDoc, type ReaderDeps } from "../brief-reader/index.js";
import { CONFIG_FIELDS, validateCampaignConfig, type CampaignConfig } from "../campaign-config/index.js";

export class CampaignsError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid_argument" | "invalid_state",
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


/**
 * The campaign's brief as text + links, alongside the campaign page's reference
 * materials. `docUrl` reads a sub-doc the brief links to instead of the main one.
 */
export async function readCampaignBrief(ctx: Ctx & { reader?: ReaderDeps }, ref: string, docUrl?: string) {
  const source = await briefSource(ctx, ref);
  const { campaign, referenceMaterials } = source;

  // A Google Doc brief wins; failing that, a Notion rules page among the reference materials.
  const target =
    docUrl ?? source.guidelineDocUrl ?? referenceMaterials.find((m) => parseNotionPageUrl(m.url))?.url ?? null;
  if (!target) {
    return {
      campaign,
      doc: null,
      note: "No Google Doc or Notion brief among this campaign's reference materials. Read what's listed below, or flag the campaign.",
      referenceMaterials,
      linkedDocs: [],
    };
  }
  const doc = await readBriefDoc(target, ctx.reader);
  const linkedDocs = doc.links.filter((l) => {
    const id = briefDocId(l.url);
    return id !== null && id !== doc.docId;
  });
  return { campaign, doc, referenceMaterials, linkedDocs };
}

/**
 * A tracked campaign's stored snapshot, or, for scouting, a live read-only lookup
 * of an untracked Content Rewards campaign (nothing is written).
 */
async function briefSource(ctx: Ctx, ref: string) {
  try {
    const c = await resolveCampaign(ctx.db, ref);
    const snapshot = (c.crSnapshot ?? {}) as { referenceMaterials?: { type: string | null; url: string }[] };
    return {
      campaign: { id: c.id, tracked: true, title: c.title, status: c.status, campaignType: c.campaignType },
      guidelineDocUrl: c.guidelineDocUrl,
      referenceMaterials: snapshot.referenceMaterials ?? [],
    };
  } catch (err) {
    if (!(err instanceof CampaignsError && err.code === "not_found")) throw err;
    const url = UUID.test(ref.trim()) ? `https://contentrewards.com/discover/${ref.trim()}` : ref;
    const m = await fetchCampaign(url, ctx.connector);
    return {
      campaign: { id: null, tracked: false, contentRewardsCampaignId: m.campaignId, title: m.title, contentRewardsStatus: m.sourceStatus },
      guidelineDocUrl: m.guidelineDocUrl,
      referenceMaterials: m.referenceMaterials,
    };
  }
}

/** States a draft config can be (re)proposed from. An active campaign has to be paused or flagged first. */
const PROPOSABLE_FROM = ["discovered", "requirements_drafted", "pending_confirmation", "needs_attention"] as const;

/**
 * Validates Claude's draft config and parks it (status → pending_confirmation)
 * until it's verified (`verifyConfig` → `activateVerifiedCampaign`) or a
 * reviewer confirms it in the web app. Proposing never activates anything.
 * A correction during verification (from pending_confirmation) keeps the
 * verification rounds so far; a fresh draft from any other status starts over.
 */
export async function proposeConfig(ctx: Ctx, ref: string, input: unknown, opts: { dryRun?: boolean } = {}) {
  const config = validateCampaignConfig(input);
  const c = await resolveCampaign(ctx.db, ref);
  if (c.campaignType !== "lf") {
    throw new CampaignsError(
      "invalid_state",
      `Only long-form (lf) campaigns can be onboarded; this one is ${c.campaignType ?? "unclassified"}. Run \`campaign classify\` first.`,
    );
  }
  if (!(PROPOSABLE_FROM as readonly string[]).includes(c.status)) {
    throw new CampaignsError(
      "invalid_state",
      `Can't propose a config while the campaign is ${c.status}; allowed from ${PROPOSABLE_FROM.join(", ")}.`,
    );
  }
  const lowConfidence = Object.entries(config.extraction.fieldConfidence)
    .filter(([, v]) => v === "low")
    .map(([k]) => k);
  const summary = {
    lowConfidence,
    unresolved: config.extraction.unresolvedFields,
    unexpressedRules: config.extraction.unexpressedRules,
  };
  if (opts.dryRun) return { id: c.id, valid: true, dryRun: true, config, ...summary };

  await ctx.db.transaction(async (tx) => {
    await transition(tx, {
      entity: "campaign",
      id: c.id,
      to: "pending_confirmation",
      actor: ctx.actor,
      reason: c.status === "pending_confirmation" ? "config corrected; awaiting verification" : "config proposed; awaiting verification",
      expectFrom: PROPOSABLE_FROM,
      // A new draft voids any earlier confirmation.
      set: {
        config,
        configConfirmedAt: null,
        configConfirmedBy: null,
        ...(c.status === "pending_confirmation" ? {} : { configVerification: null }),
      },
    });
    await audit(tx, {
      entityType: "campaign",
      entityId: c.id,
      action: "propose_config",
      actor: ctx.actor,
      details: { config, previous: c.config },
    });
  });
  return { id: c.id, status: "pending_confirmation" as const, ...summary };
}

// --- self-verified activation (standing rule, 2026-09-27) ------------------------------

/** Correct-and-recheck rounds before a config that still doesn't match goes to a person. */
export const MAX_CONFIG_ROUNDS = 3;

/** Marks a config the operator activated itself, in `config_confirmed_by`. */
export const SELF_VERIFIED_BY = `${OPERATOR_ACTOR} (self-verified)`;

/** Stable hash of a config: jsonb reorders keys, so hash a key-sorted rendering. */
export function configHash(config: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
        : v;
  return createHash("sha256").update(JSON.stringify(stable(config))).digest("hex");
}

const fieldResult = z.strictObject({ result: z.enum(["match", "mismatch", "unsettled"]), evidence: z.string().trim().min(1) });
const verificationSchema = z.strictObject({
  /** Where the operator re-read the rules: the campaign page and every brief doc. */
  sources: z.array(z.string().trim().min(1)).min(1),
  summary: z.string().trim().min(1),
  fields: z.record(z.string(), fieldResult),
  /** Rules on the page or in the brief that the config doesn't capture anywhere. */
  missedRules: z.array(z.string().trim().min(1)).default([]),
});

/**
 * Records one round of the operator comparing its drafted config with the
 * campaign page and brief: every config field gets match / mismatch / unsettled
 * with evidence, plus any rule the config misses. Outcome:
 * - every field matches and nothing is missed → verified (then `campaign activate`);
 * - something doesn't match → needs_changes: correct it with `propose-config` and
 *   verify again, up to MAX_CONFIG_ROUNDS; after that the campaign is flagged;
 * - a field can't be settled from the page or brief → the campaign is flagged now.
 * A flag lands in the attention digest, so a person hears about it on Discord.
 */
export async function verifyConfig(ctx: Ctx, ref: string, input: unknown) {
  const parsed = verificationSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new CampaignsError("invalid_argument", `Verification: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  const v = parsed.data;
  const c = await resolveCampaign(ctx.db, ref);
  if (c.status !== "pending_confirmation") {
    throw new CampaignsError("invalid_state", `Campaign is ${c.status}; only a proposed config (pending_confirmation) is verified`);
  }
  const config = validateCampaignConfig(c.config);
  const given = Object.keys(v.fields);
  const missing = CONFIG_FIELDS.filter((f) => !given.includes(f));
  const unknown = given.filter((f) => !(CONFIG_FIELDS as readonly string[]).includes(f));
  if (missing.length || unknown.length) {
    throw new CampaignsError(
      "invalid_argument",
      [missing.length ? `missing fields: ${missing.join(", ")}` : "", unknown.length ? `unknown fields: ${unknown.join(", ")}` : ""].filter(Boolean).join("; "),
    );
  }
  const rounds = c.configVerification?.rounds ?? [];
  if (rounds.length >= MAX_CONFIG_ROUNDS) {
    throw new CampaignsError("invalid_state", `Already ${rounds.length} verification rounds; the campaign needs a person`);
  }
  const unsettled = Object.entries(v.fields).filter(([, f]) => f.result === "unsettled");
  const mismatched = Object.entries(v.fields).filter(([, f]) => f.result === "mismatch");
  const outcome: ConfigVerificationRound["outcome"] = unsettled.length
    ? "unsettled"
    : mismatched.length || v.missedRules.length
      ? "needs_changes"
      : "verified";
  const round: ConfigVerificationRound = {
    round: rounds.length + 1,
    at: new Date().toISOString(),
    actor: ctx.actor,
    configHash: configHash(config),
    outcome,
    summary: v.summary,
    sources: v.sources,
    fields: v.fields,
    missedRules: v.missedRules,
  };
  const describeList = (list: [string, { evidence: string }][]) => list.map(([f, r]) => `${f} (${r.evidence})`).join("; ");
  let flagReason: string | null = null;
  if (outcome === "unsettled") flagReason = `Can't settle from the campaign page or brief: ${describeList(unsettled)}`;
  else if (outcome === "needs_changes" && round.round >= MAX_CONFIG_ROUNDS) {
    flagReason = `Config still doesn't match the brief after ${round.round} rounds: ${[describeList(mismatched), ...v.missedRules.map((r) => `missed rule: ${r}`)].filter(Boolean).join("; ")}`;
  }

  await ctx.db.transaction(async (tx) => {
    await tx.update(campaigns).set({ configVerification: { rounds: [...rounds, round] } }).where(eq(campaigns.id, c.id));
    await audit(tx, { entityType: "campaign", entityId: c.id, action: "verify_config", actor: ctx.actor, details: round });
    if (flagReason) {
      await transition(tx, { entity: "campaign", id: c.id, to: "needs_attention", actor: ctx.actor, reason: flagReason, expectFrom: ["pending_confirmation"] });
    }
  });
  return {
    id: c.id,
    round: round.round,
    outcome,
    status: flagReason ? ("needs_attention" as const) : c.status,
    flagged: flagReason,
    mismatched: mismatched.map(([f]) => f),
    unsettled: unsettled.map(([f]) => f),
    missedRules: v.missedRules,
    roundsLeft: MAX_CONFIG_ROUNDS - round.round,
  };
}

/**
 * Standing rule (2026-09-27): the operator activates a campaign whose current
 * config its own latest verification round found fully matching the campaign
 * page and brief. Only long-form campaigns, only from pending_confirmation, and
 * only for the exact config verified (an edit since needs a new round). The
 * person still joins the campaign on Content Rewards; the attention digest tells them to.
 */
export async function activateVerifiedCampaign(ctx: Ctx, ref: string) {
  const c = await resolveCampaign(ctx.db, ref);
  if (c.status !== "pending_confirmation") throw new CampaignsError("invalid_state", `Campaign is ${c.status}; only pending_confirmation campaigns are activated`);
  if (c.campaignType !== "lf") throw new CampaignsError("invalid_state", `Campaign type is ${c.campaignType ?? "unclassified"}; only long-form (lf) campaigns are clipped`);
  const config: CampaignConfig = validateCampaignConfig(c.config);
  if (config.extraction.unresolvedFields.length) {
    throw new CampaignsError("invalid_state", `Unresolved fields: ${config.extraction.unresolvedFields.join(", ")}; settle them or flag the campaign`);
  }
  const last = c.configVerification?.rounds.at(-1);
  if (!last || last.outcome !== "verified") {
    throw new CampaignsError("invalid_state", `The config isn't verified${last ? ` (last round: ${last.outcome})` : ""}; run \`campaign verify-config\` first`);
  }
  if (last.configHash !== configHash(config)) {
    throw new CampaignsError("invalid_state", "The config changed after it was verified; verify it again");
  }
  const at = new Date();
  await ctx.db.transaction(async (tx) => {
    await transition(tx, {
      entity: "campaign",
      id: c.id,
      to: "active",
      actor: ctx.actor,
      reason: `${STANDING_RULES.activate_verified_config} (round ${last.round})`,
      standingRule: "activate_verified_config",
      expectFrom: ["pending_confirmation"],
      set: { configConfirmedAt: at, configConfirmedBy: SELF_VERIFIED_BY },
    });
    await audit(tx, { entityType: "campaign", entityId: c.id, action: "activate_verified", actor: ctx.actor, details: { round: last.round, configHash: last.configHash } });
  });
  return { id: c.id, status: "active" as const, round: last.round, joinUrl: c.contentRewardsUrl };
}
