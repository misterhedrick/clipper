CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_rewards_campaign_id" text NOT NULL,
	"content_rewards_url" text NOT NULL,
	"title" text,
	"brand" text,
	"platforms" text[],
	"guideline_doc_url" text,
	"drive_folder_url" text,
	"drive_folder_id" text,
	"status" text NOT NULL,
	"status_reason" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config_confirmed_at" timestamp with time zone,
	"config_confirmed_by" text,
	CONSTRAINT "campaigns_content_rewards_campaign_id_unique" UNIQUE("content_rewards_campaign_id"),
	CONSTRAINT "campaigns_status_check" CHECK (status in ('discovered', 'ingesting', 'requirements_drafted', 'pending_confirmation', 'active', 'paused', 'archived', 'needs_attention'))
);
--> statement-breakpoint
CREATE TABLE "candidate_clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_job_id" uuid NOT NULL,
	"opusclip_clip_id" text NOT NULL,
	"title" text,
	"duration_ms" integer,
	"preview_url" text,
	"export_url" text,
	"hashtags" text,
	"status" text NOT NULL,
	"check_results" jsonb,
	CONSTRAINT "candidate_clips_opusclip_clip_id_unique" UNIQUE("opusclip_clip_id"),
	CONSTRAINT "candidate_clips_status_check" CHECK (status in ('generated', 'checking', 'awaiting_review', 'needs_edit', 'approved', 'exporting', 'ready_to_post', 'posted', 'rejected', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"candidate_clip_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"url" text,
	"posted_at" timestamp with time zone,
	"views" integer,
	"likes" integer,
	"engagement_rate" numeric,
	"earnings" numeric,
	"notes" text,
	CONSTRAINT "posts_platform_check" CHECK (platform in ('tiktok', 'instagram', 'youtube'))
);
--> statement-breakpoint
CREATE TABLE "source_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"drive_file_id" text NOT NULL,
	"drive_file_name" text,
	"size_bytes" bigint,
	"md5_checksum" text,
	"source_url" text NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"opusclip_project_id" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "source_jobs_status_check" CHECK (status in ('detected', 'validating', 'validation_failed', 'queued', 'submitting', 'submit_failed', 'project_created', 'processing', 'candidates_ready', 'needs_attention', 'completed')),
	CONSTRAINT "source_jobs_failure_reason_check" CHECK (status not in ('validation_failed', 'submit_failed', 'needs_attention') or status_reason is not null)
);
--> statement-breakpoint
CREATE TABLE "status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"error_details" jsonb,
	CONSTRAINT "status_events_entity_type_check" CHECK (entity_type in ('campaign', 'source_job', 'candidate_clip'))
);
--> statement-breakpoint
ALTER TABLE "candidate_clips" ADD CONSTRAINT "candidate_clips_source_job_id_source_jobs_id_fk" FOREIGN KEY ("source_job_id") REFERENCES "public"."source_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_candidate_clip_id_candidate_clips_id_fk" FOREIGN KEY ("candidate_clip_id") REFERENCES "public"."candidate_clips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_jobs" ADD CONSTRAINT "source_jobs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "candidate_clips_status_idx" ON "candidate_clips" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "source_jobs_campaign_drive_file_uidx" ON "source_jobs" USING btree ("campaign_id","drive_file_id");--> statement-breakpoint
CREATE INDEX "source_jobs_status_idx" ON "source_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "status_events_entity_idx" ON "status_events" USING btree ("entity_type","entity_id");