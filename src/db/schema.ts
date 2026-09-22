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

// Status vocabularies. The DB enforces these with CHECK constraints so a typo
// in application code fails loudly instead of creating an unreachable state.

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

export const SOURCE_JOB_STATUSES = [
  "detected",
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
    driveFolderUrl: text("drive_folder_url"),
    driveFolderId: text("drive_folder_id"),
    status: text("status").$type<CampaignStatus>().notNull(),
    statusReason: text("status_reason"),
    config: jsonb("config").$type<Partial<CampaignConfig>>().notNull().default({}),
    configConfirmedAt: timestamp("config_confirmed_at", { withTimezone: true }),
    configConfirmedBy: text("config_confirmed_by"),
  },
  (t) => [
    check("campaigns_status_check", inList("status", CAMPAIGN_STATUSES)),
    index("campaigns_status_idx").on(t.status),
  ],
);

export const sourceJobs = pgTable(
  "source_jobs",
  {
    ...baseColumns(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id),
    driveFileId: text("drive_file_id").notNull(),
    driveFileName: text("drive_file_name"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    md5Checksum: text("md5_checksum"),
    sourceUrl: text("source_url").notNull(),
    status: text("status").$type<SourceJobStatus>().notNull(),
    statusReason: text("status_reason"),
    opusclipProjectId: text("opusclip_project_id"),
    retryCount: integer("retry_count").notNull().default(0),
  },
  (t) => [
    // Duplicate prevention: one job per Drive file per campaign.
    uniqueIndex("source_jobs_campaign_drive_file_uidx").on(t.campaignId, t.driveFileId),
    index("source_jobs_status_idx").on(t.status),
    check("source_jobs_status_check", inList("status", SOURCE_JOB_STATUSES)),
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
    durationMs: integer("duration_ms"),
    previewUrl: text("preview_url"),
    exportUrl: text("export_url"),
    hashtags: text("hashtags"),
    status: text("status").$type<CandidateClipStatus>().notNull(),
    checkResults: jsonb("check_results").$type<Record<string, CheckOutcome>>(),
  },
  (t) => [
    index("candidate_clips_status_idx").on(t.status),
    check("candidate_clips_status_check", inList("status", CANDIDATE_CLIP_STATUSES)),
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
