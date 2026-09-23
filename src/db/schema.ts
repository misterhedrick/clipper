import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Vocabularies. The DB enforces these with CHECK constraints so a typo in
// application code fails loudly instead of creating an unreachable state.

export const CAMPAIGN_STATUSES = [
  "discovered",
  "ingesting",
  "requirements_drafted",
  "pending_confirmation",
  "active",
  "paused",
  "archived",
  "needs_attention",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_TYPES = ["lf", "ugc", "music", "slideshow", "unclear"] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

export const SOURCE_JOB_STATUSES = [
  "detected",
  "skipped", // a deliberate operator decision not to process this video; terminal
  "validating",
  "validation_failed",
  "queued",
  "submitting",
  "submit_failed",
  "project_created",
  "processing",
  "candidates_ready",
  "needs_attention",
  "completed",
] as const;
export type SourceJobStatus = (typeof SOURCE_JOB_STATUSES)[number];

export const SOURCE_DECISIONS = ["selected", "skipped"] as const;
export type SourceDecision = (typeof SOURCE_DECISIONS)[number];

export const FOOTAGE_KINDS = [
  "gdrive_folder",
  "gdrive_file",
  "youtube_channel",
  "youtube_video",
  "s3_mp4",
  "dropbox",
  "frameio",
  "loom",
  "vimeo",
  "twitch",
  "opus_upload",
] as const;
export type FootageKind = (typeof FOOTAGE_KINDS)[number];

export const CANDIDATE_CLIP_STATUSES = [
  "generated",
  "checking",
  "awaiting_review",
  "needs_edit",
  "approved",
  "exporting",
  "ready_to_post",
  "posted",
  "rejected",
  "archived",
] as const;
export type CandidateClipStatus = (typeof CANDIDATE_CLIP_STATUSES)[number];

export const PRESCREEN_VERDICTS = ["recommend", "hold", "reject"] as const;
export type PrescreenVerdict = (typeof PRESCREEN_VERDICTS)[number];

export const CREDIT_RESERVATION_STATUSES = ["open", "consumed", "released"] as const;
export type CreditReservationStatus = (typeof CREDIT_RESERVATION_STATUSES)[number];

export const ENTITY_TYPES = ["campaign", "source_job", "candidate_clip"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const POST_PLATFORMS = ["tiktok", "instagram", "youtube"] as const;
export type PostPlatform = (typeof POST_PLATFORMS)[number];

export const CHECK_OUTCOMES = ["pass", "fail", "manual_review_required"] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

export type CampaignConfig = {
  clipGeneration: {
    brandTemplateId?: string;
    aspectRatio: "portrait" | "landscape" | "square";
    minDurationSeconds: number;
    maxDurationSeconds: number;
    originalAudioOnly: boolean;
    captionsEnabled: boolean;
  };
  requirements: {
    requiredOverlayAssetIds: string[];
    requiredOnScreenText: string[];
    requiredCaptionLines: string[];
    requiredTags: string[];
    disclosureLines: string[];
    maxAdditionalHashtags: number;
  };
  review: {
    requiredChecks: string[];
    autoApprove: false; // must never be true in v1
  };
  extraction: {
    fieldConfidence: Record<string, "high" | "low">;
    unresolvedFields: string[];
  };
};

export type ClipEdit = { ops: unknown[]; reason: string; at: string };

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(", ")})`);

const baseColumns = () => ({
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const campaigns = pgTable(
  "campaigns",
  {
    ...baseColumns(),
    contentRewardsCampaignId: text("content_rewards_campaign_id").notNull().unique(),
    contentRewardsUrl: text("content_rewards_url").notNull(),
    title: text("title"),
    brand: text("brand"),
    platforms: text("platforms").array(),
    guidelineDocUrl: text("guideline_doc_url"),
    campaignType: text("campaign_type").$type<CampaignType>(),
    campaignTypeReason: text("campaign_type_reason"),
    maxDailyCredits: integer("max_daily_credits"),
    status: text("status").$type<CampaignStatus>().notNull(),
    statusReason: text("status_reason"),
    config: jsonb("config").$type<Partial<CampaignConfig>>().notNull().default({}),
    configConfirmedAt: timestamp("config_confirmed_at", { withTimezone: true }),
    configConfirmedBy: text("config_confirmed_by"),
  },
  (t) => [
    check("campaigns_status_check", inList("status", CAMPAIGN_STATUSES)),
    check("campaigns_campaign_type_check", sql`campaign_type is null or ${inList("campaign_type", CAMPAIGN_TYPES)}`),
    check("campaigns_max_daily_credits_check", sql`max_daily_credits is null or max_daily_credits > 0`),
    index("campaigns_status_idx").on(t.status),
  ],
);

/** One registered footage location (folder, channel or single file) for a campaign. */
export const footageSources = pgTable(
  "footage_sources",
  {
    ...baseColumns(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    kind: text("kind").$type<FootageKind>().notNull(),
    url: text("url").notNull(),
    label: text("label"),
    addedBy: text("added_by").notNull(),
    reason: text("reason").notNull(),
    lastListedAt: timestamp("last_listed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("footage_sources_campaign_url_uidx").on(t.campaignId, t.url),
    check("footage_sources_kind_check", inList("kind", FOOTAGE_KINDS)),
  ],
);

/** One video the operator decided about (selected or skipped) for a campaign. */
export const sourceJobs = pgTable(
  "source_jobs",
  {
    ...baseColumns(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    footageSourceId: uuid("footage_source_id").references(() => footageSources.id),
    sourceKey: text("source_key").notNull(),
    sourceKind: text("source_kind").$type<FootageKind>().notNull(),
    sourceName: text("source_name"),
    sourcePath: text("source_path"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    md5Checksum: text("md5_checksum"),
    sourceUrl: text("source_url").notNull(),
    decision: text("decision").$type<SourceDecision>().notNull(),
    decisionReason: text("decision_reason").notNull(),
    decidedBy: text("decided_by").notNull(),
    status: text("status").$type<SourceJobStatus>().notNull(),
    statusReason: text("status_reason"),
    submitParams: jsonb("submit_params").$type<Record<string, unknown>>(),
    opusclipProjectId: text("opusclip_project_id"),
    opusclipStage: text("opusclip_stage"),
    retryCount: integer("retry_count").notNull().default(0),
  },
  (t) => [
    // Duplicate prevention: one decision (and at most one job) per video per campaign.
    uniqueIndex("source_jobs_campaign_source_key_uidx").on(t.campaignId, t.sourceKey),
    index("source_jobs_status_idx").on(t.status),
    check("source_jobs_status_check", inList("status", SOURCE_JOB_STATUSES)),
    check("source_jobs_kind_check", inList("source_kind", FOOTAGE_KINDS)),
    check("source_jobs_decision_check", inList("decision", SOURCE_DECISIONS)),
    // A skipped video is parked in the terminal `skipped` status and nowhere else.
    check("source_jobs_skip_status_check", sql`(decision = 'skipped') = (status = 'skipped')`),
    check(
      "source_jobs_failure_reason_check",
      sql`status not in ('validation_failed', 'submit_failed', 'needs_attention') or status_reason is not null`,
    ),
  ],
);

export const candidateClips = pgTable(
  "candidate_clips",
  {
    ...baseColumns(),
    sourceJobId: uuid("source_job_id")
      .notNull()
      .references(() => sourceJobs.id),
    opusclipClipId: text("opusclip_clip_id").notNull().unique(),
    title: text("title"),
    description: text("description"),
    durationMs: integer("duration_ms"),
    previewUrl: text("preview_url"),
    thumbnailUrl: text("thumbnail_url"),
    exportUrl: text("export_url"),
    hashtags: text("hashtags"),
    opusclipScore: numeric("opusclip_score"),
    opusclipSubScores: jsonb("opusclip_sub_scores").$type<Record<string, number>>(),
    status: text("status").$type<CandidateClipStatus>().notNull(),
    checkResults: jsonb("check_results").$type<Record<string, CheckOutcome>>(),
    prescreenVerdict: text("prescreen_verdict").$type<PrescreenVerdict>(),
    prescreenNotes: text("prescreen_notes"),
    prescreenedAt: timestamp("prescreened_at", { withTimezone: true }),
    caption: text("caption"),
    reviewNotes: text("review_notes"),
    editLog: jsonb("edit_log").$type<ClipEdit[]>().notNull().default([]),
  },
  (t) => [
    index("candidate_clips_status_idx").on(t.status),
    check("candidate_clips_status_check", inList("status", CANDIDATE_CLIP_STATUSES)),
    check(
      "candidate_clips_prescreen_verdict_check",
      sql`prescreen_verdict is null or ${inList("prescreen_verdict", PRESCREEN_VERDICTS)}`,
    ),
  ],
);

// Append-only audit log. Every status change writes a row here in the same transaction.
export const statusEvents = pgTable(
  "status_events",
  {
    ...baseColumns(),
    entityType: text("entity_type").$type<EntityType>().notNull(),
    entityId: uuid("entity_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actor: text("actor").notNull(),
    reason: text("reason"),
    errorDetails: jsonb("error_details"),
  },
  (t) => [
    index("status_events_entity_idx").on(t.entityType, t.entityId),
    check("status_events_entity_type_check", inList("entity_type", ENTITY_TYPES)),
  ],
);

/** One OpusClip credit reservation made by `clipper source reserve`. */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    ...baseColumns(),
    sourceJobId: uuid("source_job_id")
      .notNull()
      .references(() => sourceJobs.id),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    creditsReserved: integer("credits_reserved").notNull(),
    status: text("status").$type<CreditReservationStatus>().notNull().default("open"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    // At most one open reservation per job.
    uniqueIndex("credit_ledger_one_open_per_job_uidx").on(t.sourceJobId).where(sql`status = 'open'`),
    index("credit_ledger_reserved_at_idx").on(t.reservedAt),
    check("credit_ledger_status_check", inList("status", CREDIT_RESERVATION_STATUSES)),
    check("credit_ledger_credits_check", sql`credits_reserved > 0`),
    check("credit_ledger_closed_check", sql`(status = 'open') = (closed_at is null)`),
  ],
);

/** OpusClip's own monthly usage, as reported by `opusclip_get_usage` and recorded by `clipper credits reconcile`. */
export const opusUsageSnapshots = pgTable("opus_usage_snapshots", {
  ...baseColumns(),
  used: integer("used").notNull(),
  monthlyLimit: integer("monthly_limit").notNull(),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
  recordedBy: text("recorded_by").notNull(),
});

export const posts = pgTable(
  "posts",
  {
    ...baseColumns(),
    candidateClipId: uuid("candidate_clip_id")
      .notNull()
      .references(() => candidateClips.id),
    platform: text("platform").$type<PostPlatform>().notNull(),
    url: text("url"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    views: integer("views"),
    likes: integer("likes"),
    engagementRate: numeric("engagement_rate"),
    earnings: numeric("earnings"),
    notes: text("notes"),
  },
  (t) => [check("posts_platform_check", inList("platform", POST_PLATFORMS))],
);
